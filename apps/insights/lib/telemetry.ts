import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { AppError } from './errors.ts';
import type { Feedback, InputQuality, NormalizedTelemetry, Outcome, Span, TelemetryInput } from './types.ts';

export const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024 * 1024;
const CHECK_BYTES = 4096;
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

// Untrusted OTLP/JSON shapes: every field is validated where it is read.
interface Resource { attributes?: unknown }
interface Scope { name?: unknown }
interface OtlpSpan {
  traceId?: unknown; spanId?: unknown; parentSpanId?: unknown; startTimeUnixNano?: unknown; endTimeUnixNano?: unknown;
  attributes?: unknown; status?: { code?: unknown };
}
interface LogRecord { timeUnixNano?: unknown; observedTimeUnixNano?: unknown; traceId?: unknown; spanId?: unknown; attributes?: unknown }
interface ResourceSpans { resource?: Resource; scopeSpans?: unknown }
interface ScopeSpans { scope?: Scope; spans?: unknown }
interface ResourceMetrics { resource?: Resource; scopeMetrics?: unknown }
interface ScopeMetrics { metrics?: unknown }
interface ResourceLogs { resource?: Resource; scopeLogs?: unknown }
interface ScopeLogs { scope?: Scope; logRecords?: unknown }
interface OtlpRecord { resourceSpans?: unknown; resourceMetrics?: unknown; resourceLogs?: unknown }

interface ReaderState {
  spans: Map<string, Span>;
  feedback: Map<string, Feedback>;
  conflicts: Set<string>;
  quality: InputQuality;
}

interface Reader {
  ino: number;
  dev: number;
  offset: number;
  check: Buffer;
  state: ReaderState;
}

function collection<T>(value: unknown): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError('invalid-telemetry', 'A complete telemetry record has an unsupported collection shape.');
  return value;
}

function attribute(attributes: unknown, key: string): unknown {
  if (!Array.isArray(attributes)) return null;
  const value = attributes.find((entry) => entry?.key === key)?.value;
  return value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? null;
}

function identifier(value: unknown, length: number): string | null {
  return typeof value === 'string' && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value) && !/^0+$/.test(value)
    ? value.toLowerCase() : null;
}

function label(value: unknown): string {
  return typeof value === 'string' && value !== 'redacted' && /^[a-zA-Z0-9][a-zA-Z0-9._/+\-]{0,127}$/.test(value)
    ? value : 'Unknown';
}

function correlationId(value: unknown): string | null {
  return typeof value === 'string' && value !== 'redacted' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) ? value : null;
}

function tokenCount(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function milliseconds(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,22}$/.test(value)) return null;
  const time = Number(BigInt(value) / 1_000_000n);
  return time > 0 && time <= 8_640_000_000_000_000 ? time : null;
}

function outcome(span: OtlpSpan): Outcome {
  const error = attribute(span.attributes, 'error.type');
  if (typeof error === 'string' && /^(cancelled|canceled|abort|aborted|cancellation)$/i.test(error)) return 'cancelled';
  if (span.status?.code === 2 || span.status?.code === 'STATUS_CODE_ERROR') return 'error';
  if (typeof error === 'string' && error.length > 0 && error !== 'redacted') return 'error';
  if (span.status?.code === 1 || span.status?.code === 'STATUS_CODE_OK') return 'ok';
  return 'unknown';
}

