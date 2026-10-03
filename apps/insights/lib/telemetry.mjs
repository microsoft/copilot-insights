import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { AppError } from './errors.mjs';

export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

function collection(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError('invalid-telemetry', 'A complete telemetry record has an unsupported collection shape.');
  return value;
}

function attribute(attributes, key) {
  if (!Array.isArray(attributes)) return null;
  const value = attributes.find((entry) => entry?.key === key)?.value;
  return value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? null;
}

function identifier(value, length) {
  return typeof value === 'string' && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value) && !/^0+$/.test(value)
    ? value.toLowerCase() : null;
}

function label(value) {
  return typeof value === 'string' && value !== 'redacted' && /^[a-zA-Z0-9][a-zA-Z0-9._/+\-]{0,127}$/.test(value)
    ? value : 'Unknown';
}

function tokenCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function milliseconds(value) {
  if (typeof value !== 'string' || !/^\d{1,22}$/.test(value)) return null;
  const time = Number(BigInt(value) / 1_000_000n);
  return time > 0 && time <= 8_640_000_000_000_000 ? time : null;
}

function outcome(span) {
  const error = attribute(span.attributes, 'error.type');
  if (typeof error === 'string' && /^(cancelled|canceled|abort|aborted|cancellation)$/i.test(error)) return 'cancelled';
  if (span.status?.code === 2 || span.status?.code === 'STATUS_CODE_ERROR') return 'error';
  if (typeof error === 'string' && error.length > 0 && error !== 'redacted') return 'error';
  if (span.status?.code === 1 || span.status?.code === 'STATUS_CODE_OK') return 'ok';
  return 'unknown';
}

function normalizeSpan(span, resource, scope, organizationId) {
  const service = attribute(resource?.attributes, 'service.name');
  const organization = attribute(resource?.attributes, 'copilot_insights.organization.id');
  if (service !== 'copilot-chat' || organization !== organizationId || scope?.name !== 'copilot-chat') return null;
  const operation = attribute(span.attributes, 'gen_ai.operation.name');
  if (!['invoke_agent', 'chat', 'execute_tool'].includes(operation)) return null;
  const traceId = identifier(span.traceId, 32);
  const spanId = identifier(span.spanId, 16);
  const parentSpanId = identifier(span.parentSpanId, 16);
  const startedAt = milliseconds(span.startTimeUnixNano);
  const endedAt = milliseconds(span.endTimeUnixNano);
  if (!traceId || !spanId || (!startedAt && !endedAt) || (span.parentSpanId && !parentSpanId)) return null;
  const config = attribute(resource?.attributes, 'copilot_insights.config.version');
  return {
    id: fingerprint([organizationId, service, scope.name, traceId, spanId]),
    traceId,
    spanId,
    parentSpanId,
    operation,
    timestamp: endedAt ?? startedAt,
    durationMs: startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null,
    model: operation === 'chat' ? label(attribute(span.attributes, 'gen_ai.request.model')) : null,
    tool: operation === 'execute_tool' ? label(attribute(span.attributes, 'gen_ai.tool.name')) : null,
    inputTokens: operation === 'chat' ? tokenCount(attribute(span.attributes, 'gen_ai.usage.input_tokens')) : null,
    outputTokens: operation === 'chat' ? tokenCount(attribute(span.attributes, 'gen_ai.usage.output_tokens')) : null,
    outcome: outcome(span),
    fixtureTagged: attribute(resource?.attributes, 'service.version') === '0.0.0-verification'
      && typeof config === 'string' && /^verify-[a-f0-9]{32}$/.test(config),
  };
}

export function normalizeRecords(records, organizationId = 'local-dev') {
  const spans = new Map();
  const conflicts = new Set();
  const quality = { duplicateSpans: 0, conflictingSpans: 0, excludedSpans: 0, metricRecords: 0, logRecords: 0 };
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new AppError('invalid-telemetry', 'A complete telemetry record has an unsupported shape. No partial totals are shown.');
    }
    for (const group of collection(record.resourceSpans)) {
      for (const scope of collection(group.scopeSpans)) {
        for (const candidate of collection(scope.spans)) {
          const span = normalizeSpan(candidate, group.resource, scope.scope, organizationId);
          if (!span) { quality.excludedSpans++; continue; }
          if (conflicts.has(span.id)) continue;
          const existing = spans.get(span.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(span)) {
            conflicts.add(span.id);
            spans.delete(span.id);
          } else if (existing) {
            quality.duplicateSpans++;
          } else {
            spans.set(span.id, span);
          }
        }
      }
    }
    for (const group of collection(record.resourceMetrics)) {
      if (attribute(group.resource?.attributes, 'copilot_insights.organization.id') !== organizationId) continue;
      for (const scope of collection(group.scopeMetrics)) quality.metricRecords += collection(scope.metrics).length;
    }
    for (const group of collection(record.resourceLogs)) {
      if (attribute(group.resource?.attributes, 'copilot_insights.organization.id') !== organizationId) continue;
      for (const scope of collection(group.scopeLogs)) quality.logRecords += collection(scope.logRecords).length;
    }
  }
  quality.conflictingSpans = conflicts.size;
  return { spans: [...spans.values()], quality };
}

export async function readTelemetry(path, organizationId = 'local-dev') {
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    if (size > MAX_INPUT_BYTES) {
      throw new AppError('input-too-large', 'The local input exceeds the 32 MiB evaluation limit. Rotate the collector output before continuing.');
    }
    const snapshot = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(snapshot, offset, size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const text = snapshot.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, '');
    const boundary = text.lastIndexOf('\n');
    const complete = boundary >= 0 ? text.slice(0, boundary + 1) : '';
    let records;
    try {
      records = complete.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch {
      throw new AppError('invalid-telemetry', 'A complete telemetry record is unreadable. No partial totals are shown.');
    }
    let normalized;
    try { normalized = normalizeRecords(records, organizationId); }
    catch { throw new AppError('invalid-telemetry', 'A complete telemetry record has an unsupported shape. No partial totals are shown.'); }
    return { ...normalized, pendingRecord: boundary < text.length - 1, missing: false };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...normalizeRecords([], organizationId), pendingRecord: false, missing: true };
    if (error instanceof AppError) throw error;
    throw new AppError('telemetry-unavailable', 'The local telemetry input cannot be read. Check the collector and its read-only mount.');
  } finally {
    await file?.close();
  }
}
