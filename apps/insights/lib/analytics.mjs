import { fingerprint } from './telemetry.mjs';
import { AppError } from './errors.mjs';

const DAY = 86_400_000;
const ratio = (part, total) => total ? part / total : null;
const sumKnown = (values) => {
  const known = values.filter((value) => value !== null);
  if (!known.length) return null;
  const total = known.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new AppError('unsafe-aggregate', 'Token totals exceed exact integer precision. No partial totals are shown.');
  return total;
};

export function percentile(values, fraction = 0.95) {
  const known = values.filter((value) => value !== null).sort((left, right) => left - right);
  return known.length ? known[Math.max(0, Math.ceil(known.length * fraction) - 1)] : null;
}

function modelStats(calls) {
  const complete = calls.filter((span) => span.inputTokens !== null && span.outputTokens !== null).length;
  return {
    calls: calls.length,
    inputTokens: sumKnown(calls.map((span) => span.inputTokens)),
    outputTokens: sumKnown(calls.map((span) => span.outputTokens)),
    totalTokens: sumKnown(calls.flatMap((span) => [span.inputTokens, span.outputTokens])),
    completeTokenCalls: complete,
    tokenCoverage: ratio(complete, calls.length),
    p95Ms: percentile(calls.map((span) => span.durationMs)),
    durationCalls: calls.filter((span) => span.durationMs !== null).length,
    errors: calls.filter((span) => span.outcome === 'error').length,
    unknownOutcomes: calls.filter((span) => span.outcome === 'unknown').length,
  };
}

