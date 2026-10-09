import { createHash } from 'node:crypto';
import { normalizeRecords } from './telemetry.mjs';
import { describeProject } from './context.mjs';

const DAY = 86_400_000;
const hash = (text, length) => createHash('sha256').update(text).digest('hex').slice(0, length);
const textAttribute = (key, value) => ({ key, value: { stringValue: value } });
const countAttribute = (key, value) => ({ key, value: { intValue: String(value) } });

export function demoTelemetry(now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY;
  const spans = [];
  const models = ['example-balanced', 'example-fast', 'example-reasoning'];
  const tools = ['readFile', 'searchFiles', 'runTests', 'editFile'];
  for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
    const date = today - dayOffset * DAY;
    const count = 12 + ((29 - dayOffset) * 7) % 19;
    for (let callIndex = 0; callIndex < count; callIndex++) {
      const seed = `${date}-${callIndex}`;
      const traceId = hash(`trace-${seed}`, 32);
      const agentId = hash(`agent-${seed}`, 16);
      const modelIndex = callIndex % models.length;
      const timestamp = date + 8 * 3_600_000 + callIndex * 900_000;
      const duration = modelIndex === 2 && callIndex % 4 === 0 ? 12_400 : 520 + modelIndex * 900 + callIndex * 71;
      const isError = (callIndex + dayOffset) % 11 === 0;
      const makeSpan = (operation, suffix, elapsed, attributes, status = 1) => ({
        traceId,
        spanId: suffix === 'agent' ? agentId : hash(`${suffix}-${seed}`, 16),
        ...(suffix === 'agent' ? {} : { parentSpanId: agentId }),
        startTimeUnixNano: String(BigInt(timestamp - elapsed) * 1_000_000n),
        endTimeUnixNano: String(BigInt(timestamp) * 1_000_000n),
        attributes: [textAttribute('gen_ai.operation.name', operation), textAttribute('gen_ai.conversation.id', `demo-${traceId}`), ...attributes],
        status: { code: status },
      });
      spans.push(makeSpan('invoke_agent', 'agent', duration + 900, []));
      spans.push(makeSpan('chat', 'model', duration, [
        textAttribute('gen_ai.request.model', models[modelIndex]),
        countAttribute('gen_ai.usage.input_tokens', 600 + modelIndex * 420 + callIndex * 93),
        ...(callIndex % 9 === 0 ? [] : [countAttribute('gen_ai.usage.output_tokens', 90 + callIndex * 27)]),
      ], isError ? 2 : callIndex % 7 === 0 ? 0 : 1));
      spans.push(makeSpan('execute_tool', 'tool', 35 + callIndex * 13, [textAttribute('gen_ai.tool.name', tools[callIndex % tools.length]), textAttribute('gen_ai.tool.call.id', `demo-call-${seed}`)], 1));
    }
  }
  const records = [{ resourceSpans: [{
    resource: { attributes: [
      textAttribute('service.name', 'copilot-chat'),
      textAttribute('session.id', 'demo-window'),
      textAttribute('copilot_insights.organization.id', 'synthetic-demo'),
    ] },
    scopeSpans: [{ scope: { name: 'copilot-chat' }, spans }],
  }] }];
  const input = normalizeRecords(records, 'synthetic-demo');
  const projects = ['sample-alpha', 'sample-beta'];
  for (const span of input.spans) {
    const bucket = Number.parseInt(span.traceId.slice(0, 4), 16) % 3;
    span.sessionId = `demo-window-${bucket}`;
    span.projectKey = describeProject(input.organizationId, projects[bucket] ?? null).id;
    span.attribution = bucket < 2 ? 'synthetic-example' : 'unattributed';
  }
  return { ...input, projects, pendingRecord: false, missing: false };
}
