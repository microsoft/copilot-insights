import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { composeInsights, percentile } from '../lib/analytics.mjs';
import { demoTelemetry } from '../lib/demo.mjs';
import { ReviewStore } from '../lib/reviews.mjs';
import { MAX_INPUT_BYTES, normalizeRecords, readTelemetry } from '../lib/telemetry.mjs';
import { createApp } from '../server.mjs';

const NOW = Date.parse('2026-10-02T22:00:00.000Z');
const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } });
const nano = (milliseconds) => String(BigInt(milliseconds) * 1_000_000n);
const resource = { attributes: [attr('service.name', 'copilot-chat'), attr('copilot_insights.organization.id', 'local-dev')] };

function fixture() {
  const agentId = 'a'.repeat(16);
  const span = (operation, spanId, duration, attributes) => ({
    traceId: '1'.repeat(32), spanId,
    ...(operation === 'invoke_agent' ? {} : { parentSpanId: agentId }),
    startTimeUnixNano: nano(NOW - duration - 1000), endTimeUnixNano: nano(NOW - 1000),
    attributes: [attr('gen_ai.operation.name', operation), ...attributes],
    status: { code: 0 },
  });
  return { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'copilot-chat' }, spans: [
    span('invoke_agent', agentId, 4000, [attr('gen_ai.usage.input_tokens', 99999)]),
    span('chat', 'b'.repeat(16), 1000, [attr('gen_ai.request.model', 'example-model'), attr('gen_ai.usage.input_tokens', 1200), attr('gen_ai.usage.output_tokens', 180)]),
    span('execute_tool', 'c'.repeat(16), 100, [attr('gen_ai.tool.name', 'readFile')]),
  ] }] }] };
}

const modelSpan = (record) => record.resourceSpans[0].scopeSpans[0].spans[1];
const project = (records) => ({ ...normalizeRecords(records), pendingRecord: false, missing: false });
const insights = (records, options = {}) => composeInsights(project(records), { now: NOW, ...options });

