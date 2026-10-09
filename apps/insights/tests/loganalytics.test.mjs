import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { composeInsights } from '../lib/analytics.mjs';
import { countQuery, logAnalyticsSource, spanQuery } from '../lib/loganalytics.mjs';
import { normalizeRecords } from '../lib/telemetry.mjs';
import { createApp } from '../server.mjs';

const NOW = Date.parse('2026-10-02T22:00:00.000Z');
const WORKSPACE = '11111111-2222-3333-4444-555555555555';
const ORGANIZATION = 'example-org';
const TRACE = '1'.repeat(32);
const AGENT = 'a'.repeat(16);
const resource = { 'service.name': 'copilot-chat', 'copilot_insights.organization.id': ORGANIZATION, 'session.id': 'window-1' };
const spans = [
  { spanId: AGENT, operation: 'invoke_agent', duration: 4000, status: 0, attributes: {} },
  { spanId: 'b'.repeat(16), operation: 'chat', duration: 1000.25, status: 2,
    attributes: { 'gen_ai.request.model': 'example-model', 'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 180, 'gen_ai.conversation.id': 'conversation-1' } },
  { spanId: 'c'.repeat(16), operation: 'execute_tool', duration: 100, status: 1, attributes: { 'gen_ai.tool.name': 'readFile', 'gen_ai.tool.call.id': 'call-1' } },
];
const statusNames = ['STATUS_CODE_UNSET', 'STATUS_CODE_OK', 'STATUS_CODE_ERROR'];
const iso = (milliseconds) => new Date(milliseconds).toISOString().replace('Z', '0000Z');
const otlp = (attributes) => Object.entries(attributes).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }));

// The OTLP records the file adapter would read for the same activity.
function fileRecords() {
  return [{
    resourceSpans: [{ resource: { attributes: otlp(resource) }, scopeSpans: [{ scope: { name: 'copilot-chat' }, spans: spans.map((span) => ({
      traceId: TRACE, spanId: span.spanId, ...(span.spanId === AGENT ? {} : { parentSpanId: AGENT }),
      startTimeUnixNano: String(BigInt(NOW - 5000) * 1_000_000n),
      endTimeUnixNano: String(BigInt(NOW - 5000) * 1_000_000n + BigInt(Math.round(span.duration * 1e6))),
      status: { code: span.status }, attributes: otlp({ 'gen_ai.operation.name': span.operation, ...span.attributes }),
    })) }] }],
    resourceLogs: [{ resource: { attributes: otlp(resource) }, scopeLogs: [{ scope: { name: 'copilot-chat' }, logRecords: [{
      timeUnixNano: String(BigInt(NOW - 1000) * 1_000_000n), attributes: otlp({ 'event.name': 'copilot_chat.user.feedback', conversation_id: 'conversation-1' }),
    }] }] }],
  }];
}

// The same activity as the azure_monitor exporter stores it: one Properties bag per row.
function storedRows({ rootParent = '' } = {}) {
  const properties = (extra) => JSON.stringify({ ...Object.fromEntries(Object.entries({ ...resource, ...extra }).map(([key, value]) => [key, String(value)])),
    'instrumentationlibrary.name': 'copilot-chat' });
  return {
    columns: ['SourceTable', 'TimeGenerated', 'Id', 'OperationId', 'ParentId', 'DurationMs', 'Properties'].map((name) => ({ name })),
    rows: [
      ...spans.map((span) => ['AppDependencies', iso(NOW - 5000), span.spanId, TRACE, span.spanId === AGENT ? rootParent : AGENT, span.duration,
        properties({ 'gen_ai.operation.name': span.operation, 'otel.status_code': statusNames[span.status], ...span.attributes })]),
      ['AppTraces', iso(NOW - 1000), null, '', '', null, properties({ 'event.name': 'copilot_chat.user.feedback', conversation_id: 'conversation-1' })],
    ],
  };
}

