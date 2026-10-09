import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeInsights } from './lib/analytics.mjs';
import { authConfigFromEnvironment, createAuthorization } from './lib/auth.mjs';
import { projectCatalog, WindowContextStore } from './lib/context.mjs';
import { demoTelemetry } from './lib/demo.mjs';
import { AppError } from './lib/errors.mjs';
import { logAnalyticsSource } from './lib/loganalytics.mjs';
import { handleMcp } from './lib/mcp.mjs';
import { REVIEW_STATUSES, ReviewStore } from './lib/reviews.mjs';
import { readTelemetry } from './lib/telemetry.mjs';

const publicRoot = new URL('./public/', import.meta.url);
const defaultTelemetry = fileURLToPath(new URL('../../deploy/local/.data/vscode-telemetry.jsonl', import.meta.url));
const defaultReviews = fileURLToPath(new URL('../../deploy/local/.data/reviews.json', import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/auth.js', ['auth.js', 'text/javascript; charset=utf-8']],
  ['/auth/redirect.html', ['auth-redirect.html', 'text/html; charset=utf-8']],
  ['/auth-redirect.js', ['auth-redirect.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(response, status, data, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

function validateScope(organizations, organizationId, source, days) {
  const organization = organizationId !== undefined
    ? organizations.find((entry) => entry.id === organizationId)
    : source !== undefined ? organizations.find((entry) => entry.source === source) : organizations[0];
  if (!organization || (source !== undefined && organization.source !== source) || ![7, 14, 30].includes(days)) {
    throw new AppError('invalid-scope', 'Choose a configured organization and a 7, 14, or 30 day window. Organization and legacy source selectors must agree.', 400);
  }
  return organization;
}

async function readBody(request, limit = 4096) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new AppError('invalid-content-type', 'Requests must use JSON.', 415);
  }
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new AppError('body-too-large', 'The request is too large.', 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new AppError('body-too-large', 'The request is too large.', 413);
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('invalid-json', 'The request is not valid JSON.', 400); }
}

function validateQuery(url, keys) {
  if ([...url.searchParams.keys()].some((key) => !keys.includes(key)) || keys.some((key) => url.searchParams.getAll(key).length > 1)) {
    throw new AppError('invalid-query', 'Only documented filters are accepted, without duplicates.', 400);
  }
}

export async function createApp({ telemetryPath = defaultTelemetry, reviewPath = defaultReviews, contextPath = join(dirname(reviewPath), 'windows.json'),
  organizationId = 'local-vscode', organizationName = 'My VS Code organization', clock = Date.now,
  authConfig = { mode: 'local' }, keyResolver, readCollected = (id) => readTelemetry(telemetryPath, id) } = {}) {
  if (typeof organizationId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(organizationId) || organizationId === 'synthetic-demo'
    || typeof organizationName !== 'string' || !organizationName.trim() || organizationName.length > 64) {
    throw new AppError('invalid-organization', 'Configure a non-demo organization ID and a display name of at most 64 characters.');
  }
  const authorization = createAuthorization(authConfig, { keyResolver, clock });
  const organizations = [
    ...(authorization.mode === 'production' ? [] : [{ id: 'synthetic-demo', name: 'Demo organization', source: 'demo' }]),
    { id: organizationId, name: organizationName, source: 'local' },
  ];
  const store = new ReviewStore(reviewPath);
  await store.load();
  const contexts = new WindowContextStore(contextPath, clock);
  await contexts.load();
  const reviewToken = randomBytes(32).toString('hex');
  const readInput = async (organization, now) => organization.source === 'demo' ? demoTelemetry(now)
    : contexts.attribute(await readCollected(organization.id));
  const catalog = (organization, input) => projectCatalog(input, organization.source === 'demo' ? [] : contexts.projects(organization.id));
  const projects = async (id) => {
    const organization = validateScope(organizations, id, undefined, 7);
    return { organizationId: organization.id, projects: catalog(organization, await readInput(organization, clock())) };
  };
  const reviewOf = (finding, organization, projectKey) => {
    const { evidence, ...review } = store.get(finding.id, organization.id, projectKey);
    return { ...review, newEvidence: evidence !== null && (finding.evidenceCount > evidence.count || finding.latestEvidenceAt > evidence.latestAt) };
  };
  const snapshot = async (organization, days, projectKey = 'all') => {
    const now = clock();
    const input = await readInput(organization, now);
    const project = catalog(organization, input).find((entry) => entry.id === projectKey);
    if (!project) throw new AppError('invalid-project-scope', 'Choose a project within the selected organization. No substitute data is shown.', 400);
    const data = { ...composeInsights(input, { source: organization.source, days, now, projectKey }), organization, project };
    for (const finding of data.findings) finding.review = reviewOf(finding, organization, projectKey);
    return data;
  };
  const mcpServices = { organizations, projects, snapshot: (id, days, projectKey) => snapshot(validateScope(organizations, id, undefined, days), days, projectKey) };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    if (authorization.mode === 'production') {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
      response.setHeader('Content-Security-Policy', securityHeaders['Content-Security-Policy'].replace("connect-src 'self'", "connect-src 'self' https://login.microsoftonline.com") + "; frame-src 'self' https://login.microsoftonline.com");
    }
    if (request.url?.split('?')[0] === '/auth/redirect.html') {
      response.removeHeader('Cross-Origin-Opener-Policy');
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
      response.setHeader('Content-Security-Policy', response.getHeader('Content-Security-Policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    }
    let permission = 'admin';
    try {
      const host = request.headers.host ?? '';
      const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host);
      const healthProbe = request.method === 'GET' && request.url === '/api/health' && loopback;
      if (authorization.mode === 'local' ? !loopback : !healthProbe && host !== new URL(authorization.publicOrigin).host) {
        throw new AppError('host-required', 'This listener does not accept the requested host.', 403);
      }
      const origin = authorization.publicOrigin ?? `http://${host}`;
      const url = new URL(request.url, origin);
      if (url.origin !== origin || (request.headers['sec-fetch-site'] === 'cross-site' && (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || request.method !== 'GET'))
        || (request.headers.origin && request.headers.origin !== origin)) {
        throw new AppError('same-origin-required', 'Cross-origin access is not permitted.', 403);
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        send(response, 200, { status: 'ok', mode: authorization.mode });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth-config') {
        send(response, 200, authorization.publicConfig);
        return;
      }
      if (request.method === 'GET' && ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'].includes(url.pathname) && authorization.protectedResource) {
        send(response, 200, authorization.protectedResource);
        return;
      }
      if (url.pathname === '/api/context/windows' && request.method === 'POST') {
        permission = 'publisher';
        const principal = await authorization.authenticate(request, permission);
        validateQuery(url, []);
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['sessionId', 'project', 'clientTime'].includes(key))) {
          throw new AppError('invalid-context', 'Supply a native window session ID, its selected project, and the device time only.', 400);
        }
        const binding = await contexts.register(organizationId, body.sessionId, body.project, body.clientTime, principal.ownerId);
        send(response, binding.status === 'reload-required' ? 409 : 200, binding);
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
        permission = url.pathname === '/api/reviews' && request.method === 'POST' ? 'review' : 'admin';
        await authorization.authenticate(request, permission);
      }
      if (request.method === 'GET' && url.pathname === '/api/organizations') {
        if (url.search) throw new AppError('invalid-query', 'The organization catalog does not accept filters.', 400);
        send(response, 200, { defaultOrganizationId: organizations[0].id, organizations });
      } else if (request.method === 'GET' && url.pathname === '/api/projects') {
        validateQuery(url, ['organization']);
        send(response, 200, await projects(url.searchParams.get('organization') ?? undefined));
      } else if (request.method === 'GET' && url.pathname === '/api/insights') {
        validateQuery(url, ['organization', 'source', 'days', 'project']);
        const source = url.searchParams.get('source') ?? undefined;
        const days = Number(url.searchParams.get('days') ?? 7);
        const organization = validateScope(organizations, url.searchParams.get('organization') ?? undefined, source, days);
        send(response, 200, { ...await snapshot(organization, days, url.searchParams.get('project') ?? 'all'), reviewToken });
      } else if (request.method === 'POST' && url.pathname === '/api/reviews') {
        if (request.headers.origin !== origin || request.headers['x-review-token'] !== reviewToken) {
          request.resume();
          throw new AppError('review-token-required', 'Open this site and refresh before saving a decision.', 403);
        }
        const body = await readBody(request);
        const allowedKeys = ['organizationId', 'projectKey', 'source', 'days', 'findingId', 'status', 'expectedRevision'];
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowedKeys.includes(key))
          || typeof body.findingId !== 'string' || !/^[a-f0-9]{24}$/.test(body.findingId)
          || !REVIEW_STATUSES.includes(body.status) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
          throw new AppError('invalid-review', 'Only a finding identifier, scope, decision status, and revision are accepted. Free-text notes are not stored.', 400);
        }
        const organization = validateScope(organizations, body.organizationId, body.source, body.days);
        const projectKey = body.projectKey ?? 'all';
        const current = await snapshot(organization, body.days, projectKey);
        const finding = current.findings.find((entry) => entry.id === body.findingId);
        if (!finding) {
          throw new AppError('evidence-changed', 'This signal no longer applies to the selected window. Refresh and review the current signals.', 409);
        }
        await store.update(body.findingId, organization.source, body.status, body.expectedRevision, organization.id, projectKey,
          { count: finding.evidenceCount, latestAt: finding.latestEvidenceAt });
        send(response, 200, { review: reviewOf(finding, organization, projectKey) });
      } else if (url.pathname === '/mcp') {
        validateQuery(url, []);
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          send(response, 405, { error: { code: 'method-not-allowed', message: 'Use stateless Streamable HTTP POST requests.' } });
        } else await handleMcp(request, response, await readBody(request, 16 * 1024), mcpServices);
      } else if (request.method === 'GET' && url.pathname === '/vendor/msal-browser.min.js') {
        send(response, 200, await readFile(new URL('./node_modules/@azure/msal-browser/lib/msal-browser.min.js', import.meta.url)), 'text/javascript; charset=utf-8');
      } else if (request.method === 'GET' && url.pathname === '/vendor/msal-redirect-bridge.min.js') {
        send(response, 200, await readFile(new URL('./node_modules/@azure/msal-browser/lib/redirect-bridge/msal-redirect-bridge.min.js', import.meta.url)), 'text/javascript; charset=utf-8');
      } else if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [name, type] = staticFiles.get(url.pathname);
        send(response, 200, await readFile(new URL(name, publicRoot)), type);
      } else {
        send(response, 404, { error: { code: 'not-found', message: 'This route is not available.' } });
      }
    } catch (error) {
      const known = error instanceof AppError;
      request.resume();
      if (response.headersSent) { response.end(); return; }
      if (known && error.status === 401 && authorization.challenge) response.setHeader('WWW-Authenticate', authorization.challenge(permission));
      send(response, known ? error.status : 500, { error: {
        code: known ? error.code : 'unavailable',
        message: known ? error.message : 'The insights service could not complete this request.',
      } });
    }
  });
  server.maxConnections = 64;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspaceId = process.env.INSIGHTS_LOG_ANALYTICS_WORKSPACE_ID;
    const server = await createApp({
      readCollected: workspaceId ? logAnalyticsSource({ workspaceId, clientId: process.env.AZURE_CLIENT_ID }) : undefined,
      telemetryPath: process.env.INSIGHTS_TELEMETRY_PATH ?? defaultTelemetry,
      reviewPath: process.env.INSIGHTS_REVIEW_PATH ?? defaultReviews,
      contextPath: process.env.INSIGHTS_CONTEXT_PATH ?? join(dirname(process.env.INSIGHTS_REVIEW_PATH ?? defaultReviews), 'windows.json'),
      organizationId: process.env.INSIGHTS_ORGANIZATION_ID ?? 'local-vscode',
      organizationName: process.env.INSIGHTS_ORGANIZATION_NAME ?? 'My VS Code organization',
      authConfig: authConfigFromEnvironment(),
    });
    const port = Number(process.env.PORT ?? 3000);
    const host = process.env.HOST ?? '127.0.0.1';
    server.listen(port, host, () => console.log(`Copilot Insights review and MCP are ready on port ${port}. Mode: ${authConfigFromEnvironment().mode}.`));
    server.on('error', () => { console.error('The local insights listener could not start. Check the port and bind address.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { server.close(); server.closeIdleConnections(); });
    }
  } catch (error) {
    console.error(error instanceof AppError ? error.message : 'The local insights service could not start.');
    process.exitCode = 1;
  }
}
