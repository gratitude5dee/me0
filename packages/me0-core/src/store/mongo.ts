import { type Db, MongoClient } from "mongodb";
import { validators } from "../schema/validators.js";

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
    if (!existing.has(name)) {
      await db.createCollection(name, { validator, validationLevel: "moderate" });
    } else {
      await db.command({ collMod: name, validator, validationLevel: "moderate" });
    }
  }
  await ensureIndexes(db);
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
  await db.collection("retrievals").createIndex({ user_id: 1, ts: -1 });
  await db.collection("session_state").createIndex({ user_id: 1, episode_id: 1 }, { unique: true });
  await db.collection("audit").createIndex({ ts: -1 });
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
