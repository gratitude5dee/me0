import type { ChangeStream, ChangeStreamDocument, Db, Document } from "mongodb";
import type { MemoryDoc, MemoryKind, MemoryTier } from "./types.js";

/**
 * Change streams require a replica set (or sharded cluster). Detect the
 * topology so callers can fail with a clear message on standalone servers
 * instead of crashing mid-watch.
 */
export async function isReplicaSet(db: Db): Promise<boolean> {
  try {
    const hello = await db.admin().command({ hello: 1 });
    return typeof hello.setName === "string" || hello.msg === "isdbgrid";
  } catch {
    return false;
  }
}

export interface WatchMemoriesOptions {
  kind?: MemoryKind;
  tier?: MemoryTier;
}

/**
 * Tail the memories collection for one user via a change stream — the
 * substrate for live-sync between harnesses. Hard deletes carry no full
 * document and cannot be attributed to a user, so they are excluded;
 * soft-deletes (forget) surface as updates with a non-null deleted_at.
 */
export function watchMemories(
  db: Db,
  userId: string,
  opts: WatchMemoriesOptions = {},
): ChangeStream<MemoryDoc> {
  const docMatch: Document = { "fullDocument.user_id": userId };
  if (opts.kind) docMatch["fullDocument.kind"] = opts.kind;
  if (opts.tier) docMatch["fullDocument.tier"] = opts.tier;
  const pipeline = [{ $match: docMatch }];
  return db.collection<MemoryDoc>("memories").watch(pipeline, { fullDocument: "updateLookup" });
}

export interface MemoryChangeEvent {
  ts: string;
  op: string;
  memory_id: string | null;
  user_id: string | null;
  kind: string | null;
  tier: string | null;
  text: string | null;
  deleted_at: string | null;
}

/** Flatten a raw change-stream document into a stable JSONL-friendly event. */
export function formatMemoryChange(change: ChangeStreamDocument<MemoryDoc>): MemoryChangeEvent {
  const doc = "fullDocument" in change ? (change.fullDocument ?? null) : null;
  return {
    ts: new Date().toISOString(),
    op: change.operationType,
    memory_id: doc?.memory_id ?? null,
    user_id: doc?.user_id ?? null,
    kind: doc?.kind ?? null,
    tier: doc?.tier ?? null,
    text: doc?.text ?? null,
    deleted_at: doc?.deleted_at ?? null,
  };
}
