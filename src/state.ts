/**
 * MCPL checkpoints form a tree: rolling back and then writing again branches,
 * and a checkpoint names the state including the write reported with it. So a
 * write is recorded under the checkpoint current when it's made, and a
 * rollback to C undoes what is recorded under C and its descendants.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  POLL_DEDUP_RING,
  POLL_HEAD_MEMORY,
  silentLogger,
  type CheckpointRecord,
  type CheckpointStatus,
  type CreatedComment,
  type EditedComment,
  type Logger,
  type PollCursor,
  type RollbackPlan,
  type StateSnapshot,
  type StateStore,
  type ThreadKind,
} from './types.js';

export const STATE_VERSION = 1;

/**
 * Writes made before any checkpoint. The oldest checkpoint's state includes
 * them, so no rollback undoes them.
 */
export const ROOT_BUCKET = 'root';

export interface ThreadLocator {
  number: number;
  kind: ThreadKind;
}

export interface CreatedCommentRecord extends CreatedComment {
  thread?: ThreadLocator;
}

export interface EditedCommentRecord extends EditedComment {
  thread?: ThreadLocator;
}

/**
 * GitHub has no undelete, so rollback can only report a deleted comment; its
 * body is kept for the receipt.
 */
export interface DeletedCommentRecord {
  repo: string;
  commentId: number;
  previousBody: string;
  review: boolean;
  thread?: ThreadLocator;
}

export type { CheckpointStatus };

export interface CommentRollbackPlan extends RollbackPlan {
  created: CreatedCommentRecord[];
  edited: EditedCommentRecord[];
  deleted: DeletedCommentRecord[];
}

export interface GithubStateStore extends StateStore {
  recordCreatedComment(comment: CreatedCommentRecord): void;
  recordEditedComment(comment: EditedCommentRecord): void;
  recordDeletedComment(comment: DeletedCommentRecord): void;
  rollback(checkpointId: string): CommentRollbackPlan | null;
  checkpointStatus(checkpointId: string): CheckpointStatus;
  snapshot(): GithubStateSnapshot;
}

export interface GithubStateSnapshot extends StateSnapshot {
  version: number;
  created: Record<string, CreatedCommentRecord[]>;
  edited: Record<string, EditedCommentRecord[]>;
  deleted: Record<string, DeletedCommentRecord[]>;
}

export function emptySnapshot(): GithubStateSnapshot {
  return {
    version: STATE_VERSION,
    checkpoints: [],
    current: null,
    created: {},
    edited: {},
    deleted: {},
    lastPollAt: null,
    pollCursors: {},
    pollNew: {},
    pollKeys: [],
    pollHeads: {},
  };
}

