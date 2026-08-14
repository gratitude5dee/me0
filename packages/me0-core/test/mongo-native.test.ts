import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import { Me0Engine } from "../src/engine.js";
import { validators } from "../src/schema/validators.js";
import {
  PURGE_WINDOW_MS,
  type Store,
  TTL_INDEXES,
  connect,
  ensureCollections,
} from "../src/store/mongo.js";
import { logRetrievals, telemetryCollectionType } from "../src/store/telemetry.js";
import type { OperationContext } from "../src/types.js";
import { formatMemoryChange, isReplicaSet, watchMemories } from "../src/watch.js";

const ctx: OperationContext = {
  user_id: "native-user",
  harness: "claude-code",
  agent: "test-agent",
  episode_id: null,
  remote: false,
};

describe("mongo-native schema (standalone)", () => {
  let mongod: MongoMemoryServer;
  let store: Store;
  let db: Db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    store = await connect(mongod.getUri());
    db = store.db;
    await ensureCollections(db);
  });

  afterAll(async () => {
    await store.close();
    await mongod.stop();
  });

  test("fresh init creates retrievals as a time-series collection", async () => {
    const cols = await db.listCollections({ name: "retrievals" }).toArray();
    expect(cols[0]?.type).toBe("timeseries");
    expect(await telemetryCollectionType(db)).toBe("timeseries");
  });

  test("TTL indexes are present with expireAfterSeconds 0", async () => {
    for (const idx of TTL_INDEXES) {
      const indexes = await db.collection(idx.collection).indexes();
      const found = indexes.find((i) => i.name === idx.name);
      expect(found).toBeDefined();
      expect(found?.expireAfterSeconds).toBe(0);
    }
  });

  test("re-running ensureCollections on an existing db is idempotent", async () => {
    await ensureCollections(db);
    await ensureCollections(db);
    const cols = await db.listCollections({ name: "retrievals" }).toArray();
    expect(cols[0]?.type).toBe("timeseries");
    const indexes = await db.collection("memories").indexes();
    expect(indexes.filter((i) => i.name === "ttl_purge_at")).toHaveLength(1);
  });

  test("TTL index option conflict is resolved by drop/recreate", async () => {
    await db.collection("memories").dropIndex("ttl_purge_at");
    await db
      .collection("memories")
      .createIndex({ purge_at: 1 }, { name: "ttl_purge_at", expireAfterSeconds: 3600 });
    await ensureCollections(db);
    const idx = (await db.collection("memories").indexes()).find((i) => i.name === "ttl_purge_at");
    expect(idx?.expireAfterSeconds).toBe(0);
  });

  test("logRetrievals writes Date ts + meta into the time-series collection", async () => {
    const ts = new Date().toISOString();
    await logRetrievals(db, [
      {
        ts,
        user_id: ctx.user_id,
        episode_id: null,
        memory_id: "mem_ts_1",
        surface: "recall",
        rank: 0,
        score: 0.9,
        used: null,
      },
    ]);
    const row = await db.collection("retrievals").findOne({ user_id: ctx.user_id });
    expect(row).toBeTruthy();
    expect(row?.ts).toBeInstanceOf(Date);
    expect(row?.meta).toEqual({ user_id: ctx.user_id, op: "recall" });
    expect(await db.collection("retrievals").countDocuments({ user_id: ctx.user_id })).toBe(1);
  });

  test("forget sets a purge_at Date ~72h ahead", async () => {
    const engine = new Me0Engine(db);
    const w = (await engine.remember(ctx, { text: "ttl probe memory", kind: "fact" })) as {
      memory_id: string;
    };
    await engine.forget(ctx, { memory_id: w.memory_id });
    const doc = await db
      .collection("memories")
      .findOne({ user_id: ctx.user_id, memory_id: w.memory_id });
    expect(doc?.deleted_at).toBeTruthy();
    expect(doc?.purge_at).toBeInstanceOf(Date);
    const delta = (doc?.purge_at as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(PURGE_WINDOW_MS - 60000);
    expect(delta).toBeLessThanOrEqual(PURGE_WINDOW_MS);
  });

  test("standalone server reports no change-stream capability", async () => {
    expect(await isReplicaSet(db)).toBe(false);
  });
});

