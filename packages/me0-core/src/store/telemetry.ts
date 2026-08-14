import type { Db } from "mongodb";

/**
 * Options used when creating the `retrievals` telemetry collection fresh.
 * Telemetry is append-only time-stamped data, so a native time-series
 * collection (timeField `ts`, metaField `meta` = { user_id, op }) is the
 * preferred shape. Existing plain collections are kept as-is — user data is
 * never destructively migrated.
 */
export const RETRIEVALS_TIMESERIES_OPTIONS = {
  timeseries: {
    timeField: "ts",
    metaField: "meta",
    granularity: "seconds" as const,
  },
};

export type TelemetryCollectionType = "timeseries" | "standard" | "missing";

const typeCache = new WeakMap<Db, TelemetryCollectionType>();

/** Detect the shape of the `retrievals` collection (cached per Db handle). */
export async function telemetryCollectionType(db: Db): Promise<TelemetryCollectionType> {
  const cached = typeCache.get(db);
  if (cached === "timeseries" || cached === "standard") return cached;
  const cols = await db.listCollections({ name: "retrievals" }).toArray();
  const first = cols[0];
  const type: TelemetryCollectionType =
    first === undefined ? "missing" : first.type === "timeseries" ? "timeseries" : "standard";
  typeCache.set(db, type);
  return type;
}

export interface RetrievalRow {
  ts: string;
  user_id: string;
  episode_id: string | null;
  memory_id: string;
  surface: "pack" | "recall" | "push" | "delta";
  rank: number;
  score: number;
  used: boolean | null;
}

/**
 * Append retrieval telemetry rows, adapting to the collection shape:
 * time-series collections require a BSON Date timeField and carry the
 * { user_id, op } metaField; plain collections keep the original ISO-string
 * `ts` for backward compatibility. Telemetry is fail-open — a write failure
 * never blocks the operation that produced it.
 */
export async function logRetrievals(db: Db, rows: RetrievalRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const type = await telemetryCollectionType(db);
    if (type === "timeseries") {
      await db.collection("retrievals").insertMany(
        rows.map((r) => ({
          ...r,
          ts: new Date(r.ts),
          meta: { user_id: r.user_id, op: r.surface },
        })),
      );
    } else {
      await db.collection("retrievals").insertMany(rows);
    }
  } catch {
    // telemetry is best-effort: never block the agent on a logging failure
  }
}

/**
 * Record that surfaced memories were actually used. Plain collections update
 * `used` in place; time-series rows are immutable, so usage is upserted into
 * the plain `retrieval_feedback` side collection instead, one document per
 * (user_id, memory_id), keeping repeated acknowledgements idempotent
 * (heuristics read both). Returns the number of surfacing rows acknowledged.
 */
export async function markRetrievalsUsed(
  db: Db,
  userId: string,
  memoryIds?: string[],
): Promise<number> {
  const filter = {
    user_id: userId,
    ...(memoryIds ? { memory_id: { $in: memoryIds } } : {}),
  };
  const type = await telemetryCollectionType(db);
  if (type !== "timeseries") {
    const r = await db.collection("retrievals").updateMany(filter, { $set: { used: true } });
    return r.modifiedCount;
  }
  const rows = await db.collection("retrievals").find(filter).toArray();
  if (rows.length === 0) return 0;
  const acknowledged = [...new Set(rows.map((r) => r.memory_id as string))];
  await db.collection("retrieval_feedback").bulkWrite(
    acknowledged.map((memoryId) => ({
      updateOne: {
        filter: { user_id: userId, memory_id: memoryId },
        update: { $set: { ts: new Date(), used: true } },
        upsert: true,
      },
    })),
  );
  return rows.length;
}