function normalizeSpan(span: OtlpSpan, resource: Resource | undefined, scope: Scope | undefined, organizationId: string): Span | null {
  const service = attribute(resource?.attributes, 'service.name');
  const organization = attribute(resource?.attributes, 'copilot_insights.organization.id');
  if (service !== 'copilot-chat' || organization !== organizationId || scope?.name !== 'copilot-chat') return null;
  const operation = attribute(span.attributes, 'gen_ai.operation.name');
  if (operation !== 'invoke_agent' && operation !== 'chat' && operation !== 'execute_tool') return null;
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
    sessionId: correlationId(attribute(resource?.attributes, 'session.id')),
    conversationId: correlationId(attribute(span.attributes, 'gen_ai.conversation.id')),
    toolCallId: correlationId(attribute(span.attributes, 'gen_ai.tool.call.id')),
    operation,
    startedAt,
    timestamp: endedAt ?? startedAt!,
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

const emptyState = (): ReaderState => ({ spans: new Map(), feedback: new Map(), conflicts: new Set(),
  quality: { duplicateSpans: 0, conflictingSpans: 0, excludedSpans: 0, metricRecords: 0, logRecords: 0 } });

export function normalizeRecords(records: readonly unknown[], organizationId = 'local-dev', state = emptyState()): NormalizedTelemetry {
  const { spans, feedback, conflicts, quality } = state;
  for (const record of records as readonly OtlpRecord[]) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new AppError('invalid-telemetry', 'A complete telemetry record has an unsupported shape. No partial totals are shown.');
    }
    for (const group of collection<ResourceSpans>(record.resourceSpans)) {
      if (attribute(group.resource?.attributes, 'copilot_insights.organization.id') !== organizationId) continue;
      for (const scope of collection<ScopeSpans>(group.scopeSpans)) {
        for (const candidate of collection<OtlpSpan>(scope.spans)) {
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
    for (const group of collection<ResourceMetrics>(record.resourceMetrics)) {
      if (attribute(group.resource?.attributes, 'copilot_insights.organization.id') !== organizationId) continue;
      for (const scope of collection<ScopeMetrics>(group.scopeMetrics)) quality.metricRecords += collection(scope.metrics).length;
    }
    for (const group of collection<ResourceLogs>(record.resourceLogs)) {
      if (attribute(group.resource?.attributes, 'copilot_insights.organization.id') !== organizationId) continue;
      for (const scope of collection<ScopeLogs>(group.scopeLogs)) {
        for (const log of collection<LogRecord>(scope.logRecords)) {
          quality.logRecords++;
          if (attribute(group.resource?.attributes, 'service.name') !== 'copilot-chat' || scope.scope?.name !== 'copilot-chat') continue;
          const name = attribute(log.attributes, 'event.name');
          const timestamp = milliseconds(log.timeUnixNano) ?? milliseconds(log.observedTimeUnixNano);
          if ((name !== 'copilot_chat.user.feedback' && name !== 'copilot_chat.edit.feedback') || timestamp === null) continue;
          const traceId = identifier(log.traceId, 32);
          const spanId = identifier(log.spanId, 16);
          if ((log.traceId != null && log.traceId !== '' && !traceId)
            || (log.spanId != null && log.spanId !== '' && (!spanId || !traceId))) continue;
          const item: Feedback = {
            name, timestamp,
            conversationId: correlationId(attribute(log.attributes, 'conversation_id') ?? attribute(log.attributes, 'gen_ai.conversation.id')),
            sessionId: correlationId(attribute(group.resource?.attributes, 'session.id')),
            traceId,
            spanId,
          };
          feedback.set(fingerprint([organizationId, item]), item);
        }
      }
    }
  }
  return { organizationId, spans: [...spans.values()], feedback: [...feedback.values()], quality: { ...quality, conflictingSpans: conflicts.size } };
}

async function readRange(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

// Parsed state per file and organization, so each request reads only records appended since the last one.
const readers = new Map<string, Reader>();
const pending = new Map<string, Promise<unknown>>();

async function refresh(path: string, organizationId: string, key: string): Promise<TelemetryInput> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, 'r');
    const { size, ino, dev } = await file.stat();
    if (size > MAX_INPUT_BYTES) {
      throw new AppError('input-too-large', 'The local input exceeds the 256 MiB evaluation limit. Archive the collector output before continuing.');
    }
    let reader = readers.get(key);
    readers.delete(key);
    if (!reader || reader.ino !== ino || reader.dev !== dev || size < reader.offset
      || !(await readRange(file, reader.offset - reader.check.length, reader.check.length)).equals(reader.check)) {
      reader = { ino, dev, offset: 0, check: Buffer.alloc(0), state: emptyState() };
    }
    let length = Math.min(CHUNK_BYTES, size - reader.offset);
    while (length > 0) {
      const chunk = await readRange(file, reader.offset, length);
      const boundary = chunk.lastIndexOf(10);
      if (boundary < 0) {
        if (reader.offset + chunk.length >= size) break;
        length = Math.min(length * 2, size - reader.offset);
        continue;
      }
      let text = chunk.subarray(0, boundary + 1).toString('utf8');
      if (reader.offset === 0) text = text.replace(/^\uFEFF/, '');
      let records: unknown[];
      try {
        records = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      } catch {
        throw new AppError('invalid-telemetry', 'A complete telemetry record is unreadable. No partial totals are shown.');
      }
      try { normalizeRecords(records, organizationId, reader.state); }
      catch { throw new AppError('invalid-telemetry', 'A complete telemetry record has an unsupported shape. No partial totals are shown.'); }
      reader.offset += boundary + 1;
      length = Math.min(CHUNK_BYTES, size - reader.offset);
    }
    reader.check = await readRange(file, Math.max(0, reader.offset - CHECK_BYTES), Math.min(CHECK_BYTES, reader.offset));
    readers.set(key, reader);
    return { ...normalizeRecords([], organizationId, reader.state), pendingRecord: reader.offset < size, missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...normalizeRecords([], organizationId), pendingRecord: false, missing: true };
    if (error instanceof AppError) throw error;
    throw new AppError('telemetry-unavailable', 'The local telemetry input cannot be read. Check the collector and its read-only mount.');
  } finally {
    await file?.close();
  }
}

export function readTelemetry(path: string, organizationId = 'local-dev'): Promise<TelemetryInput> {
  const key = JSON.stringify([path, organizationId]);
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => refresh(path, organizationId, key));
  pending.set(key, result);
  return result;
}