async function temporary(context) {
  const path = await mkdtemp(join(tmpdir(), 'copilot-insights-test-'));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('canonical counts use child model tokens and executed tool spans only', () => {
  const record = fixture();
  record.resourceMetrics = [{ resource, scopeMetrics: [{ metrics: [{ name: 'copilot_chat.tool.call.count', sum: { dataPoints: [{ asInt: '99' }] } }] }] }];
  record.resourceLogs = [{ resource, scopeLogs: [{ logRecords: [{ body: { stringValue: 'Not part of analytics' } }] }] }];
  const data = insights([record]);
  assert.equal(data.summary.agentRuns, 1);
  assert.equal(data.summary.calls, 1);
  assert.equal(data.summary.toolCalls, 1);
  assert.equal(data.summary.totalTokens, 1380);
  assert.equal(data.summary.p95Ms, 1000);
  assert.equal(data.quality.metricRecords, 1);
  assert.equal(data.quality.logRecords, 1);
});

test('nested agent work is not counted as a top-level run', () => {
  const record = fixture();
  record.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId = 'd'.repeat(16);
  const data = insights([record]);
  assert.equal(data.summary.agentRuns, 0);
  assert.equal(data.summary.nestedAgentRuns, 1);
});

test('identical replays are deduplicated and conflicting identities are excluded', () => {
  const first = fixture();
  assert.equal(insights([first, first]).summary.totalTokens, 1380);
  assert.equal(insights([first, first]).quality.duplicateSpans, 3);
  const conflict = structuredClone(first);
  modelSpan(conflict).attributes.push(attr('gen_ai.usage.output_tokens.extra', 1));
  modelSpan(conflict).endTimeUnixNano = nano(NOW);
  const data = insights([first, conflict, first]);
  assert.equal(data.summary.calls, 0);
  assert.equal(data.quality.conflictingSpans, 1);
  assert.ok(data.findings.some((finding) => finding.kind === 'conflicting-spans'));
});

test('unknown and cancelled outcomes are not interpreted as success or failure', () => {
  const record = fixture();
  assert.equal(insights([record]).summary.unknownOutcomes, 1);
  modelSpan(record).attributes.push(attr('error.type', 'cancelled'));
  modelSpan(record).status.code = 2;
  const data = insights([record]);
  assert.equal(data.summary.cancelledCalls, 1);
  assert.equal(data.summary.errors, 0);
});

test('explicit errors create inspectable evidence without raw exception details', () => {
  const record = fixture();
  modelSpan(record).status = { code: 2, message: 'PRIVATE-CANARY-exception' };
  const data = insights([record]);
  const finding = data.findings.find((entry) => entry.kind === 'model-errors');
  assert.equal(data.summary.errorRate, 1);
  assert.equal(finding.evidence[0].parentSpanId, 'a'.repeat(16));
  assert.ok(!JSON.stringify(data).includes('PRIVATE-CANARY'));
});

test('missing token fields remain unknown; known partial totals have explicit coverage', () => {
  const record = fixture();
  modelSpan(record).attributes = modelSpan(record).attributes.filter((entry) => entry.key !== 'gen_ai.usage.output_tokens');
  const data = insights([record]);
  assert.equal(data.summary.outputTokens, null);
  assert.equal(data.summary.totalTokens, 1200);
  assert.equal(data.summary.tokenCoverage, 0);
  assert.equal(data.findings.find((finding) => finding.kind === 'token-coverage').evidenceCount, 1);
});

test('unsafe, negative, fractional, and non-scalar token counts are unknown', () => {
  for (const value of ['9007199254740992', '-1', '1.5', '', { secret: 'PRIVATE-CANARY-value' }]) {
    const record = fixture();
    modelSpan(record).attributes.find((entry) => entry.key === 'gen_ai.usage.input_tokens').value = { intValue: value };
    assert.equal(insights([record]).summary.inputTokens, null);
  }
});

test('invalid durations are unknown; nearest-rank percentile is explicit', () => {
  const record = fixture();
  modelSpan(record).startTimeUnixNano = nano(NOW + 1000);
  assert.equal(insights([record]).summary.p95Ms, null);
  assert.equal(percentile(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  assert.equal(percentile([]), null);
});

test('source, organization, supported operations, and valid correlation IDs are required', () => {
  const record = fixture();
  assert.equal(composeInsights({ ...normalizeRecords([record], 'another-example'), pendingRecord: false }, { now: NOW }).summary.calls, 0);
  record.resourceSpans[0].scopeSpans[0].scope.name = 'unsupported';
  assert.equal(insights([record]).quality.acceptedSpans, 0);
  const invalid = fixture();
  modelSpan(invalid).traceId = 'PRIVATE-CANARY-id';
  assert.equal(insights([invalid]).summary.calls, 0);
});

test('projection never exposes excluded attributes, identities, paths, bodies, events, or links', () => {
  const record = fixture();
  const model = modelSpan(record);
  model.attributes.push(attr('gen_ai.input.messages', 'PRIVATE-CANARY-prompt'), attr('user.email', 'PRIVATE-CANARY@example.invalid'));
  model.attributes.find((entry) => entry.key === 'gen_ai.request.model').value.stringValue = 'https://private.example.invalid/PRIVATE-CANARY-model';
  model.events = [{ name: 'PRIVATE-CANARY-event' }];
  model.links = [{ attributes: [attr('private', 'PRIVATE-CANARY-link')] }];
  record.resourceSpans[0].resource = { attributes: [...resource.attributes, attr('host.name', 'PRIVATE-CANARY-host')] };
  const data = insights([record]);
  assert.equal(data.models[0].name, 'Unknown');
  assert.ok(!JSON.stringify(data).includes('PRIVATE-CANARY'));
  assert.ok(!JSON.stringify(data).includes('private.example.invalid'));
});

test('UTC windows and future timestamps do not fabricate current activity', () => {
  const record = fixture();
  modelSpan(record).endTimeUnixNano = nano(NOW + 1000);
  assert.equal(insights([record]).summary.calls, 0);
  assert.equal(insights([record]).quality.futureSpans, 1);
  const data = insights([fixture()], { days: 7 });
  assert.equal(data.trend.length, 7);
  assert.equal(data.trend[6].date, '2026-10-02');
  assert.equal(data.trend[6].calls, 1);
});

test('demo data is deterministic and review identities are isolated by source, window, and evidence', () => {
  const demo = demoTelemetry(NOW);
  assert.deepEqual(demo, demoTelemetry(NOW));
  const first = insights([fixture()]);
  assert.equal(first.findings[0].id, insights([fixture()]).findings[0].id);
  assert.notEqual(first.findings[0].id, insights([fixture()], { source: 'demo' }).findings[0].id);
  assert.notEqual(first.findings[0].id, insights([fixture()], { days: 14 }).findings[0].id);
  const changed = fixture();
  modelSpan(changed).endTimeUnixNano = nano(NOW);
  assert.notEqual(first.findings[0].id, insights([changed]).findings[0].id);
});

test('JSONL reader handles absent files, UTF-8 BOM, CRLF, and a partial append', async (context) => {
  const directory = await temporary(context);
  const path = join(directory, 'telemetry.jsonl');
  assert.equal((await readTelemetry(path)).missing, true);
  await writeFile(path, `\uFEFF${JSON.stringify(fixture())}\r\n{"resourceSpans":`);
  const data = await readTelemetry(path);
  assert.equal(data.spans.length, 3);
  assert.equal(data.pendingRecord, true);
});

test('malformed complete records fail closed without returning source content or paths', async (context) => {
  const directory = await temporary(context);
  const path = join(directory, 'PRIVATE-CANARY-file.jsonl');
  await writeFile(path, '{PRIVATE-CANARY-broken}\n');
  await assert.rejects(readTelemetry(path), (error) => error.code === 'invalid-telemetry' && !error.message.includes('PRIVATE-CANARY'));
  await writeFile(path, '{"resourceSpans":{}}\n');
  await assert.rejects(readTelemetry(path), { code: 'invalid-telemetry' });
});

test('decisions persist atomically across store reloads and reject concurrent stale revisions', async (context) => {
  const directory = await temporary(context);
  const path = join(directory, 'reviews.json');
  const store = new ReviewStore(path);
  await store.load();
  const id = 'a'.repeat(24);
  const results = await Promise.allSettled([store.update(id, 'local', 'reviewed', 0), store.update(id, 'local', 'dismissed', 0)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409);
  const restored = new ReviewStore(path);
  await restored.load();
  assert.equal(restored.get(id).status, 'reviewed');
  assert.equal(restored.get(id).revision, 1);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved.decisions[0]).sort(), ['id', 'revision', 'source', 'status', 'updatedAt']);
});

async function service(context, withData = true) {
  const directory = await temporary(context);
  const telemetryPath = join(directory, 'telemetry.jsonl');
  if (withData) await writeFile(telemetryPath, `${JSON.stringify(fixture())}\n`);
  const server = await createApp({ telemetryPath, reviewPath: join(directory, 'reviews.json'), clock: () => NOW });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, telemetryPath };
}

test('HTTP API defaults to local data, never silently falls back to demo, and sets privacy headers', async (context) => {
  const { base } = await service(context, false);
  const response = await fetch(`${base}/api/insights`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.source, 'local');
  assert.equal(data.summary.calls, 0);
  const demo = await (await fetch(`${base}/api/insights?source=demo`)).json();
  assert.equal(demo.source, 'demo');
  assert.ok(demo.summary.calls > 0);
});

test('HTTP boundary rejects foreign hosts, origins, arbitrary files, and unsupported filters', async (context) => {
  const { base } = await service(context);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/insights`, { headers: { Host: 'example.invalid' } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/api/insights`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  for (const path of ['/telemetry.jsonl', '/state/reviews.json', '/server.mjs', '/lib/telemetry.mjs', '/%2e%2e/package.json']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${base}/api/insights?source=private`)).status, 400);
  assert.equal((await fetch(`${base}/api/insights?days=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/insights?days=7&days=30`)).status, 400);
});

test('review API requires same-origin token, validates enums, and detects stale evidence', async (context) => {
  const { base, telemetryPath } = await service(context);
  const data = await (await fetch(`${base}/api/insights`)).json();
  const body = { source: 'local', days: 7, findingId: data.findings[0].id, status: 'reviewed', expectedRevision: 0 };
  const headers = { 'Content-Type': 'application/json', Origin: base, 'X-Review-Token': data.reviewToken };
  const post = (payload, requestHeaders = headers) => fetch(`${base}/api/reviews`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(payload) });
  assert.equal((await post(body, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post(body, { ...headers, Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await post({ ...body, note: 'PRIVATE-CANARY-free-text' })).status, 400);
  assert.equal((await post({ ...body, status: 'arbitrary' })).status, 400);
  assert.equal((await post({ ...body, source: 'demo' })).status, 409);
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 409);
  const refreshed = await (await fetch(`${base}/api/insights`)).json();
  assert.equal(refreshed.findings[0].review.status, 'reviewed');
  const changed = fixture();
  modelSpan(changed).endTimeUnixNano = nano(NOW);
  await writeFile(telemetryPath, `${JSON.stringify(changed)}\n`);
  assert.equal((await post({ ...body, expectedRevision: 1 })).status, 409);
});

test('API failures do not reflect malformed file contents or local paths', async (context) => {
  const { base, telemetryPath } = await service(context);
  await writeFile(telemetryPath, 'PRIVATE-CANARY-malformed\n');
  const response = await fetch(`${base}/api/insights`);
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.ok(!text.includes('PRIVATE-CANARY'));
  assert.ok(!text.includes(telemetryPath));
});

test('unsupported collection shapes fail closed instead of looking like an empty source', () => {
  for (const value of [null, 'not-an-array', {}]) {
    assert.throws(() => normalizeRecords([{ resourceSpans: value }]), { code: 'invalid-telemetry' });
  }
});

test('large local inputs are rejected before parsing and token totals cannot silently round', async (context) => {
  const directory = await temporary(context);
  const path = join(directory, 'large.jsonl');
  const handle = await open(path, 'w');
  await handle.truncate(MAX_INPUT_BYTES + 1);
  await handle.close();
  await assert.rejects(readTelemetry(path), { code: 'input-too-large' });
  const record = fixture();
  modelSpan(record).attributes.find((entry) => entry.key === 'gen_ai.usage.input_tokens').value.intValue = String(Number.MAX_SAFE_INTEGER);
  assert.throws(() => insights([record]), { code: 'unsafe-aggregate' });
});

test('corrupt review state fails closed and failed writes do not mark findings as reviewed', async (context) => {
  const directory = await temporary(context);
  const path = join(directory, 'state.json');
  await writeFile(path, 'PRIVATE-CANARY-state');
  await assert.rejects(new ReviewStore(path).load(), (error) => error.code === 'review-storage-unavailable' && !error.message.includes('PRIVATE-CANARY'));
  const store = new ReviewStore(join(path, 'reviews.json'));
  await assert.rejects(store.update('b'.repeat(24), 'local', 'reviewed', 0), { code: 'review-write-failed' });
  assert.equal(store.get('b'.repeat(24)).status, 'unreviewed');
});

test('browser navigation is allowed but cross-site API reads and non-JSON or oversized writes are blocked', async (context) => {
  const { base } = await service(context);
  assert.equal((await fetch(`${base}/`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  assert.equal((await fetch(`${base}/api/insights`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const data = await (await fetch(`${base}/api/insights`)).json();
  const headers = { Origin: base, 'X-Review-Token': data.reviewToken };
  assert.equal((await fetch(`${base}/api/reviews`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/reviews`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'x'.repeat(5000) }) })).status, 413);
});
