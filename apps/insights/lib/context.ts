import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from './errors.ts';
import { fingerprint } from './telemetry.ts';
import type { Feedback, NormalizedTelemetry, ProjectEntry, Span } from './types.ts';

interface WindowBinding {
  sessionId: string;
  organizationId: string;
  ownerId: string;
  project: string | null;
  registeredAt: number;
  renewedAt: number;
  closedAt: number | null;
}

export interface Registration {
  sessionId: string;
  registeredAt: number | null;
  closedAt: number | null;
  project: ProjectEntry;
  status: 'active' | 'unattributed' | 'reload-required';
}

export const ALL_PROJECTS = 'all';
export const UNATTRIBUTED = 'unattributed';
export const PROJECT_KEY_PATTERN = /^(all|unattributed|prj-[a-f0-9]{24})$/;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const organizationPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DAY = 86_400_000;
const MAX_WINDOWS = 10_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
// Spans older than 31 days are outside every report window; a living window renews its binding at most daily.
const RETENTION_MS = 32 * DAY;
const RENEWAL_MS = DAY;

export function normalizeProject(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new AppError('invalid-project', 'Supply a project ID of 1-128 letters, digits, dots, underscores, or hyphens, or null for unattributed activity.', 400);
  }
  return value;
}

export function describeProject(organizationId: string, project: string | null | undefined): ProjectEntry {
  if (!project) return { id: UNATTRIBUTED, name: 'Unattributed', project: null };
  return { id: `prj-${fingerprint([organizationId, project])}`, name: project, project };
}