describe("existing plain retrievals collection (backward compat)", () => {
  let mongod: MongoMemoryServer;
  let store: Store;
  let db: Db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    store = await connect(mongod.getUri());
    db = store.db;
    // simulate a pre-v0.4 database with a plain retrievals collection
    await db.createCollection("retrievals", {
      validator: validators.retrievals,
      validationLevel: "moderate",
    });
    await db.collection("retrievals").insertOne({
      ts: "2026-01-01T00:00:00.000Z",
      user_id: "legacy-user",
      episode_id: null,
      memory_id: "mem_legacy",
      surface: "pack",
      rank: 0,
      score: 1,
      used: null,
    });
    await ensureCollections(db);
  });

  afterAll(async () => {
    await store.close();
    await mongod.stop();
  });

  test("plain collection is kept, not destructively migrated", async () => {
    const cols = await db.listCollections({ name: "retrievals" }).toArray();
    expect(cols[0]?.type ?? "collection").not.toBe("timeseries");
    expect(await telemetryCollectionType(db)).toBe("standard");
    const legacy = await db.collection("retrievals").findOne({ memory_id: "mem_legacy" });
    expect(legacy?.ts).toBe("2026-01-01T00:00:00.000Z");
  });

  test("telemetry writes and reads still work against the plain shape", async () => {
    const ts = new Date().toISOString();
    await logRetrievals(db, [
      {
        ts,
        user_id: "legacy-user",
        episode_id: null,
        memory_id: "mem_new",
        surface: "push",
        rank: 0,
        score: 0.8,
        used: null,
      },
    ]);
    const row = await db.collection("retrievals").findOne({ memory_id: "mem_new" });
    expect(row?.ts).toBe(ts);
    expect(row?.meta).toBeUndefined();
    expect(await db.collection("retrievals").countDocuments({ user_id: "legacy-user" })).toBe(2);
  });

  test("engine recall records telemetry against the plain shape", async () => {
    const engine = new Me0Engine(db);
    await engine.remember(ctx, { text: "legacy telemetry probe", kind: "fact" });
    await engine.recall(ctx, { query: "legacy telemetry probe" });
    const n = await db
      .collection("retrievals")
      .countDocuments({ user_id: ctx.user_id, surface: "recall" });
    expect(n).toBeGreaterThan(0);
  });
});

describe("change streams (replica set)", () => {
  let replset: MongoMemoryReplSet;
  let store: Store;
  let db: Db;

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    store = await connect(replset.getUri());
    db = store.db;
    await ensureCollections(db);
  }, 120000);

  afterAll(async () => {
    await store.close();
    await replset.stop();
  });

  test("replica set is detected", async () => {
    expect(await isReplicaSet(db)).toBe(true);
  });

  test("watchMemories emits an event for the watched user only", async () => {
    const stream = watchMemories(db, "watch-user");
    const next = stream.next();
    const engine = new Me0Engine(db);
    await engine.remember({ ...ctx, user_id: "other-user" }, { text: "not watched", kind: "fact" });
    await engine.remember(
      { ...ctx, user_id: "watch-user" },
      { text: "watched memory", kind: "fact" },
    );
    const change = await next;
    const event = formatMemoryChange(change);
    expect(event.op).toBe("insert");
    expect(event.user_id).toBe("watch-user");
    expect(event.text).toBe("watched memory");
    await stream.close();
  }, 30000);

  test("kind filter excludes non-matching writes", async () => {
    const stream = watchMemories(db, "watch-user", { kind: "preference" });
    const next = stream.next();
    const engine = new Me0Engine(db);
    await engine.remember(
      { ...ctx, user_id: "watch-user" },
      { text: "a plain fact", kind: "fact" },
    );
    await engine.remember(
      { ...ctx, user_id: "watch-user" },
      { text: "prefers dark mode", kind: "preference" },
    );
    const event = formatMemoryChange(await next);
    expect(event.kind).toBe("preference");
    await stream.close();
  }, 30000);
});
