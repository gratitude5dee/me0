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
  await db.collection("session_state").createIndex({ episode_id: 1 }, { unique: true });
  await db.collection("audit").createIndex({ ts: -1 });
}