export function projectCatalog(input: { organizationId: string; projects?: string[] }, projects: string[] = []): ProjectEntry[] {
  const entries = new Map<string, ProjectEntry>();
  for (const project of [...projects, ...(input.projects ?? [])]) {
    const entry = describeProject(input.organizationId, project);
    if (entry.id !== UNATTRIBUTED) entries.set(entry.id, entry);
  }
  return [
    { id: ALL_PROJECTS, name: 'All projects', project: null },
    describeProject(input.organizationId, null),
    ...[...entries.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
  ];
}

export class WindowContextStore {
  path: string;
  clock: () => number;
  windows: Map<string, WindowBinding>;
  queue: Promise<unknown>;

  constructor(path: string, clock = Date.now) {
    this.path = path;
    this.clock = clock;
    this.windows = new Map();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const text = await readFile(this.path, 'utf8');
      if (text.length > 8 * 1024 * 1024) throw new Error('Oversized state');
      const state = JSON.parse(text);
      if (state.version !== 2 || !Array.isArray(state.windows) || state.windows.length > MAX_WINDOWS) throw new Error('Invalid state');
      for (const entry of state.windows) {
        if (typeof entry.sessionId !== 'string' || !identifierPattern.test(entry.sessionId)
          || typeof entry.organizationId !== 'string' || !organizationPattern.test(entry.organizationId)
          || typeof entry.ownerId !== 'string' || !/^(local|[a-f0-9-]{36}:[a-f0-9-]{36})$/.test(entry.ownerId)
          || !Number.isSafeInteger(entry.registeredAt) || entry.registeredAt < 1 || !Number.isSafeInteger(entry.renewedAt) || entry.renewedAt < 1
          || (entry.closedAt !== null && (!Number.isSafeInteger(entry.closedAt) || entry.closedAt < entry.registeredAt))) throw new Error('Invalid binding');
        const project = normalizeProject(entry.project);
        const key = JSON.stringify([entry.organizationId, entry.sessionId]);
        if (this.windows.has(key)) throw new Error('Duplicate binding');
        this.windows.set(key, { sessionId: entry.sessionId, organizationId: entry.organizationId, ownerId: entry.ownerId,
          project, registeredAt: entry.registeredAt, renewedAt: entry.renewedAt, closedAt: entry.closedAt });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('context-storage-unavailable', 'Window attribution state cannot be read. Restore the context volume before collecting attributed activity.');
    }
  }

  async save(next: Map<string, WindowBinding>) {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, JSON.stringify({ version: 2, windows: [...next.values()] }), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    } catch {
      throw new AppError('context-write-failed', 'Window attribution was not saved. Check the context volume before continuing.');
    }
    this.windows = next;
  }

  register(organizationId: string, sessionId: unknown, value: unknown, clientTime: unknown, ownerId = 'local'): Promise<Registration> {
    if (typeof sessionId !== 'string' || !identifierPattern.test(sessionId)) {
      return Promise.reject(new AppError('invalid-session', 'Supply the native VS Code window session ID.', 400));
    }
    if (typeof clientTime !== 'number' || !Number.isSafeInteger(clientTime)) return Promise.reject(new AppError('invalid-client-time', 'Supply the device time in epoch milliseconds.', 400));
    const project = normalizeProject(value);
    const operation = this.queue.catch(() => {}).then(async (): Promise<Registration> => {
      const now = this.clock();
      if (Math.abs(clientTime - now) > MAX_CLOCK_SKEW_MS) {
        throw new AppError('clock-skew', 'The device clock differs from the Insights service by more than 5 minutes. Synchronize it, then register again.', 400);
      }
      const key = JSON.stringify([organizationId, sessionId]);
      const expired = (entry: WindowBinding) => entry.renewedAt < now - RETENTION_MS;
      const live = () => new Map([...this.windows].filter(([, entry]) => !expired(entry)));
      let binding = this.windows.get(key);
      if (binding && expired(binding)) binding = undefined;
      if (binding && binding.ownerId !== ownerId) throw new AppError('window-owner-required', 'Only the publisher that registered this window can update its lifecycle.', 403);
      if (!binding && !project) {
        return { sessionId, registeredAt: null, closedAt: null, project: describeProject(organizationId, null), status: 'unattributed' };
      }
      if (!binding) {
        const next = live();
        if (next.size >= MAX_WINDOWS) throw new AppError('context-capacity', 'The window registry is full: 10,000 windows with a project contacted this service in the last 32 days.', 503);
        binding = { organizationId, sessionId, ownerId, project, registeredAt: clientTime, renewedAt: now, closedAt: null };
        await this.save(next.set(key, binding));
      } else if (binding.project !== project && binding.closedAt === null) {
        binding = { ...binding, renewedAt: now, closedAt: Math.max(binding.registeredAt, clientTime) };
        await this.save(live().set(key, binding));
      } else if (now - binding.renewedAt >= RENEWAL_MS) {
        binding = { ...binding, renewedAt: now };
        await this.save(live().set(key, binding));
      }
      return {
        sessionId, registeredAt: binding.registeredAt, closedAt: binding.closedAt,
        project: describeProject(organizationId, binding.project),
        status: binding.closedAt !== null ? 'reload-required' : binding.project ? 'active' : 'unattributed',
      };
    });
    this.queue = operation;
    return operation;
  }

  projects(organizationId: string): string[] {
    return [...this.windows.values()].filter((binding) => binding.organizationId === organizationId && binding.project).map((binding) => binding.project!);
  }

  attribute<T extends NormalizedTelemetry>(input: T): T {
    const resolve = <Item extends Span | Feedback>(item: Item, startedAt: number | null): Item => {
      const binding = this.windows.get(JSON.stringify([input.organizationId, item.sessionId]));
      const selected = binding?.project && startedAt !== null && startedAt >= binding.registeredAt
        && item.timestamp >= startedAt && (binding.closedAt === null || item.timestamp < binding.closedAt);
      return {
        ...item,
        projectKey: selected ? describeProject(input.organizationId, binding.project).id : UNATTRIBUTED,
        attribution: selected ? 'window-registration' : 'unattributed',
      };
    };
    return {
      ...input,
      spans: input.spans.map((span) => resolve(span, span.startedAt ?? null)),
      feedback: input.feedback.map((item) => resolve(item, item.timestamp)),
    };
  }
}