function breakdown(spans, field) {
  const groups = new Map();
  for (const span of spans) {
    if (!groups.has(span[field])) groups.set(span[field], []);
    groups.get(span[field]).push(span);
  }
  return [...groups.entries()].map(([name, calls]) => ({ name, ...modelStats(calls) }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

export function composeInsights(input, { source = 'local', days = 7, now = Date.now() } = {}) {
  const organizationId = input.organizationId ?? 'local-dev';
  const today = Math.floor(now / DAY) * DAY;
  const from = today - (days - 1) * DAY;
  const eligible = input.spans.filter((span) => span.timestamp <= now);
  const spans = eligible.filter((span) => span.timestamp >= from).sort((left, right) => left.id.localeCompare(right.id));
  const calls = spans.filter((span) => span.operation === 'chat');
  const tools = spans.filter((span) => span.operation === 'execute_tool');
  const latestTimestamp = eligible.reduce((latest, span) => Math.max(latest ?? 0, span.timestamp), null);
  const stats = modelStats(calls);
  const errors = calls.filter((span) => span.outcome === 'error');
  const unknown = calls.filter((span) => span.outcome === 'unknown');
  const missingTokens = calls.filter((span) => span.inputTokens === null || span.outputTokens === null);
  const slow = calls.filter((span) => span.durationMs !== null && span.durationMs > 5000);
  const snapshotId = fingerprint([organizationId, source, days, today, spans, latestTimestamp]);
  const spanKeys = new Set(spans.map((span) => `${span.traceId}:${span.spanId}`));
  const traceIds = new Set(spans.map((span) => span.traceId));
  const conversationIds = new Set(spans.filter((span) => span.conversationId).map((span) => span.conversationId));
  const sessionConversations = new Set(spans.filter((span) => span.sessionId && span.conversationId)
    .map((span) => JSON.stringify([span.sessionId, span.conversationId])));
  const feedback = (input.feedback ?? []).filter((item) => item.timestamp >= from && item.timestamp <= now);
  const matchedFeedback = feedback.filter((item) => item.traceId
    ? item.spanId ? spanKeys.has(`${item.traceId}:${item.spanId}`) : traceIds.has(item.traceId)
    : item.conversationId && (item.sessionId
      ? sessionConversations.has(JSON.stringify([item.sessionId, item.conversationId]))
      : conversationIds.has(item.conversationId)));
  const traceGroups = new Map();
  for (const span of spans) {
    const group = traceGroups.get(span.traceId) ?? { traceId: span.traceId, spans: 0, linkedChildren: 0, latestTimestamp: span.timestamp };
    group.spans++;
    if (span.parentSpanId && spanKeys.has(`${span.traceId}:${span.parentSpanId}`)) group.linkedChildren++;
    group.latestTimestamp = Math.max(group.latestTimestamp, span.timestamp);
    traceGroups.set(span.traceId, group);
  }
  const findings = [];
  const addFinding = (kind, details, evidence) => {
    findings.push({
      id: fingerprint([snapshotId, kind, details.observed]),
      kind,
      ...details,
      evidenceCount: evidence.length,
      evidence: [...evidence].sort((left, right) => right.timestamp - left.timestamp).slice(0, 8),
      review: { status: 'unreviewed', revision: 0, updatedAt: null },
    });
  };
  if (errors.length) addFinding('model-errors', {
    category: 'Reliability', priority: errors.length >= 3 && errors.length / calls.length >= 0.1 ? 'high' : 'medium',
    title: 'Model calls reported errors',
    description: `${errors.length} of ${calls.length} model calls have an explicit error signal.`,
    observed: `${(errors.length / calls.length * 100).toFixed(1)}% reported error rate`,
    rule: 'At least one model span has an error status or error classification. Cancelled and unknown outcomes are separate.',
    guidance: 'Inspect the affected calls in context. Check for intentional test failures before deciding that intervention is needed.',
  }, errors);
  if (stats.p95Ms !== null && stats.p95Ms > 5000) addFinding('model-latency', {
    category: 'Latency', priority: 'medium',
    title: 'The slowest model calls need context',
    description: `P95 model latency is ${(stats.p95Ms / 1000).toFixed(1)} seconds across ${stats.durationCalls} timed calls.`,
    observed: `${slow.length} calls over 5 seconds`,
    rule: 'Nearest-rank P95 model duration exceeds 5 seconds. This is an evaluation threshold, not a production SLO.',
    guidance: 'Review the model mix and operation context before interpreting latency. Small samples are not a reliable performance baseline.',
  }, slow);
  if (missingTokens.length) addFinding('token-coverage', {
    category: 'Coverage', priority: 'medium',
    title: 'Token totals have incomplete coverage',
    description: `${missingTokens.length} model calls are missing input or output token counts.`,
    observed: `${stats.completeTokenCalls} of ${calls.length} calls report both counts`,
    rule: 'At least one model call lacks a nonnegative, safe-integer input or output token count. Missing values remain unknown.',
    guidance: 'Treat the token total as observed consumption only. Validate emitter coverage before using it for comparisons or estimates.',
  }, missingTokens);
  if (unknown.length) addFinding('unknown-outcomes', {
    category: 'Coverage', priority: 'low',
    title: 'Some call outcomes are unknown',
    description: `${unknown.length} model calls report neither an explicit outcome nor an error.`,
    observed: `${unknown.length} unknown outcomes`,
    rule: 'An unset status with no classified error is unknown, not successful. An OK span is not proof of task completion either.',
    guidance: 'Check the exporter semantics. Do not turn the absence of errors into a success or productivity claim.',
  }, unknown);
  const stale = latestTimestamp !== null && now - latestTimestamp > 15 * 60_000;
  if (source === 'local' && stale) addFinding('stale-data', {
    category: 'Freshness', priority: 'low',
    title: 'The collector data is not recent',
    description: 'No accepted span has arrived with a timestamp in the last 15 minutes.',
    observed: `Latest span: ${new Date(latestTimestamp).toISOString()}`,
    rule: 'The most recent accepted span timestamp is older than 15 minutes. This does not prove that collection is broken.',
    guidance: 'Check whether the source is idle or synthetic verification has stopped. Refresh after sending another approved sample.',
  }, eligible.filter((span) => span.timestamp === latestTimestamp));
  if (input.quality.conflictingSpans) addFinding('conflicting-spans', {
    category: 'Coverage', priority: 'high',
    title: 'Conflicting replays were excluded',
    description: `${input.quality.conflictingSpans} span identities have conflicting normalized values.`,
    observed: `${input.quality.conflictingSpans} identities excluded from totals`,
    rule: 'Identical replays are counted once; all variants of a conflicting identity are excluded rather than choosing a value.',
    guidance: 'Investigate the exporter or file before relying on the remaining totals. Raw conflicting records are not exposed here.',
  }, []);
  const priority = { high: 0, medium: 1, low: 2 };
  findings.sort((left, right) => priority[left.priority] - priority[right.priority]);
  const trend = Array.from({ length: days }, (_, index) => {
    const timestamp = from + index * DAY;
    const bucket = calls.filter((span) => span.timestamp >= timestamp && span.timestamp < timestamp + DAY);
    return { date: new Date(timestamp).toISOString().slice(0, 10), ...modelStats(bucket) };
  });
  return {
    schemaVersion: 1,
    source,
    organizationId,
    generatedAt: new Date(now).toISOString(),
    snapshotId,
    window: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    summary: {
      ...stats,
      agentRuns: spans.filter((span) => span.operation === 'invoke_agent' && !span.parentSpanId).length,
      nestedAgentRuns: spans.filter((span) => span.operation === 'invoke_agent' && span.parentSpanId).length,
      toolCalls: tools.length,
      errorRate: ratio(errors.length, calls.length),
      cancelledCalls: calls.filter((span) => span.outcome === 'cancelled').length,
      knownOutcomeCoverage: ratio(calls.length - unknown.length, calls.length),
    },
    trend,
    models: breakdown(calls, 'model'),
    tools: breakdown(tools, 'tool'),
    findings,
    correlation: {
      traces: traceGroups.size,
      linkedChildSpans: [...traceGroups.values()].reduce((total, group) => total + group.linkedChildren, 0),
      spansWithParent: spans.filter((span) => span.parentSpanId).length,
      conversations: new Set(spans.map((span) => span.conversationId).filter(Boolean)).size,
      sessions: new Set(spans.map((span) => span.sessionId).filter(Boolean)).size,
      spansWithConversationId: spans.filter((span) => span.conversationId).length,
      spansWithSessionId: spans.filter((span) => span.sessionId).length,
      toolCallsWithId: tools.filter((span) => span.toolCallId).length,
      feedbackLogs: feedback.length,
      matchedFeedbackLogs: matchedFeedback.length,
      recentTraces: [...traceGroups.values()].sort((left, right) => right.latestTimestamp - left.latestTimestamp).slice(0, 5),
    },
    quality: {
      ...input.quality,
      acceptedSpans: spans.length,
      futureSpans: input.spans.length - eligible.length,
      fixtureTaggedSpans: spans.filter((span) => span.fixtureTagged).length,
      pendingRecord: input.pendingRecord,
      missing: input.missing,
      latestTimestamp: latestTimestamp === null ? null : new Date(latestTimestamp).toISOString(),
      stale,
      smallSample: calls.length > 0 && calls.length < 20,
    },
  };
}
