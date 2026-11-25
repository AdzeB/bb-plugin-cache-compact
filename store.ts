import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  CompactionMethodKind,
  TrackedThreadState,
  TtlSource,
} from "./policy.js";

export interface TrackedThreadRecord {
  readonly threadId: string;
  readonly providerId: string;
  readonly title: string;
  readonly state: TrackedThreadState;
  readonly ttlSource: TtlSource | null;
  readonly method: CompactionMethodKind | null;
  readonly usedTokens: number | null;
  readonly latestEventSeq: number | null;
  readonly compactedForSeq: number | null;
  readonly expiresAtMs: number | null;
  readonly compactAtMs: number | null;
  readonly compactionStartedAtMs: number | null;
  readonly lastCompactedAtMs: number | null;
  readonly lastReason: string | null;
  readonly optedOut: boolean;
  readonly firstSeenAtMs: number;
  readonly updatedAtMs: number;
}

interface RawTrackedThreadRow {
  thread_id: string;
  provider_id: string;
  title: string;
  state: string;
  ttl_source: string | null;
  method: string | null;
  used_tokens: number | null;
  latest_event_seq: number | null;
  compacted_for_seq: number | null;
  expires_at_ms: number | null;
  compact_at_ms: number | null;
  compaction_started_at_ms: number | null;
  last_compacted_at_ms: number | null;
  last_reason: string | null;
  opted_out: number;
  first_seen_at_ms: number;
  updated_at_ms: number;
}

const VALID_STATES: ReadonlySet<TrackedThreadState> = new Set([
  "scheduled",
  "compacting",
  "compacted",
  "skipped",
  "active",
  "expired",
  "failed",
]);

const VALID_TTL_SOURCES: ReadonlySet<TtlSource> = new Set([
  "compaction-offer",
  "provider-ttl",
  "provider-fallback-ttl",
  "fallback-ttl",
]);

const VALID_METHODS: ReadonlySet<CompactionMethodKind> = new Set([
  "native",
  "slash-command",
]);

function parseState(value: string): TrackedThreadState {
  for (const candidate of VALID_STATES) {
    if (candidate === value) return candidate;
  }
  return "skipped";
}

function parseTtlSource(value: string | null): TtlSource | null {
  if (value === null) return null;
  for (const candidate of VALID_TTL_SOURCES) {
    if (candidate === value) return candidate;
  }
  return null;
}

function parseMethod(value: string | null): CompactionMethodKind | null {
  if (value === null) return null;
  for (const candidate of VALID_METHODS) {
    if (candidate === value) return candidate;
  }
  return null;
}