function workspace({ rows = storedRows(), counts = [['AppTraces', 4], ['AppMetrics', 7]], spanBody } = {}) {
  const calls = { token: 0, queries: [] };
  const fetcher = async (url, options) => {
    if (url instanceof URL) {
      calls.token++;
      assert.equal(options.headers['X-IDENTITY-HEADER'], 'identity-secret');
      assert.equal(url.searchParams.get('resource'), 'https://api.loganalytics.io');
      assert.equal(url.searchParams.get('client_id'), 'client-id');
      return { ok: true, json: async () => ({ access_token: 'token', expires_on: String(Math.floor(NOW / 1000) + 3600) }) };
    }
    assert.equal(url, `https://api.loganalytics.io/v1/workspaces/${WORKSPACE}/query`);
    assert.equal(options.headers.Authorization, 'Bearer token');
    const { query, timespan } = JSON.parse(options.body);
    calls.queries.push(query);
    assert.equal(timespan, 'P32D');
    if (query === spanQuery(ORGANIZATION)) return { ok: true, json: async () => spanBody ?? { tables: [rows] } };
    assert.equal(query, countQuery(ORGANIZATION));
    return { ok: true, json: async () => ({ tables: [{ columns: [{ name: 'SourceTable' }, { name: 'Records' }], rows: counts }] }) };
  };
  const read = logAnalyticsSource({ workspaceId: WORKSPACE, clientId: 'client-id', fetcher, clock: () => NOW,
    environment: { IDENTITY_ENDPOINT: 'http://identity.invalid/msi/token', IDENTITY_HEADER: 'identity-secret' } });
  return { read, calls };
}

test('stored Azure Monitor rows normalize exactly like the collector file for the same activity', async () => {
  const { read } = workspace();
  const stored = await read(ORGANIZATION);
  const file = normalizeRecords(fileRecords(), ORGANIZATION);
  const byId = (left, right) => left.id.localeCompare(right.id);
  assert.deepEqual(stored.spans.sort(byId), file.spans.sort(byId));
  assert.deepEqual(stored.feedback, file.feedback);
  assert.equal(stored.quality.backend, 'log-analytics');
  assert.equal(stored.quality.logRecords, 4);
  assert.equal(stored.quality.metricRecords, 7);
  const report = composeInsights(stored, { now: NOW });
  assert.equal(report.summary.agentRuns, 1);
  assert.equal(report.summary.calls, 1);
  assert.equal(report.summary.toolCalls, 1);
  assert.equal(report.summary.totalTokens, 1380);
  assert.equal(report.summary.errorRate, 1);
  assert.equal(report.correlation.matchedFeedbackLogs, 1);
});

test('a root span stored with its operation ID as parent stays a top-level run', async () => {
  const { read } = workspace({ rows: storedRows({ rootParent: TRACE }) });
  assert.equal(composeInsights(await read(ORGANIZATION), { now: NOW }).summary.agentRuns, 1);
});

test('the token and results are reused briefly; failures and partial results are never cached or shown', async () => {
  const { read, calls } = workspace();
  await read(ORGANIZATION);
  await read(ORGANIZATION);
  assert.equal(calls.token, 1);
  assert.equal(calls.queries.length, 2);

  const partial = workspace({ spanBody: { tables: [storedRows()], error: { code: 'PartialError' } } });
  await assert.rejects(partial.read(ORGANIZATION), { code: 'telemetry-unavailable' });
  await assert.rejects(partial.read(ORGANIZATION), { code: 'telemetry-unavailable' });
  assert.equal(partial.calls.queries.length, 4);

  const malformed = workspace({ rows: { ...storedRows(), rows: [['AppDependencies', iso(NOW), 'b'.repeat(16), TRACE, '', 1, '[]']] } });
  await assert.rejects(malformed.read(ORGANIZATION), { code: 'invalid-telemetry' });
});

test('configuration fails closed and the organization literal cannot change the query', async () => {
  assert.throws(() => logAnalyticsSource({ workspaceId: 'not-a-workspace' }), { code: 'invalid-configuration' });
  const { read, calls } = workspace();
  await assert.rejects(read("x' or 1==1 //"), { code: 'invalid-organization' });
  assert.equal(calls.queries.length, 0);
  const missingIdentity = logAnalyticsSource({ workspaceId: WORKSPACE, environment: {}, fetcher: async () => assert.fail('no request expected') });
  await assert.rejects(missingIdentity(ORGANIZATION), { code: 'telemetry-unavailable' });
});

test('the service reports and lists projects from the workspace instead of a capture file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'insights-workspace-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { read, calls } = workspace();
  const server = await createApp({ readCollected: read, telemetryPath: join(directory, 'absent.jsonl'), reviewPath: join(directory, 'reviews.json'),
    organizationId: ORGANIZATION, clock: () => NOW });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = await (await fetch(`${base}/api/insights?organization=${ORGANIZATION}`)).json();
  assert.equal(data.summary.totalTokens, 1380);
  assert.equal(data.quality.backend, 'log-analytics');
  assert.equal(data.quality.missing, false);
  assert.equal((await fetch(`${base}/api/projects?organization=${ORGANIZATION}`)).status, 200);
  assert.equal(calls.queries.length, 2);
});
