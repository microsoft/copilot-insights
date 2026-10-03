import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeInsights } from './lib/analytics.mjs';
import { demoTelemetry } from './lib/demo.mjs';
import { AppError } from './lib/errors.mjs';
import { REVIEW_STATUSES, ReviewStore } from './lib/reviews.mjs';
import { readTelemetry } from './lib/telemetry.mjs';

const publicRoot = new URL('./public/', import.meta.url);
const defaultTelemetry = fileURLToPath(new URL('../../deploy/local/.data/telemetry.jsonl', import.meta.url));
const defaultReviews = fileURLToPath(new URL('../../deploy/local/.data/reviews.json', import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
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
  response.writeHead(status, { ...securityHeaders, 'Content-Type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

function validateScope(source, days) {
  if (!['local', 'demo'].includes(source) || ![7, 14, 30].includes(days)) {
    throw new AppError('invalid-scope', 'Choose the local collector or synthetic demo, and a 7, 14, or 30 day window.', 400);
  }
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new AppError('invalid-content-type', 'Review decisions must use JSON.', 415);
  }
  if (Number(request.headers['content-length']) > 4096) {
    request.resume();
    throw new AppError('body-too-large', 'The review request is too large.', 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 4096) {
      request.resume();
      throw new AppError('body-too-large', 'The review request is too large.', 413);
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('invalid-json', 'The review request is not valid JSON.', 400); }
}

export async function createApp({ telemetryPath = defaultTelemetry, reviewPath = defaultReviews, organizationId = 'local-dev', clock = Date.now } = {}) {
  const store = new ReviewStore(reviewPath);
  await store.load();
  const reviewToken = randomBytes(32).toString('hex');
  const snapshot = async (source, days) => {
    const now = clock();
    const input = source === 'demo' ? demoTelemetry(now) : await readTelemetry(telemetryPath, organizationId);
    const data = composeInsights(input, { source, days, now });
    for (const finding of data.findings) finding.review = store.get(finding.id);
    return data;
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    try {
      const host = request.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) {
        throw new AppError('local-host-required', 'This evaluation service only accepts loopback host names.', 403);
      }
      const origin = `http://${host}`;
      const url = new URL(request.url, origin);
      if (url.origin !== origin || (request.headers['sec-fetch-site'] === 'cross-site' && (url.pathname.startsWith('/api/') || request.method !== 'GET'))
        || (request.headers.origin && request.headers.origin !== origin)) {
        throw new AppError('same-origin-required', 'Cross-origin access is not permitted.', 403);
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        send(response, 200, { status: 'ok', mode: 'local-evaluation' });
      } else if (request.method === 'GET' && url.pathname === '/api/insights') {
        if ([...url.searchParams.keys()].some((key) => !['source', 'days'].includes(key))
          || url.searchParams.getAll('source').length > 1 || url.searchParams.getAll('days').length > 1) {
          throw new AppError('invalid-query', 'Only source and days filters are supported.', 400);
        }
        const source = url.searchParams.get('source') ?? 'local';
        const days = Number(url.searchParams.get('days') ?? 7);
        validateScope(source, days);
        send(response, 200, { ...await snapshot(source, days), reviewToken });
      } else if (request.method === 'POST' && url.pathname === '/api/reviews') {
        if (request.headers.origin !== origin || request.headers['x-review-token'] !== reviewToken) {
          request.resume();
          throw new AppError('review-token-required', 'Open this local site and refresh before saving a decision.', 403);
        }
        const body = await readBody(request);
        const allowedKeys = ['source', 'days', 'findingId', 'status', 'expectedRevision'];
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowedKeys.includes(key))
          || typeof body.findingId !== 'string' || !/^[a-f0-9]{24}$/.test(body.findingId)
          || !REVIEW_STATUSES.includes(body.status) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
          throw new AppError('invalid-review', 'Only a finding identifier, scope, decision status, and revision are accepted. Free-text notes are not stored.', 400);
        }
        validateScope(body.source, body.days);
        const current = await snapshot(body.source, body.days);
        if (!current.findings.some((finding) => finding.id === body.findingId)) {
          throw new AppError('evidence-changed', 'The evidence or time window changed. Refresh and review the current finding.', 409);
        }
        const review = await store.update(body.findingId, body.source, body.status, body.expectedRevision);
        send(response, 200, { review });
      } else if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [name, type] = staticFiles.get(url.pathname);
        send(response, 200, await readFile(new URL(name, publicRoot)), type);
      } else {
        send(response, 404, { error: { code: 'not-found', message: 'This local route is not available.' } });
      }
    } catch (error) {
      const known = error instanceof AppError;
      send(response, known ? error.status : 500, { error: {
        code: known ? error.code : 'unavailable',
        message: known ? error.message : 'The local insights service could not complete this request.',
      } });
    }
  });
  server.maxConnections = 64;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createApp({
      telemetryPath: process.env.INSIGHTS_TELEMETRY_PATH ?? defaultTelemetry,
      reviewPath: process.env.INSIGHTS_REVIEW_PATH ?? defaultReviews,
      organizationId: process.env.INSIGHTS_ORGANIZATION_ID ?? 'local-dev',
    });
    const port = Number(process.env.PORT ?? 3000);
    const host = process.env.HOST ?? '127.0.0.1';
    server.listen(port, host, () => console.log(`Copilot Insights review is ready on port ${port}. Local evaluation only.`));
    server.on('error', () => { console.error('The local insights listener could not start. Check the port and bind address.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { server.close(); server.closeIdleConnections(); });
    }
  } catch (error) {
    console.error(error instanceof AppError ? error.message : 'The local insights service could not start.');
    process.exitCode = 1;
  }
}
