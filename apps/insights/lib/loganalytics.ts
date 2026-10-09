import { AppError } from './errors.ts';
import { normalizeRecords } from './telemetry.ts';
import type { TelemetryInput } from './types.ts';

export interface QueryTable {
  columns: { name: string }[];
  rows: unknown[][];
}

export type Fetcher = (url: string | URL, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

interface SourceOptions {
  workspaceId: unknown;
  clientId?: string;
  environment?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  clock?: () => number;
  endpoint?: string;
}

// Reads the collector's Azure Monitor export back into the same records the file adapter normalizes.
// Mapping follows the pinned azure_monitor exporter (0.161): span and resource attributes, the scope name
// (instrumentationlibrary.name), and the span status (otel.status_code) are stored together in Properties.
export const LOG_ANALYTICS_RESOURCE = 'https://api.loganalytics.io';
const LOOKBACK = 'P32D';
const CACHE_MS = 60_000;
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const organizationPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const unavailable = () => new AppError('telemetry-unavailable',
  'Azure Monitor could not be queried. Check the portal identity, its Log Analytics Reader assignment, and private network access.');

export function spanQuery(organizationId: string): string {
  return `union isfuzzy=true withsource=SourceTable AppDependencies, AppRequests, AppTraces
| where tostring(Properties['copilot_insights.organization.id']) == '${organizationId}'
| where SourceTable != 'AppTraces' or tostring(Properties['event.name']) in ('copilot_chat.user.feedback', 'copilot_chat.edit.feedback')
| project SourceTable, TimeGenerated, Id, OperationId, ParentId, DurationMs, Properties`;
}

export function countQuery(organizationId: string): string {
  return `union isfuzzy=true withsource=SourceTable AppTraces, AppMetrics
| where tostring(Properties['copilot_insights.organization.id']) == '${organizationId}'
| summarize Records = count() by SourceTable`;
}

function nanos(value: unknown): bigint | null {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  const seconds = match ? Date.parse(`${match[1]}Z`) : NaN;
  return match && Number.isFinite(seconds) ? BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0')) : null;
}

function bag(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('invalid-telemetry', 'A stored telemetry row has an unsupported shape. No partial totals are shown.');
  }
  return parsed as Record<string, unknown>;
}

const rowsOf = (table: QueryTable): Record<string, unknown>[] =>
  table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]])));

export function rowsToRecords(table: QueryTable): object[] {
  return rowsOf(table).map((row) => {
    const properties = bag(row.Properties);
    const attributes = Object.entries(properties).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
    const resource = { attributes };
    const scope = { name: properties['instrumentationlibrary.name'] };
    const start = nanos(row.TimeGenerated);
    if (row.SourceTable === 'AppTraces') {
      return { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [{
        timeUnixNano: start?.toString(), traceId: row.OperationId || undefined, spanId: row.ParentId || undefined, attributes,
      }] }] }] };
    }
    const duration = row.DurationMs as number;
    return { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [{
      traceId: row.OperationId,
      spanId: row.Id,
      // Root spans can carry an empty parent or the operation ID itself.
      ...(row.ParentId && row.ParentId !== row.OperationId ? { parentSpanId: row.ParentId } : {}),
      startTimeUnixNano: start?.toString(),
      ...(start !== null && Number.isFinite(duration) && duration >= 0 ? { endTimeUnixNano: (start + BigInt(Math.round(duration * 1e6))).toString() } : {}),
      status: { code: properties['otel.status_code'] },
      attributes,
    }] }] }] };
  });
}

export function logAnalyticsSource({ workspaceId, clientId, environment = process.env, fetcher = fetch, clock = Date.now,
  endpoint = LOG_ANALYTICS_RESOURCE }: SourceOptions): (organizationId: string) => Promise<TelemetryInput> {
  if (typeof workspaceId !== 'string' || !guid.test(workspaceId)) {
    throw new AppError('invalid-configuration', 'INSIGHTS_LOG_ANALYTICS_WORKSPACE_ID must be the usage workspace ID (a GUID).');
  }
  let token: { value: string; expiresAt: number } | null = null;
  let tokenRequest: Promise<string> | null = null;
  const cache = new Map<string, { expiresAt: number; result: Promise<TelemetryInput> }>();

  function accessToken(): string | Promise<string> {
    if (token && token.expiresAt - 300_000 > clock()) return token.value;
    tokenRequest ??= requestToken().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }

  async function requestToken(): Promise<string> {
    if (!environment.IDENTITY_ENDPOINT || !environment.IDENTITY_HEADER) {
      throw new AppError('telemetry-unavailable', 'Log Analytics queries need the portal\'s managed identity. Run it in Azure Container Apps with that identity assigned.');
    }
    const url = new URL(environment.IDENTITY_ENDPOINT);
    url.searchParams.set('api-version', '2019-08-01');
    url.searchParams.set('resource', endpoint);
    if (clientId) url.searchParams.set('client_id', clientId);
    const response = await fetcher(url, { headers: { 'X-IDENTITY-HEADER': environment.IDENTITY_HEADER }, signal: AbortSignal.timeout(10_000) });
    const body = response.ok ? await response.json() : null;
    const expiresAt = Number(body?.expires_on) * 1000;
    if (typeof body?.access_token !== 'string' || !Number.isFinite(expiresAt)) throw unavailable();
    token = { value: body.access_token, expiresAt };
    return token.value;
  }

  async function query(text: string): Promise<QueryTable> {
    const response = await fetcher(`${endpoint}/v1/workspaces/${workspaceId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text, timespan: LOOKBACK }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = response.ok ? await response.json() : null;
    const table = body?.tables?.[0];
    // A partial result (row/size limit or timeout) arrives as HTTP 200 with an error; never show it as a total.
    if (!table || body.error || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw unavailable();
    return table;
  }

  async function load(organizationId: string): Promise<TelemetryInput> {
    if (!organizationPattern.test(organizationId)) throw new AppError('invalid-organization', 'The organization ID is not valid.');
    try {
      const [rows, counts] = await Promise.all([query(spanQuery(organizationId)), query(countQuery(organizationId))]);
      const totals = Object.fromEntries(rowsOf(counts).map((row) => [row.SourceTable, Number(row.Records)]));
      const input = normalizeRecords(rowsToRecords(rows), organizationId);
      return { ...input, quality: { ...input.quality, logRecords: totals.AppTraces ?? 0, metricRecords: totals.AppMetrics ?? 0, backend: 'log-analytics' },
        pendingRecord: false, missing: false };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }

  return (organizationId) => {
    const cached = cache.get(organizationId);
    if (cached && cached.expiresAt > clock()) return cached.result;
    const result = load(organizationId);
    cache.set(organizationId, { expiresAt: clock() + CACHE_MS, result });
    result.catch(() => { if (cache.get(organizationId)?.result === result) cache.delete(organizationId); });
    return result;
  };
}
