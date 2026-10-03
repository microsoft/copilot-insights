import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
      if (![1, 2].includes(data.version) || !Array.isArray(data.decisions) || data.decisions.length > MAX_DECISIONS) throw new Error('Invalid state');
      for (const decision of data.decisions) {
        if (!/^[a-f0-9]{24}$/.test(decision.id) || !REVIEW_STATUSES.includes(decision.status)
          || !['local', 'demo'].includes(decision.source) || !Number.isSafeInteger(decision.revision)
          || decision.revision < 1 || !Number.isFinite(Date.parse(decision.updatedAt))) throw new Error('Invalid decision');
        if (data.version === 2 && decision.organizationId !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(decision.organizationId ?? '')) throw new Error('Invalid organization');
        this.decisions.set(decision.id, {
          id: decision.id, source: decision.source, status: decision.status,
          organizationId: data.version === 1 ? null : decision.organizationId,
          revision: decision.revision, updatedAt: decision.updatedAt,
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new AppError('review-storage-unavailable', 'Review state cannot be read. Restore or explicitly reset the local review volume.');
    }
  }

  get(id, organizationId) {
    const decision = this.decisions.get(id);
    return decision && (organizationId === undefined || decision.organizationId === organizationId) ? { status: decision.status, revision: decision.revision, updatedAt: decision.updatedAt }
      : { status: 'unreviewed', revision: 0, updatedAt: null };
  }

  update(id, source, status, expectedRevision, organizationId = null) {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (this.get(id, organizationId).revision !== expectedRevision) {
        throw new AppError('review-conflict', 'This decision changed. Refresh the evidence before saving again.', 409);
      }
      const decision = { id, source, organizationId, status, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
      const next = new Map(this.decisions);
      next.set(id, decision);
      const retained = [...next.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, MAX_DECISIONS);
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(`${this.path}.tmp`, JSON.stringify({ version: 2, decisions: retained }), { mode: 0o600 });
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