export class GithubState implements GithubStateStore {
  private snap: GithubStateSnapshot;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string | null,
    snap: GithubStateSnapshot,
    private readonly logger: Logger,
  ) {
    this.snap = snap;
  }

  static empty(file: string | null = null, logger: Logger = silentLogger()): GithubState {
    return new GithubState(file, emptySnapshot(), logger);
  }

  /**
   * A missing state file starts empty. One that can't be read, isn't JSON or
   * isn't a snapshot this version reads is reported on stderr, and the server
   * starts empty instead of failing to start.
   */
  static load(file: string | null, logger: Logger = silentLogger()): GithubState {
    if (!file) return GithubState.empty(null, logger);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') logger.warn(`state: cannot read ${file} (${code ?? 'error'}); starting empty`);
      return GithubState.empty(file, logger);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn(`state: ${file} is not valid JSON; starting empty`);
      return GithubState.empty(file, logger);
    }
    const snap = normalize(parsed);
    if (!snap) {
      logger.warn(`state: ${file} is not a version ${STATE_VERSION} snapshot; starting empty`);
      return GithubState.empty(file, logger);
    }
    const kept = (parsed as { lastPollAt?: unknown }).lastPollAt;
    if (kept !== undefined && kept !== null && snap.lastPollAt === null) {
      logger.warn(`state: ${file} has a lastPollAt that isn't a time (${JSON.stringify(kept)}); lists without a cursor of their own start one interval back`);
    }
    return new GithubState(file, snap, logger);
  }

  createCheckpoint(): CheckpointRecord {
    const record: CheckpointRecord = {
      id: `chk_${randomUUID().slice(0, 8)}`,
      parent: this.snap.current,
      createdAt: new Date().toISOString(),
    };
    this.snap.checkpoints.push(record);
    this.snap.current = record.id;
    return record;
  }

  current(): string | null {
    return this.snap.current;
  }

  lineage(): CheckpointRecord[] {
    return this.snap.checkpoints.map((c) => ({ ...c }));
  }

  recordCreatedComment(comment: CreatedCommentRecord): void {
    this.bucket(this.snap.created).push({ ...comment });
  }

  recordEditedComment(comment: EditedCommentRecord): void {
    this.bucket(this.snap.edited).push({ ...comment });
  }

  recordDeletedComment(comment: DeletedCommentRecord): void {
    this.bucket(this.snap.deleted).push({ ...comment });
  }

  private bucket<T>(store: Record<string, T[]>): T[] {
    const key = this.snap.current ?? ROOT_BUCKET;
    const list = store[key] ?? [];
    store[key] = list;
    return list;
  }

  checkpointStatus(checkpointId: string): CheckpointStatus {
    if (!this.snap.checkpoints.some((c) => c.id === checkpointId)) return 'unknown';
    const parentOf = new Map(this.snap.checkpoints.map((c) => [c.id, c.parent]));
    for (let cursor = this.snap.current; cursor; cursor = parentOf.get(cursor) ?? null) {
      if (cursor === checkpointId) return 'live';
    }
    return 'abandoned';
  }

  rollback(checkpointId: string): CommentRollbackPlan | null {
    if (this.checkpointStatus(checkpointId) !== 'live') return null;
    const ids = this.subtreeIds(checkpointId).reverse();
    const plan: CommentRollbackPlan = { created: [], edited: [], deleted: [] };
    for (const id of ids) {
      plan.created.push(...(this.snap.created[id] ?? []).slice().reverse());
      plan.edited.push(...(this.snap.edited[id] ?? []).slice().reverse());
      plan.deleted.push(...(this.snap.deleted[id] ?? []).slice().reverse());
      delete this.snap.created[id];
      delete this.snap.edited[id];
      delete this.snap.deleted[id];
    }
    this.snap.current = checkpointId;
    return plan;
  }

  private subtreeIds(checkpointId: string): string[] {
    const parentOf = new Map(this.snap.checkpoints.map((c) => [c.id, c.parent]));
    const inSubtree = (id: string): boolean => {
      for (let cursor: string | null = id; cursor; cursor = parentOf.get(cursor) ?? null) {
        if (cursor === checkpointId) return true;
      }
      return false;
    };
    return this.snap.checkpoints.filter((c) => inSubtree(c.id)).map((c) => c.id);
  }

  lastPollAt(): string | null {
    return this.snap.lastPollAt;
  }

  setLastPollAt(when: string): void {
    this.snap.lastPollAt = when;
  }

  pollCursors(): Readonly<Record<string, PollCursor>> {
    return this.snap.pollCursors;
  }

  setPollCursors(cursors: Record<string, PollCursor>): void {
    this.snap.pollCursors = cursors;
  }

  polledNew(): Readonly<Record<string, Record<string, string>>> {
    return this.snap.pollNew;
  }

  setPolledNew(rows: Record<string, Record<string, string>>): void {
    this.snap.pollNew = rows;
  }

  seenPollKey(key: string): boolean {
    if (this.snap.pollKeys.includes(key)) return true;
    this.snap.pollKeys.push(key);
    if (this.snap.pollKeys.length > POLL_DEDUP_RING) {
      this.snap.pollKeys.splice(0, this.snap.pollKeys.length - POLL_DEDUP_RING);
    }
    return false;
  }

  polledHead(channel: string): string | null {
    return this.snap.pollHeads[channel] ?? null;
  }

  setPolledHead(channel: string, sha: string): void {
    delete this.snap.pollHeads[channel];
    this.snap.pollHeads[channel] = sha;
    const keys = Object.keys(this.snap.pollHeads);
    for (const stale of keys.slice(0, Math.max(0, keys.length - POLL_HEAD_MEMORY))) {
      delete this.snap.pollHeads[stale];
    }
  }

  snapshot(): GithubStateSnapshot {
    return structuredClone(this.snap);
  }

  async flush(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const payload = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    const run = this.writing.then(async () => {
      const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      mkdirSync(dirname(file), { recursive: true });
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    });
    this.writing = run.catch(() => undefined);
    await run;
  }
}

function normalize(parsed: unknown): GithubStateSnapshot | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Partial<GithubStateSnapshot>;
  if (raw.version !== STATE_VERSION) return null;
  if (!Array.isArray(raw.checkpoints)) return null;
  const snap = emptySnapshot();
  snap.checkpoints = raw.checkpoints.filter(
    (c): c is CheckpointRecord => !!c && typeof c.id === 'string' && typeof c.createdAt === 'string',
  );
  snap.current = typeof raw.current === 'string' ? raw.current : null;
  snap.created = buckets(raw.created);
  snap.edited = buckets(raw.edited);
  snap.deleted = buckets(raw.deleted);
  snap.lastPollAt =
    typeof raw.lastPollAt === 'string' && Number.isFinite(Date.parse(raw.lastPollAt)) ? raw.lastPollAt : null;
  snap.pollCursors = cursors(raw.pollCursors);
  snap.pollNew = {};
  if (raw.pollNew && typeof raw.pollNew === 'object' && !Array.isArray(raw.pollNew)) {
    for (const [list, rows] of Object.entries(raw.pollNew)) snap.pollNew[list] = strings(rows);
  }
  snap.pollKeys = Array.isArray(raw.pollKeys) ? raw.pollKeys.filter((k): k is string => typeof k === 'string') : [];
  snap.pollHeads = strings(raw.pollHeads);
  return snap;
}

function cursors(raw: unknown): Record<string, PollCursor> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const out: Record<string, PollCursor> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { since, resumeAt } = value as { since?: unknown; resumeAt?: unknown };
    if (!instant(since)) continue;
    out[key] = instant(resumeAt) ? { since, resumeAt } : { since };
  }
  return out;
}

function strings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function buckets<T>(raw: unknown): Record<string, T[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, T[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) out[key] = value as T[];
  }
  return out;
}
