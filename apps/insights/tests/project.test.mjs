import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { composeInsights } from '../lib/analytics.mjs';
import { describeProject, normalizeProject, WindowContextStore } from '../lib/context.mjs';
import { demoTelemetry } from '../lib/demo.mjs';
import { normalizeRecords } from '../lib/telemetry.mjs';
import { createApp } from '../server.mjs';

const NOW = Date.UTC(2026, 9, 3, 12);
const DAY = 86_400_000;
const projectA = 'example.alpha';
const projectB = 'example.beta';
const organizationId = 'test-organization';
const attribute = (key, value) => ({ key, value: { stringValue: value } });

async function directoryFor(context) {
  const directory = await mkdtemp(join(tmpdir(), 'insights-project-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function record(sessionId, index, startedAt, endedAt, conversationId = `conversation-${index}`) {
  return { resourceSpans: [{ resource: { attributes: [attribute('service.name', 'copilot-chat'), attribute('session.id', sessionId),
    attribute('copilot_insights.organization.id', organizationId), attribute('copilot_insights.project.id', 'CLIENT-MUST-NOT-OVERRIDE')] },
  scopeSpans: [{ scope: { name: 'copilot-chat' }, spans: [{ traceId: index.toString(16).padStart(32, '0'), spanId: index.toString(16).padStart(16, '0'),
    startTimeUnixNano: String(BigInt(startedAt) * 1_000_000n), endTimeUnixNano: String(BigInt(endedAt) * 1_000_000n), status: { code: 2 },
    attributes: [attribute('gen_ai.operation.name', 'chat'), attribute('gen_ai.conversation.id', conversationId), attribute('gen_ai.request.model', 'example-model'),
      attribute('gen_ai.usage.input_tokens', '10'), attribute('gen_ai.usage.output_tokens', '2')] }] }] }] };
}

test('project keys are namespaced by the collector organization and only plain project IDs are accepted', () => {
  const keys = [projectA, projectB].map((project) => describeProject(organizationId, project).id);
  keys.push(describeProject('other-organization', projectA).id);
  assert.equal(new Set(keys).size, 3);
  assert.match(keys[0], /^prj-[a-f0-9]{24}$/);
  assert.equal(describeProject(organizationId, null).id, 'unattributed');
  assert.equal(normalizeProject(null), null);
  for (const value of [undefined, '', {}, { project: projectA }, '../escape', 'has space', 'x'.repeat(129), 42]) {
    assert.throws(() => normalizeProject(value), { code: 'invalid-project' });
  }
});

test('concurrent windows and multiple conversations use immutable project bindings, not client resource labels', async (context) => {
  const store = new WindowContextStore(join(await directoryFor(context), 'windows.json'), () => NOW);
  await store.load();
  await Promise.all([store.register(organizationId, 'window-a', projectA, NOW), store.register(organizationId, 'window-b', projectB, NOW), store.register(organizationId, 'window-none', null, NOW)]);
  const input = store.attribute(normalizeRecords([
    record('window-a', 1, NOW + 10, NOW + 20, 'chat-a1'), record('window-a', 2, NOW + 20, NOW + 30, 'chat-a2'),
    record('window-b', 3, NOW + 10, NOW + 20), record('window-none', 4, NOW + 10, NOW + 20),
    record('unregistered-window', 5, NOW + 10, NOW + 20), record('window-a', 6, NOW - 10, NOW + 10),
  ], organizationId));
  const reportA = composeInsights(input, { projectKey: describeProject(organizationId, projectA).id, now: NOW + 100 });
  const reportB = composeInsights(input, { projectKey: describeProject(organizationId, projectB).id, now: NOW + 100 });
  assert.equal(reportA.summary.calls, 2);
  assert.equal(reportA.correlation.conversations, 2);
  assert.equal(reportA.correlation.sessions, 1);
  assert.equal(reportB.summary.calls, 1);
  assert.equal(composeInsights(input, { projectKey: 'unattributed', now: NOW + 100 }).summary.calls, 3);
  assert.ok(input.spans.every((span) => !JSON.stringify(span).includes('CLIENT-MUST-NOT-OVERRIDE')));
});

test('changes close the old binding; delayed exports retain it and crossing/new work stays unattributed across restarts', async (context) => {
  const path = join(await directoryFor(context), 'windows.json');
  let clock = NOW;
  const store = new WindowContextStore(path, () => clock);
  await store.load();
  const first = await store.register(organizationId, 'window-a', projectA, clock);
  clock += 50;
  assert.equal((await store.register(organizationId, 'window-a', projectA, clock)).registeredAt, first.registeredAt);
  clock += 50;
  assert.equal((await store.register(organizationId, 'window-a', projectB, clock)).status, 'reload-required');
  assert.equal((await store.register(organizationId, 'window-a', projectA, clock)).status, 'reload-required');
  assert.equal((await store.register(organizationId, 'window-a', null, clock)).status, 'reload-required');
  const restored = new WindowContextStore(path, () => clock);
  await restored.load();
  const input = restored.attribute(normalizeRecords([
    record('window-a', 1, NOW + 20, NOW + 80), record('window-a', 2, NOW + 80, NOW + 120), record('window-a', 3, NOW + 120, NOW + 140),
  ], organizationId));
  assert.deepEqual(input.spans.map((span) => span.projectKey), [describeProject(organizationId, projectA).id, 'unattributed', 'unattributed']);
  assert.equal((await restored.register(organizationId, 'new-window-a', projectB, clock)).status, 'active');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.windows[0].project, projectA);
  assert.equal(stored.windows[0].closedAt, NOW + 100);
});

test('the first selection needs no reload but never claims earlier activity, and another publisher cannot take over a window', async (context) => {
  const store = new WindowContextStore(join(await directoryFor(context), 'windows.json'), () => NOW + 100);
  await store.load();
  assert.equal((await store.register(organizationId, 'first', null, NOW + 100)).status, 'unattributed');
  assert.equal(store.windows.size, 0);
  const adopted = await store.register(organizationId, 'first', projectA, NOW + 100);
  assert.equal(adopted.status, 'active');
  assert.equal(adopted.registeredAt, NOW + 100);
  await assert.rejects(store.register(organizationId, 'first', projectB, NOW + 100, 'other-owner'), { code: 'window-owner-required' });
  const spans = store.attribute(normalizeRecords([record('first', 1, NOW + 50, NOW + 150), record('first', 2, NOW + 150, NOW + 160)], organizationId)).spans;
  assert.deepEqual(spans.map((span) => span.projectKey), ['unattributed', describeProject(organizationId, projectA).id]);
});

test('boundaries use the device clock, and a device clock off by more than five minutes is refused', async (context) => {
  const store = new WindowContextStore(join(await directoryFor(context), 'windows.json'), () => NOW);
  await store.load();
  assert.equal((await store.register(organizationId, 'lagging', projectA, NOW - 60_000)).registeredAt, NOW - 60_000);
  const spans = store.attribute(normalizeRecords([record('lagging', 1, NOW - 30_000, NOW - 20_000)], organizationId)).spans;
  assert.equal(spans[0].projectKey, describeProject(organizationId, projectA).id);
  assert.equal((await store.register(organizationId, 'lagging', projectB, NOW - 59_000)).closedAt, NOW - 59_000);
  for (const clientTime of [NOW - 5 * 60_000 - 1, NOW + 5 * 60_000 + 1]) {
    await assert.rejects(store.register(organizationId, 'skewed', projectA, clientTime), { code: 'clock-skew' });
  }
  for (const clientTime of [undefined, '2026-10-03T12:00:00Z', 1.5]) {
    await assert.rejects(store.register(organizationId, 'skewed', projectA, clientTime), { code: 'invalid-client-time' });
  }
  assert.equal(store.windows.has(JSON.stringify([organizationId, 'skewed'])), false);
});

test('living windows renew their bindings while windows silent for 32 days are pruned', async (context) => {
  const path = join(await directoryFor(context), 'windows.json');
  let clock = NOW;
  const store = new WindowContextStore(path, () => clock);
  await store.load();
  for (const [sessionId, project] of [['living', projectA], ['abandoned', projectA], ['closed', projectA], ['closed', projectB]]) {
    await store.register(organizationId, sessionId, project, clock);
  }
  for (let day = 1; day <= 33; day++) {
    clock = NOW + day * DAY;
    assert.equal((await store.register(organizationId, 'living', projectA, clock)).registeredAt, NOW);
  }
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(stored.windows.map((entry) => [entry.sessionId, entry.renewedAt]), [['living', clock]]);
  assert.equal((await store.register(organizationId, 'closed', projectB, clock)).status, 'active');
});

test('corrupt, outdated, or unwritable attribution storage fails closed without leaking content', async (context) => {
  const directory = await directoryFor(context);
  const path = join(directory, 'windows.json');
  await writeFile(path, 'PRIVATE-CANARY');
  await assert.rejects(new WindowContextStore(path).load(), (error) => error.code === 'context-storage-unavailable' && !error.message.includes('PRIVATE-CANARY'));
  for (const overrides of [{ sessionId: 123 }, { organizationId: 123 }, { project: '../escape' }, { project: undefined }, { renewedAt: undefined }]) {
    await writeFile(path, JSON.stringify({ version: 2, windows: [{ sessionId: 'window-a', organizationId, ownerId: 'local',
      project: projectA, registeredAt: NOW, renewedAt: NOW, closedAt: null, ...overrides }] }));
    await assert.rejects(new WindowContextStore(path).load(), { code: 'context-storage-unavailable' });
  }
  await writeFile(path, JSON.stringify({ version: 1, windows: [] }));
  await assert.rejects(new WindowContextStore(path).load(), { code: 'context-storage-unavailable' });
  const store = new WindowContextStore(join(path, 'impossible.json'), () => NOW);
  await assert.rejects(store.register(organizationId, 'window-a', projectA, NOW), { code: 'context-write-failed' });
  assert.equal(store.windows.size, 0);
});

test('demo project totals partition the organization and review fingerprints include the selected filter', () => {
  const input = demoTelemetry(NOW);
  const reports = ['unattributed', ...input.projects.map((project) => describeProject(input.organizationId, project).id)]
    .map((projectKey) => composeInsights(input, { source: 'demo', projectKey, now: NOW }));
  assert.ok(reports.every((report) => report.summary.calls > 0));
  assert.equal(reports.reduce((sum, report) => sum + report.summary.calls, 0), composeInsights(input, { source: 'demo', now: NOW }).summary.calls);
  const one = { ...input, spans: input.spans.filter((span) => span.projectKey === reports[1].projectKey) };
  assert.notEqual(composeInsights(one, { now: NOW }).snapshotId, composeInsights(one, { now: NOW, projectKey: reports[1].projectKey }).snapshotId);
});

test('HTTP registration, project filters, and review isolation work without local authentication', async (context) => {
  const directory = await directoryFor(context);
  const telemetryPath = join(directory, 'telemetry.jsonl');
  let now = NOW;
  const server = await createApp({ telemetryPath, reviewPath: join(directory, 'reviews.json'), organizationId, clock: () => now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const register = (body, headers = {}) => fetch(`${base}/api/context/windows`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ clientTime: now, ...body }) });
  assert.equal((await register({ sessionId: 'window-a', project: projectA })).status, 200);
  assert.equal((await register({ sessionId: 'window-b', project: projectB })).status, 200);
  for (const body of [{ sessionId: 'window-b', project: projectB, organizationId: 'spoofed' }, { sessionId: 'window-c' }, { sessionId: 'window-c', project: { name: projectA } },
    { sessionId: 'window-c', project: projectA, clientTime: undefined }, { sessionId: 'window-c', project: projectA, clientTime: now - 10 * 60_000 }]) {
    assert.equal((await register(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await register({ sessionId: 'window-a', project: null }, { Origin: 'https://foreign.invalid' })).status, 403);
  await writeFile(telemetryPath, [record('window-a', 1, NOW + 1, NOW + 2), record('window-b', 2, NOW + 1, NOW + 2), record('unregistered', 3, NOW + 1, NOW + 2)].map(JSON.stringify).join('\n') + '\n');
  now += 100;
  const catalog = await (await fetch(`${base}/api/projects?organization=${organizationId}`)).json();
  assert.deepEqual(catalog.projects.map((entry) => entry.name), ['All projects', 'Unattributed', projectA, projectB]);
  const projectKey = describeProject(organizationId, projectA).id;
  const query = `organization=${organizationId}&project=${projectKey}`;
  const report = await (await fetch(`${base}/api/insights?${query}`)).json();
  assert.equal(report.summary.calls, 1);
  assert.equal(report.project.project, projectA);
  const review = { organizationId, projectKey, days: 7, findingId: report.findings[0].id, status: 'reviewed', expectedRevision: 0 };
  const reviewHeaders = { 'Content-Type': 'application/json', Origin: base, 'X-Review-Token': report.reviewToken };
  assert.equal((await fetch(`${base}/api/reviews`, { method: 'POST', headers: reviewHeaders, body: JSON.stringify(review) })).status, 200);
  assert.equal((await fetch(`${base}/api/reviews`, { method: 'POST', headers: reviewHeaders, body: JSON.stringify({ ...review, projectKey: 'all' }) })).status, 409);
  const all = await (await fetch(`${base}/api/insights?organization=${organizationId}`)).json();
  assert.equal(all.summary.calls, 3);
  assert.ok(all.findings.every((finding) => finding.review.status === 'unreviewed'));
  assert.equal((await fetch(`${base}/api/insights?organization=synthetic-demo&project=${projectKey}`)).status, 400);
  assert.equal((await fetch(`${base}/api/insights?${query}&project=all`)).status, 400);
  assert.equal((await register({ sessionId: 'window-a', project: projectB })).status, 409);
});
