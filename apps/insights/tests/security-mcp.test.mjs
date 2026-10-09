import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authConfigFromEnvironment, createAuthorization } from '../lib/auth.mjs';
import { createApp } from '../server.mjs';

const NOW = Date.UTC(2026, 9, 3, 12);
const config = {
  mode: 'production', publicOrigin: 'https://insights.example.test',
  tenantId: '11111111-1111-4111-8111-111111111111',
  audience: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
};
const subject = '44444444-4444-4444-8444-444444444444';
const keys = await generateKeyPair('RS256', { extractable: true });
const publicKey = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const keyResolver = createLocalJWKSet({ keys: [publicKey] });

function proxyFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), signal: options.signal }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

function signedToken(overrides = {}) {
  return new SignJWT({
    iss: `https://login.microsoftonline.com/${config.tenantId}/v2.0`, tid: config.tenantId,
    aud: config.audience, ver: '2.0', oid: subject, azp: config.clientId,
    roles: ['Insights.Admin'], scp: 'Insights.Read', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).sign(keys.privateKey);
}

async function service(context, production = false) {
  const directory = await mkdtemp(join(tmpdir(), 'insights-auth-'));
  const text = (key, value) => ({ key, value: { stringValue: value } });
  await writeFile(join(directory, 'telemetry.jsonl'), `${JSON.stringify({ resourceSpans: [{
    resource: { attributes: [text('service.name', 'copilot-chat'), text('copilot_insights.organization.id', 'local-vscode')] },
    scopeSpans: [{ scope: { name: 'copilot-chat' }, spans: [{ traceId: '1'.repeat(32), spanId: '2'.repeat(16), attributes: [text('gen_ai.operation.name', 'chat')],
      startTimeUnixNano: String(BigInt(NOW - 2000) * 1_000_000n), endTimeUnixNano: String(BigInt(NOW - 1000) * 1_000_000n) }] }],
  }] })}\n`);
  const server = await createApp({
    telemetryPath: join(directory, 'telemetry.jsonl'), reviewPath: join(directory, 'reviews.json'), clock: () => NOW,
    authConfig: production ? config : { mode: 'local' }, keyResolver,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, accessToken, options = {}) => proxyFetch(`${base}${path}`, { ...options, headers: {
    ...(production ? { Host: 'insights.example.test' } : {}), ...options.headers,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  } });
  return { base, request };
}

test('production configuration fails closed and local mode is explicit in production processes', () => {
  assert.throws(() => authConfigFromEnvironment({ NODE_ENV: 'production' }), { code: 'auth-configuration' });
  assert.equal(authConfigFromEnvironment({ NODE_ENV: 'production', INSIGHTS_MODE: 'local' }).mode, 'local');
  for (const override of [{ mode: 'disabled' }, { tenantId: '' }, { audience: 'api://not-a-guid' }, { clientId: config.audience },
    { publicOrigin: 'http://insights.example.test' }, { publicOrigin: 'https://insights.example.test/path' }, { publicOrigin: 'https://user@insights.example.test' }]) {
    assert.throws(() => createAuthorization({ ...config, ...override }), { code: 'auth-configuration' });
  }
});

test('Entra role enforcement validates signatures, issuer, tenant, audience, time, actor, scopes, and actual app roles', async (context) => {
  const { request } = await service(context, true);
  assert.equal((await request('/api/organizations', await signedToken())).status, 200);
  const invalid = [
    { aud: config.clientId }, { tid: subject }, { iss: `https://login.microsoftonline.com/${subject}/v2.0` },
    { exp: NOW / 1000 - 60 }, { nbf: NOW / 1000 + 60 }, { iat: NOW / 1000 + 60 },
    { ver: '1.0' }, { oid: undefined }, { azp: undefined }, { scp: undefined }, { exp: undefined }, { scp: 123, idtyp: 'app' },
  ];
  for (const overrides of invalid) assert.equal((await request('/api/organizations', await signedToken(overrides))).status, 401, JSON.stringify(overrides));
  for (const overrides of [{ roles: [] }, { roles: undefined }, { roles: ['Owner', 'Contributor'] }, { roles: ['insights.admin'] }, { scp: 'Context.Publish' }, { roles: [], groups: ['admin'], wids: ['admin'] }]) {
    assert.equal((await request('/api/organizations', await signedToken(overrides))).status, 403, JSON.stringify(overrides));
  }
  const valid = await signedToken();
  const tampered = valid.split('.');
  tampered[1] = Buffer.from(JSON.stringify({ roles: ['Insights.Admin'] })).toString('base64url');
  assert.equal((await request('/api/organizations', tampered.join('.'))).status, 401);
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${valid.split('.')[1]}.`;
  assert.equal((await request('/api/organizations', unsigned)).status, 401);
  assert.equal((await request('/api/organizations', await signedToken({ scp: undefined, idtyp: 'app' }))).status, 200);
});

test('every production data route and MCP request needs admin authorization; publisher access cannot read reports', async (context) => {
  const { request } = await service(context, true);
  const publisher = await signedToken({ roles: ['Insights.Publisher'], scp: 'Context.Publish' });
  for (const [path, method] of [['/api/organizations', 'GET'], ['/api/projects', 'GET'], ['/api/insights', 'GET'], ['/api/reviews', 'POST'], ['/mcp', 'POST']]) {
    const response = await request(path, undefined, { method, headers: { 'X-MS-CLIENT-PRINCIPAL': 'spoofed-admin' } });
    assert.equal(response.status, 401, path);
    assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
    assert.equal((await request(path, publisher, { method })).status, 403, path);
  }
  const body = JSON.stringify({ sessionId: 'publisher-window', project: 'example-project', clientTime: NOW });
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  const unauthenticatedPublisher = await request('/api/context/windows', undefined, options);
  assert.equal(unauthenticatedPublisher.status, 401);
  assert.equal(unauthenticatedPublisher.headers.get('www-authenticate'), `Bearer scope="api://${config.audience}/Context.Publish"`);
  const expiredPublisher = await request('/api/context/windows', await signedToken({ roles: ['Insights.Publisher'], scp: 'Context.Publish', exp: NOW / 1000 - 60 }), options);
  assert.equal(expiredPublisher.status, 401);
  assert.equal(expiredPublisher.headers.get('www-authenticate'), unauthenticatedPublisher.headers.get('www-authenticate'));
  assert.equal((await request('/api/context/windows', publisher, options)).status, 200);
  for (const scp of [undefined, 'Context.Publish']) {
    const appOnlyPublisher = await signedToken({ roles: ['Insights.Publisher'], scp, idtyp: 'app' });
    assert.equal((await request('/api/context/windows', appOnlyPublisher, options)).status, 403);
  }
  assert.equal((await request('/api/context/windows', await signedToken(), options)).status, 403);
  const otherPublisher = await signedToken({ roles: ['Insights.Publisher'], scp: 'Context.Publish', oid: '55555555-5555-4555-8555-555555555555' });
  assert.equal((await request('/api/context/windows', otherPublisher, options)).status, 403);
  const metadata = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, `${config.publicOrigin}/mcp`);
  assert.deepEqual(metadata.scopes_supported, [`api://${config.audience}/Insights.Read`]);
  assert.equal((await request('/api/health')).status, 200);
});

test('human review writes require a delegated admin and retain origin and review-token checks', async (context) => {
  const { request } = await service(context, true);
  const admin = await signedToken();
  const report = await (await request('/api/insights?organization=local-vscode&days=7', admin)).json();
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.publicOrigin, 'X-Review-Token': report.reviewToken },
    body: JSON.stringify({ organizationId: 'local-vscode', projectKey: 'all', days: 7, findingId: report.findings[0].id,
      status: 'reviewed', expectedRevision: report.findings[0].review.revision }) };
  const application = await request('/api/reviews', await signedToken({ scp: undefined, idtyp: 'app' }), options);
  assert.equal(application.status, 403);
  assert.equal((await application.json()).error.code, 'role-required');
  for (const headers of [{ 'Content-Type': 'application/json', 'X-Review-Token': report.reviewToken }, { ...options.headers, 'X-Review-Token': 'incorrect' }]) {
    assert.equal((await request('/api/reviews', admin, { ...options, headers })).status, 403);
  }
  const saved = await request('/api/reviews', admin, options);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).review.status, 'reviewed');
});

