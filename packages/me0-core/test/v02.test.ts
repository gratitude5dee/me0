import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Me0Engine } from "../src/engine.js";
import { invoke } from "../src/ops/registry.js";
import { hybridRecall } from "../src/retrieval.js";
import { type Store, connect, ensureCollections } from "../src/store/mongo.js";
import type { MemoryDoc, OperationContext } from "../src/types.js";

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "u_v02",
  harness: "claude-code",
  agent: "test-agent",
  episode_id: null,
  remote: false,
};
const remoteCtx: OperationContext = { ...ctx, remote: true };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  db = store.db;
  await ensureCollections(db);
  engine = new Me0Engine(db);
  await engine.ensureUser(ctx, ["Vee"]);
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("hybrid retrieval", () => {
  test("entity/alias arm surfaces linked memories with alias_hit evidence", async () => {
    const ent = await engine.upsertEntity(ctx, {
      slug: "zephyr",
      type: "project",
      names: ["zephyr", "Zephyr"],
    });
    await engine.remember(ctx, {
      text: "Ship the zephyr dashboard behind a feature flag",
      kind: "decision",
      entity_refs: [ent.entity_id],
    });
    const { scored } = await hybridRecall(db, ctx, { query: "zephyr status" }, {});
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].evidence).toBe("alias_hit");
  });

  test("fuses arms and respects visibility for remote callers", async () => {
    await engine.remember(ctx, {
      text: "Private key rotation happens quarterly",
      kind: "procedure",
      visibility: "private",
    });
    const local = await engine.recall(ctx, { query: "key rotation quarterly" });
    expect(local.abstained).toBe(false);
    const remote = await engine.recall(remoteCtx, { query: "key rotation quarterly" });
    expect(remote.abstained).toBe(true);
  });

  test("abstains cleanly when nothing matches", async () => {
    const r = await engine.recall(ctx, { query: "xylophone quantum lighthouse" });
    expect(r.abstained).toBe(true);
    expect(r.message).toBe("no recorded memory");
  });
});

describe("push gating", () => {
  test("pushes matching memories, capped and confidence-gated", async () => {
    await engine.remember(ctx, {
      text: "Deploy pipeline requires manual approval on fridays",
      kind: "procedure",
      confidence: 0.9,
    });
    await engine.remember(ctx, {
      text: "Deploy rollback playbook lives in runbooks repo",
      kind: "fact",
      confidence: 0.4,
    });
    const r = await engine.push(ctx, {
      prompt: "help me deploy the service",
      episode_id: "ep_push_1",
    });
    expect(r.pushed.length).toBeGreaterThan(0);
    expect(r.pushed.length).toBeLessThanOrEqual(3);
    const texts = r.pushed.map((p) => p.text);
    expect(texts.some((t) => t.includes("rollback playbook"))).toBe(false);
  });

  test("suppresses memories already surfaced in the same session", async () => {
    const first = await engine.push(ctx, {
      prompt: "deploy the service again",
      episode_id: "ep_push_2",
    });
    expect(first.pushed.length).toBeGreaterThan(0);
    const second = await engine.push(ctx, {
      prompt: "deploy the service again",
      episode_id: "ep_push_2",
    });
    expect(second.pushed.map((p) => p.memory_id)).not.toContain(first.pushed[0].memory_id);
    expect(second.suppressed_count).toBeGreaterThan(0);
  });

  test("writes push retrievals telemetry", async () => {
    const rows = await db
      .collection("retrievals")
      .find({ user_id: ctx.user_id, surface: "push" })
      .toArray();
    expect(rows.length).toBeGreaterThan(0);
  });

  test("is local-only via the registry", async () => {
    await expect(invoke(engine, remoteCtx, "push", { prompt: "deploy" })).rejects.toThrow();
  });
});

describe("dream consolidation", () => {
  test("dedupes normalized duplicates, keeping the earliest", async () => {
    await engine.remember(ctx, { text: "Coffee order: oat milk cortado", kind: "preference" });
    await engine.remember(ctx, { text: "coffee   order: oat milk cortado", kind: "preference" });
    const report = await engine.dream(ctx);
    expect(report.deduped).toBeGreaterThanOrEqual(1);
    const dupes = await db
      .collection<MemoryDoc>("memories")
      .find({ user_id: ctx.user_id, superseded_by: { $ne: null } })
      .toArray();
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    expect(dupes.every((d) => d.valid_until !== null)).toBe(true);
  });

  test("promotes hot memories and demotes stale ones", async () => {
    const memories = db.collection<MemoryDoc>("memories");
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    await memories.updateMany(
      { user_id: ctx.user_id, text: /zephyr dashboard/ },
      { $set: { tier: "recall", "access.count": 6 } },
    );
    await memories.updateMany(
      { user_id: ctx.user_id, text: /key rotation/i },
      { $set: { tier: "recall", "access.count": 0, valid_from: old } },
    );
    const report = await engine.dream(ctx);
    expect(report.promoted).toBeGreaterThanOrEqual(1);
    expect(report.demoted).toBeGreaterThanOrEqual(1);
    const hot = await memories.findOne({ user_id: ctx.user_id, text: /zephyr dashboard/ });
    expect(hot?.tier).toBe("standing");
    const stale = await memories.findOne({ user_id: ctx.user_id, text: /key rotation/i });
    expect(stale?.tier).toBe("archive");
  });

  test("recompiles the identity card from core memories", async () => {
    await db
      .collection<MemoryDoc>("memories")
      .updateOne(
        { user_id: ctx.user_id, text: /deploy pipeline requires/i },
        { $set: { tier: "core", notability: 0.9 } },
      );
    const report = await engine.dream(ctx);
    expect(report.identity_card_refreshed).toBe(true);
    const user = await db.collection("users").findOne({ user_id: ctx.user_id });
    expect(user?.identity_card).toContain("Name: Vee");
    expect(user?.identity_card).toContain("manual approval");
  });

  test("refreshes the cached global pack", async () => {
    const pack = await db.collection("packs").findOne({ user_id: ctx.user_id, scope: "global" });
    expect(pack).not.toBeNull();
    expect(pack?.content).toContain("manual approval");
    expect((pack?.generation as number) >= 2).toBe(true);
  });

  test("hard-purges soft-deletes older than 72h", async () => {
    const memories = db.collection<MemoryDoc>("memories");
    const oldDelete = new Date(Date.now() - 80 * 3600 * 1000).toISOString();
    await engine.remember(ctx, { text: "temp memory to purge", kind: "fact" });
    await memories.updateOne(
      { user_id: ctx.user_id, text: "temp memory to purge" },
      { $set: { deleted_at: oldDelete } },
    );
    const report = await engine.dream(ctx);
    expect(report.purged).toBeGreaterThanOrEqual(1);
    const gone = await memories.findOne({ user_id: ctx.user_id, text: "temp memory to purge" });
    expect(gone).toBeNull();
  });

  test("is local-only", async () => {
    await expect(engine.dream(remoteCtx)).rejects.toThrow();
  });
});
