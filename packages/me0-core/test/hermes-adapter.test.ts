import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  HERMES_PACK_SCOPE,
  HermesSnapshotProvider,
  buildHermesPack,
} from "../src/adapters/hermes.js";
import { Me0Engine } from "../src/engine.js";
import { type Store, connect, ensureCollections } from "../src/store/mongo.js";
import type { OperationContext } from "../src/types.js";

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "hermes-user",
  harness: "other",
  agent: "test-agent",
  episode_id: null,
  remote: false,
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  db = store.db;
  await ensureCollections(db);
  engine = new Me0Engine(db);
  await engine.remember(ctx, { text: "Ada prefers dark mode", kind: "preference", tier: "core" });
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("hermes adapter", () => {
  test("buildHermesPack stamps hermes scope", async () => {
    const pack = await buildHermesPack(engine, ctx);
    expect(pack.scope).toBe(HERMES_PACK_SCOPE);
    expect(pack.content).toContain("Ada prefers dark mode");
  });

  test("snapshot is frozen per session: mid-session writes do not mutate it", async () => {
    const provider = new HermesSnapshotProvider(engine, ctx);
    const first = await provider.pack("session-A");
    expect(first).toContain("Ada prefers dark mode");

    await engine.remember(ctx, {
      text: "Ada switched to light mode",
      kind: "preference",
      tier: "standing",
    });
    const again = await provider.pack("session-A");
    expect(again).toBe(first);

    // a new session sees the new memory
    const fresh = await provider.pack("session-B");
    expect(fresh).toContain("Ada switched to light mode");
  });

  test("reset() recomputes the snapshot", async () => {
    const provider = new HermesSnapshotProvider(engine, ctx);
    const first = await provider.pack("session-C");
    await engine.remember(ctx, { text: "Ada now uses vim", kind: "fact", tier: "standing" });
    provider.reset("session-C");
    const second = await provider.pack("session-C");
    expect(second).not.toBe(first);
    expect(second).toContain("Ada now uses vim");
  });

  test("fail-open: pack() returns empty string when the engine throws", async () => {
    const broken = new HermesSnapshotProvider(
      {
        contextPack: async () => Promise.reject(new Error("storage down")),
      } as unknown as Me0Engine,
      ctx,
    );
    await expect(broken.pack("session-X")).resolves.toBe("");
  });
});
