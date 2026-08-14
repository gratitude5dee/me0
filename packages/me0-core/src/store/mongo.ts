import { type Collection, type Db, type Document, MongoClient } from "mongodb";
import { validators } from "../schema/validators.js";
import { RETRIEVALS_TIMESERIES_OPTIONS, telemetryCollectionType } from "./telemetry.js";

export const DB_NAME = "me0";

export interface Store {
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

export async function connect(uri: string): Promise<Store> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(DB_NAME);
  return { client, db, close: () => client.close() };
}

export async function ensureCollections(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const [name, validator] of Object.entries(validators)) {
    if (name === "retrievals") {
      await ensureRetrievalsCollection(db, existing.has(name), validator);
      continue;
    }
    if (!existing.has(name)) {
      await db.createCollection(name, { validator, validationLevel: "moderate" });
    } else {
      await db.command({ collMod: name, validator, validationLevel: "moderate" });
    }
  }
  await ensureIndexes(db);
}

/**
 * Retrieval telemetry is created as a native time-series collection on fresh
 * databases. An existing plain collection is kept as-is (no destructive
 * migration of user data) — `me0 doctor` reports the upgrade path. Validators
 * are not supported on time-series collections, so the JSON-schema validator
 * only applies to the plain shape.
 */
async function ensureRetrievalsCollection(
  db: Db,
  exists: boolean,
  validator: Document,
): Promise<void> {
  if (!exists) {
    try {
      await db.createCollection("retrievals", RETRIEVALS_TIMESERIES_OPTIONS);
      return;
    } catch {
      // server without time-series support: fall back to a plain collection
      await db.createCollection("retrievals", { validator, validationLevel: "moderate" });
      return;
    }
  }
  if ((await telemetryCollectionType(db)) === "standard") {
    await db.command({ collMod: "retrievals", validator, validationLevel: "moderate" });
  }
}

/** 72h window between a soft-delete (forget) and the native TTL hard purge. */
export const PURGE_WINDOW_MS = 72 * 3600 * 1000;

/** 30d expiry for heuristic rfm predictions (longest horizon is 90d, scores are recomputed on every dream/rfm run). */
export const PREDICTION_TTL_MS = 30 * 86400000;

/** TTL indexes owned by me0 (safe to drop/recreate on option conflicts). */
export const TTL_INDEXES = [
  { collection: "memories", key: { purge_at: 1 }, name: "ttl_purge_at" },
  { collection: "predictions", key: { expire_at: 1 }, name: "ttl_expire_at" },
] as const;

/**
 * Idempotent TTL index creation: creating an index that already exists with
 * the same options is a no-op; on an option conflict only our known index
 * name is dropped and recreated.
 */
async function ensureTtlIndex(
  col: Collection<Document>,
  key: Document,
  name: string,
): Promise<void> {
  try {
    await col.createIndex(key, { name, expireAfterSeconds: 0 });
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 85 IndexOptionsConflict, 86 IndexKeySpecsConflict
    if (code === 85 || code === 86) {
      await col.dropIndex(name);
      await col.createIndex(key, { name, expireAfterSeconds: 0 });
    } else {
      throw err;
    }
  }
}

async function ensureIndexes(db: Db): Promise<void> {
  await migrateSessionStateIndex(db);
  await db.collection("users").createIndex({ user_id: 1 }, { unique: true });
  await db.collection("entities").createIndex({ user_id: 1, slug: 1 }, { unique: true });
  await db.collection("entities").createIndex({ user_id: 1, entity_id: 1 }, { unique: true });
  await db.collection("edges").createIndex({ user_id: 1, src: 1, rel: 1 });
  await db.collection("edges").createIndex({ user_id: 1, dst: 1 });
  await db.collection("memories").createIndex({ user_id: 1, memory_id: 1 }, { unique: true });
  await db.collection("memories").createIndex({ user_id: 1, tier: 1, kind: 1 });
  await db.collection("memories").createIndex({ user_id: 1, "prov.episode_id": 1 });
  await db.collection("memories").createIndex({ text: "text" });
  await db.collection("episodes").createIndex({ user_id: 1, episode_id: 1 }, { unique: true });
  await db.collection("episodes").createIndex({ user_id: 1, started_at: -1 });
  await db.collection("events").createIndex({ episode_id: 1, ts: 1 });
  try {
    await db.collection("retrievals").createIndex({ user_id: 1, ts: -1 });
  } catch {
    // older servers restrict secondary indexes on time-series collections
  }
  await db.collection("session_state").createIndex({ user_id: 1, episode_id: 1 }, { unique: true });
  await db.collection("audit").createIndex({ ts: -1 });
  for (const idx of TTL_INDEXES) {
    await ensureTtlIndex(db.collection(idx.collection), idx.key, idx.name);
  }
}

/**
 * session_state was originally keyed by episode_id alone. Drop the legacy
 * unique index and backfill user_id from the owning episode so the
 * { user_id, episode_id } compound key can take over.
 */
async function migrateSessionStateIndex(db: Db): Promise<void> {
  const col = db.collection("session_state");
  try {
    const indexes = await col.indexes();
    if (indexes.some((i) => i.name === "episode_id_1")) {
      await col.dropIndex("episode_id_1");
    }
  } catch {
    // collection or index may not exist yet
  }
  try {
    const orphans = await col.find({ user_id: { $exists: false } }).toArray();
    for (const doc of orphans) {
      const ep = await db.collection("episodes").findOne({ episode_id: doc.episode_id });
      if (ep) {
        await col.updateOne({ _id: doc._id }, { $set: { user_id: ep.user_id } });
      }
    }
  } catch {
    // backfill is best-effort
  }
}