test('production offers only the collected organization and never opens on fictional data', async (context) => {
  const { request } = await service(context, true);
  const admin = await signedToken();
  const catalog = await (await request('/api/organizations', admin)).json();
  assert.deepEqual(catalog.organizations.map((entry) => entry.id), ['local-vscode']);
  assert.equal(catalog.defaultOrganizationId, 'local-vscode');
  const report = await (await request('/api/insights', admin)).json();
  assert.equal(report.organizationId, 'local-vscode');
  assert.equal(report.summary.calls, 1);
  for (const query of ['organization=synthetic-demo', 'source=demo']) assert.equal((await request(`/api/insights?${query}`, admin)).status, 400, query);
});

test('production hosts and origins are pinned and the same-origin redirect bridge keeps auth responses uncached', async (context) => {
  const { base, request } = await service(context, true);
  const admin = await signedToken();
  assert.equal((await fetch(`${base}/api/insights`, { headers: { Authorization: `Bearer ${admin}` } })).status, 403);
  assert.equal((await request('/api/insights', admin, { headers: { Origin: 'https://foreign.example.test' } })).status, 403);
  const bridge = await request('/auth/redirect.html');
  assert.equal(bridge.status, 200);
  assert.equal(bridge.headers.get('cross-origin-opener-policy'), null);
  assert.equal(bridge.headers.get('cache-control'), 'no-store');
  assert.equal(bridge.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(bridge.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const shell = await request('/');
  assert.equal(shell.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(await shell.text(), /id="main"[^>]*hidden/);
});

test('the official MCP client can discover and query isolated project reports with no local auth', async (context) => {
  const { base } = await service(context);
  const client = new Client({ name: 'insights-e2e-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['get_insights_report', 'list_organizations', 'list_projects']);
    assert.ok(tools.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    const organizations = await client.callTool({ name: 'list_organizations', arguments: {} });
    assert.equal(organizations.structuredContent.organizations.length, 2);
    const catalog = await client.callTool({ name: 'list_projects', arguments: { organization: 'synthetic-demo' } });
    const project = catalog.structuredContent.projects.find((entry) => entry.project === 'sample-alpha');
    const result = await client.callTool({ name: 'get_insights_report', arguments: { organization: 'synthetic-demo', project: project.id, days: 7 } });
    assert.equal(result.structuredContent.projectKey, project.id);
    assert.ok(result.structuredContent.summary.calls > 0);
    assert.equal(result.structuredContent.reviewToken, undefined);
    const missing = await client.callTool({ name: 'get_insights_report', arguments: { organization: 'missing-organization' } });
    assert.equal(missing.isError, true);
    const invalid = await client.callTool({ name: 'get_insights_report', arguments: { path: '/etc/passwd' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

test('an MCP initialization or session header never bypasses per-request production role validation', async (context) => {
  const { base } = await service(context, true);
  let accessToken = await signedToken();
  const client = new Client({ name: 'role-boundary-tests', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    fetch: (url, options) => proxyFetch(url, { ...options, headers: { ...Object.fromEntries(new Headers(options.headers)), Host: 'insights.example.test', Authorization: `Bearer ${accessToken}` } }),
  });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 3);
    const report = await client.callTool({ name: 'get_insights_report', arguments: {} });
    assert.equal(report.structuredContent.organizationId, 'local-vscode');
    accessToken = await signedToken({ roles: [] });
    await assert.rejects(client.listTools(), { code: 403 });
  } finally { await client.close(); }
});
