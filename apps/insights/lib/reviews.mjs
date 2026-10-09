import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROJECT_KEY_PATTERN } from './context.mjs';
import { AppError } from './errors.mjs';

export const REVIEW_STATUSES = ['unreviewed', 'investigating', 'reviewed', 'dismissed'];
export const MAX_DECISIONS = 2000;

export class ReviewStore {
  constructor(path) {
    this.path = path;
    this.decisions = new Map();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const text = await readFile(this.path, 'utf8');
      if (text.length > 2 * 1024 * 1024) throw new Error('Oversized state');
      const data = JSON.parse(text);
      if (![1, 2, 3, 4, 5].includes(data.version) || !Array.isArray(data.decisions) || data.decisions.length > MAX_DECISIONS) throw new Error('Invalid state');
      for (const decision of data.decisions) {
        if (!/^[a-f0-9]{24}$/.test(decision.id) || !REVIEW_STATUSES.includes(decision.status)
          || !['local', 'demo'].includes(decision.source) || !Number.isSafeInteger(decision.revision)
          || decision.revision < 1 || !Number.isFinite(Date.parse(decision.updatedAt))) throw new Error('Invalid decision');
        if (data.version >= 2 && decision.organizationId !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(decision.organizationId ?? '')) throw new Error('Invalid organization');
        if (data.version === 3 && decision.engagementKey !== null && !/^(all|unattributed|eng-[a-f0-9]{24})$/.test(decision.engagementKey ?? '')) throw new Error('Invalid scope');
        if (data.version >= 4 && decision.projectKey !== null && !PROJECT_KEY_PATTERN.test(decision.projectKey ?? '')) throw new Error('Invalid project');
        if (data.version === 5 && decision.evidence !== null && !(Number.isSafeInteger(decision.evidence?.count) && decision.evidence.count >= 0
          && (decision.evidence.latestAt === null || Number.isSafeInteger(decision.evidence.latestAt)))) throw new Error('Invalid evidence');
        this.decisions.set(decision.id, {
          id: decision.id, source: decision.source, status: decision.status,
          organizationId: data.version === 1 ? null : decision.organizationId,
          projectKey: data.version < 4 ? null : decision.projectKey,
          evidence: data.version < 5 ? null : decision.evidence,
          revision: decision.revision, updatedAt: decision.updatedAt,
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new AppError('review-storage-unavailable', 'Review state cannot be read. Restore or explicitly reset the local review volume.');
    }
  }

  get(id, organizationId, projectKey) {
    const decision = this.decisions.get(id);
    return decision && (organizationId === undefined || decision.organizationId === organizationId)
      && (projectKey === undefined || decision.projectKey === projectKey) ? { status: decision.status, revision: decision.revision, updatedAt: decision.updatedAt, evidence: decision.evidence }
      : { status: 'unreviewed', revision: 0, updatedAt: null, evidence: null };
  }

  update(id, source, status, expectedRevision, organizationId = null, projectKey = null, evidence = null) {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (this.get(id, organizationId, projectKey).revision !== expectedRevision) {
        throw new AppError('review-conflict', 'This decision changed. Refresh the evidence before saving again.', 409);
      }
      const decision = { id, source, organizationId, projectKey, evidence, status, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
      const next = new Map(this.decisions);
      next.set(id, decision);
      const retained = [...next.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, MAX_DECISIONS);
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(`${this.path}.tmp`, JSON.stringify({ version: 5, decisions: retained }), { mode: 0o600 });
        await rename(`${this.path}.tmp`, this.path);
      } catch {
        throw new AppError('review-write-failed', 'The decision was not saved. Check the writable local review volume.');
      }
      this.decisions = new Map(retained.map((entry) => [entry.id, entry]));
      return this.get(id);
    });
    this.queue = operation;
    return operation;
  }
}