function mapRow(row: RawTrackedThreadRow): TrackedThreadRecord {
  return {
    threadId: row.thread_id,
    providerId: row.provider_id,
    title: row.title,
    state: parseState(row.state),
    ttlSource: parseTtlSource(row.ttl_source),
    method: parseMethod(row.method),
    usedTokens: row.used_tokens,
    latestEventSeq: row.latest_event_seq,
    compactedForSeq: row.compacted_for_seq,
    expiresAtMs: row.expires_at_ms,
    compactAtMs: row.compact_at_ms,
    compactionStartedAtMs: row.compaction_started_at_ms,
    lastCompactedAtMs: row.last_compacted_at_ms,
    lastReason: row.last_reason,
    optedOut: row.opted_out === 1,
    firstSeenAtMs: row.first_seen_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export interface CacheCompactStore {
  get(threadId: string): TrackedThreadRecord | null;
  upsert(record: TrackedThreadRecord): void;
  setOptOut(threadId: string, optedOut: boolean, nowMs: number): TrackedThreadRecord;
  delete(threadId: string): void;
  listAll(limit?: number): TrackedThreadRecord[];
  listScheduled(): TrackedThreadRecord[];
  listDue(nowMs: number): TrackedThreadRecord[];
  nextCompactAtMs(): number | null;
}

export function createCacheCompactStore(bb: BbPluginApi): CacheCompactStore {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS tracked_threads (
      thread_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      ttl_source TEXT,
      method TEXT,
      used_tokens INTEGER,
      latest_event_seq INTEGER,
      compacted_for_seq INTEGER,
      expires_at_ms INTEGER,
      compact_at_ms INTEGER,
      compaction_started_at_ms INTEGER,
      last_compacted_at_ms INTEGER,
      last_reason TEXT,
      opted_out INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tracked_threads_due
      ON tracked_threads (state, compact_at_ms)`,
    `ALTER TABLE tracked_threads
      ADD COLUMN first_seen_at_ms INTEGER NOT NULL DEFAULT 0`,
  ]);

  const selectById = db.prepare<[string], RawTrackedThreadRow>(
    `SELECT * FROM tracked_threads WHERE thread_id = ?`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO tracked_threads (
      thread_id,
      provider_id,
      title,
      state,
      ttl_source,
      method,
      used_tokens,
      latest_event_seq,
      compacted_for_seq,
      expires_at_ms,
      compact_at_ms,
      compaction_started_at_ms,
      last_compacted_at_ms,
      last_reason,
      opted_out,
      first_seen_at_ms,
      updated_at_ms
    ) VALUES (
      @threadId,
      @providerId,
      @title,
      @state,
      @ttlSource,
      @method,
      @usedTokens,
      @latestEventSeq,
      @compactedForSeq,
      @expiresAtMs,
      @compactAtMs,
      @compactionStartedAtMs,
      @lastCompactedAtMs,
      @lastReason,
      @optedOut,
      @firstSeenAtMs,
      @updatedAtMs
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      provider_id = excluded.provider_id,
      title = excluded.title,
      state = excluded.state,
      ttl_source = excluded.ttl_source,
      method = excluded.method,
      used_tokens = excluded.used_tokens,
      latest_event_seq = excluded.latest_event_seq,
      compacted_for_seq = excluded.compacted_for_seq,
      expires_at_ms = excluded.expires_at_ms,
      compact_at_ms = excluded.compact_at_ms,
      compaction_started_at_ms = excluded.compaction_started_at_ms,
      last_compacted_at_ms = excluded.last_compacted_at_ms,
      last_reason = excluded.last_reason,
      opted_out = excluded.opted_out,
      first_seen_at_ms = excluded.first_seen_at_ms,
      updated_at_ms = excluded.updated_at_ms
  `);
  const deleteStmt = db.prepare<[string]>(
    `DELETE FROM tracked_threads WHERE thread_id = ?`,
  );
  const listAllStmt = db.prepare<[number], RawTrackedThreadRow>(
    `SELECT * FROM tracked_threads
     ORDER BY
       CASE state WHEN 'scheduled' THEN 0 WHEN 'compacting' THEN 1 ELSE 2 END,
       COALESCE(compact_at_ms, updated_at_ms) ASC
     LIMIT ?`,
  );
  const listScheduledStmt = db.prepare<[], RawTrackedThreadRow>(
    `SELECT * FROM tracked_threads
     WHERE state = 'scheduled' AND compact_at_ms IS NOT NULL
     ORDER BY compact_at_ms ASC`,
  );
  const listDueStmt = db.prepare<[number], RawTrackedThreadRow>(
    `SELECT * FROM tracked_threads
     WHERE state = 'scheduled' AND compact_at_ms IS NOT NULL AND compact_at_ms <= ?
     ORDER BY compact_at_ms ASC`,
  );
  const nextDueStmt = db.prepare<[], { next_at: number | null }>(
    `SELECT MIN(compact_at_ms) AS next_at
     FROM tracked_threads
     WHERE state = 'scheduled' AND compact_at_ms IS NOT NULL`,
  );

  const get = (threadId: string): TrackedThreadRecord | null => {
    const row = selectById.get(threadId);
    return row === undefined ? null : mapRow(row);
  };

  const upsert = (record: TrackedThreadRecord): void => {
    upsertStmt.run({
      threadId: record.threadId,
      providerId: record.providerId,
      title: record.title,
      state: record.state,
      ttlSource: record.ttlSource,
      method: record.method,
      usedTokens: record.usedTokens,
      latestEventSeq: record.latestEventSeq,
      compactedForSeq: record.compactedForSeq,
      expiresAtMs: record.expiresAtMs,
      compactAtMs: record.compactAtMs,
      compactionStartedAtMs: record.compactionStartedAtMs,
      lastCompactedAtMs: record.lastCompactedAtMs,
      lastReason: record.lastReason,
      optedOut: record.optedOut ? 1 : 0,
      firstSeenAtMs: record.firstSeenAtMs,
      updatedAtMs: record.updatedAtMs,
    });
  };

  return {
    get,
    upsert,
    setOptOut(threadId, optedOut, nowMs) {
      const existing = get(threadId);
      const next: TrackedThreadRecord = existing
        ? {
            ...existing,
            optedOut,
            state: optedOut ? "skipped" : existing.state,
            compactAtMs: optedOut ? null : existing.compactAtMs,
            lastReason: optedOut ? "opted-out" : existing.lastReason,
            updatedAtMs: nowMs,
          }
        : {
            threadId,
            providerId: "unknown",
            title: "",
            state: "skipped",
            ttlSource: null,
            method: null,
            usedTokens: null,
            latestEventSeq: null,
            compactedForSeq: null,
            expiresAtMs: null,
            compactAtMs: null,
            compactionStartedAtMs: null,
            lastCompactedAtMs: null,
            lastReason: optedOut ? "opted-out" : "opted-in",
            optedOut,
            firstSeenAtMs: nowMs,
            updatedAtMs: nowMs,
          };
      upsert(next);
      return next;
    },
    delete(threadId) {
      deleteStmt.run(threadId);
    },
    listAll(limit = 100) {
      return listAllStmt.all(limit).map(mapRow);
    },
    listScheduled() {
      return listScheduledStmt.all().map(mapRow);
    },
    listDue(nowMs) {
      return listDueStmt.all(nowMs).map(mapRow);
    },
    nextCompactAtMs() {
      const row = nextDueStmt.get();
      return row?.next_at ?? null;
    },
  };
}
