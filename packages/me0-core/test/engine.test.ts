import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Me0Engine } from "../src/engine.js";
import { invoke, operations } from "../src/ops/registry.js";
import { type Store, connect, ensureCollections } from "../src/store/mongo.js";
import type { OperationContext } from "../src/types.js";

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "test-user",
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
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("registry", () => {
  test("all verbs are registered", () => {
    const names = operations.map((o) => o.name);
    for (const verb of [
      "recall",
      "remember",
      "entity",
      "context_pack",
      "delta",
      "forget",
      "synthesize",
      "episode_start",
      "episode_log",
      "episode_end",
      "episode_recall",
      "handoff",
      "whoami",
      "me0_stats",
    ]) {
      expect(names).toContain(verb);
    }
  });

  test("rejects missing required args", async () => {
    await expect(invoke(engine, ctx, "recall", {})).rejects.toThrow("missing required argument");
  });

  test("rejects unknown ops", async () => {
    await expect(invoke(engine, ctx, "nope", {})).rejects.toThrow("unknown operation");
  });
});

describe("remember + recall", () => {
  test("write then recall round-trip with protocol_version stamp", async () => {
    const w = (await invoke(engine, ctx, "remember", {
      text: "user prefers conventional commits and squash-merge",
      kind: "preference",
      tier: "standing",
    })) as { protocol_version: number; memory_id: string; action: string };
    expect(w.protocol_version).toBe(1);
    expect(w.action).toBe("ADD");

    const r = (await invoke(engine, ctx, "recall", { query: "conventional commits" })) as {
      protocol_version: number;
      abstained: boolean;
      results: Array<{ memory_id: string; evidence: string }>;
    };
    expect(r.protocol_version).toBe(1);
    expect(r.abstained).toBe(false);
    expect(r.results.map((x) => x.memory_id)).toContain(w.memory_id);
  });

  test("duplicate remember is a NOOP with create_safety=exists", async () => {
    const args = { text: "duplicate probe fact", kind: "fact" };
    const a = (await invoke(engine, ctx, "remember", args)) as { action: string };
    const b = (await invoke(engine, ctx, "remember", args)) as {
      action: string;
      create_safety: string;
    };
    expect(a.action).toBe("ADD");
    expect(b.action).toBe("NOOP");
    expect(b.create_safety).toBe("exists");
  });

  test("recall abstains honestly on no match", async () => {
    const r = (await invoke(engine, ctx, "recall", {
      query: "zzz-nonexistent-quasar-topic",
    })) as { abstained: boolean; message: string; results: unknown[] };
    expect(r.abstained).toBe(true);
    expect(r.message).toBe("no recorded memory");
    expect(r.results).toHaveLength(0);
  });

  test("remote callers only see world-visibility memories", async () => {
    await invoke(engine, ctx, "remember", {
      text: "private banking preference alpha",
      kind: "preference",
      visibility: "private",
    });
    const r = (await invoke(engine, remoteCtx, "recall", {
      query: "banking preference alpha",
    })) as { abstained: boolean };
    expect(r.abstained).toBe(true);
  });
});

describe("local-only enforcement", () => {
  test("remote remember/forget/handoff are rejected", async () => {
    await expect(
      invoke(engine, remoteCtx, "remember", { text: "x", kind: "fact" }),
    ).rejects.toThrow("local-only");
    await expect(invoke(engine, remoteCtx, "forget", { memory_id: "m" })).rejects.toThrow(
      "local-only",
    );
    await expect(
      invoke(engine, remoteCtx, "handoff", { episode_id: "e", banked_state: "s" }),
    ).rejects.toThrow("local-only");
  });
});

describe("entities", () => {
  test("entity card lookup with edges and neighbors", async () => {
    const a = await engine.upsertEntity(ctx, {
      slug: "wzrd-studio",
      type: "project",
      names: ["WZRD Studio"],
      card: "AI creative studio project",
      status: "verified",
    });
    const b = await engine.upsertEntity(ctx, { slug: "mongodb", type: "tool" });
    await db.collection("edges").insertOne({
      user_id: ctx.user_id,
      edge_id: "edge_1",
      src: a.entity_id,
      dst: b.entity_id,
      rel: "uses",
      weight: 0.9,
      valid_from: new Date().toISOString(),
      valid_until: null,
      superseded_by: null,
      prov: {
        episode_id: null,
        harness: "claude-code",
        agent: "test",
        method: "deterministic",
        confidence: 1,
        extracted_at: new Date().toISOString(),
      },
    });

    const r = (await invoke(engine, ctx, "entity", { slug: "WZRD Studio" })) as {
      found: boolean;
      entity: { slug: string };
      edges: Array<{ rel: string }>;
      neighbors: Array<{ slug: string }>;
    };
    expect(r.found).toBe(true);
    expect(r.entity.slug).toBe("wzrd-studio");
    expect(r.edges[0]?.rel).toBe("uses");
    expect(r.neighbors.map((n) => n.slug)).toContain("mongodb");
  });

  test("unknown entity abstains", async () => {
    const r = (await invoke(engine, ctx, "entity", { slug: "never-heard-of-it" })) as {
      found: boolean;
      message: string;
    };
    expect(r.found).toBe(false);
    expect(r.message).toBe("no recorded memory");
  });
});

describe("episodes + handoff", () => {
  test("full lifecycle: start → log → handoff → resume pack → recall", async () => {
    const started = (await invoke(engine, ctx, "episode_start", {
      harness: "claude-code",
      title: "fix auth bug",
      project: "wzrd",
    })) as { episode_id: string };
    expect(started.episode_id).toStartWith("ep_");

    await invoke(engine, ctx, "episode_log", {
      episode_id: started.episode_id,
      type: "tool_call",
      tool: "bash",
      ok: true,
    });

    const h = (await invoke(engine, ctx, "handoff", {
      episode_id: started.episode_id,
      banked_state: "JWT refresh fails on expiry; next: add clock-skew tolerance",
    })) as { token: string };
    expect(h.token).toStartWith("hd_");

    const pack = (await invoke(engine, ctx, "context_pack", { resume: h.token })) as {
      content: string;
      _meta: { budget_used: number };
    };
    expect(pack.content).toContain("clock-skew tolerance");
    expect(pack.content).toContain("fix auth bug");

    const ep = await db.collection("episodes").findOne({ episode_id: started.episode_id });
    expect(ep?.status).toBe("handed_off");

    const er = (await invoke(engine, ctx, "episode_recall", { query: "auth bug" })) as {
      abstained: boolean;
      episodes: Array<{ episode_id: string }>;
    };
    expect(er.abstained).toBe(false);
    expect(er.episodes.map((e) => e.episode_id)).toContain(started.episode_id);
  });

  test("episode_end closes an active episode", async () => {
    const s = (await invoke(engine, ctx, "episode_start", {})) as { episode_id: string };
    const e = (await invoke(engine, ctx, "episode_end", {
      episode_id: s.episode_id,
      summary: "did the thing",
      success: true,
    })) as { ended: boolean };
    expect(e.ended).toBe(true);
  });
});

describe("context_pack + delta", () => {
  test("pack respects the token budget", async () => {
    for (let i = 0; i < 40; i++) {
      await invoke(engine, ctx, "remember", {
        text: `standing preference number ${i}: some moderately long preference text about tooling and workflow habits`,
        kind: "preference",
        tier: "standing",
      });
    }
    const pack = (await invoke(engine, ctx, "context_pack", { budget_tokens: 100 })) as {
      _meta: { budget_used: number; dropped_count: number };
    };
    expect(pack._meta.budget_used).toBeLessThanOrEqual(100);
    expect(pack._meta.dropped_count).toBeGreaterThan(0);
  });

  test("delta returns only new memories after the cursor", async () => {
    const epCtx = { ...ctx, episode_id: "ep_delta_test" };
    const d1 = (await invoke(engine, epCtx, "delta", {})) as { cursor: string };
    await invoke(engine, epCtx, "remember", { text: "brand new delta fact xyzzy", kind: "fact" });
    const d2 = (await invoke(engine, epCtx, "delta", {})) as {
      changes: Array<{ text: string }>;
      cursor: string;
    };
    expect(d2.changes.map((c) => c.text)).toContain("brand new delta fact xyzzy");
    expect(d2.cursor > d1.cursor).toBe(true);
    const d3 = (await invoke(engine, epCtx, "delta", {})) as { changes: unknown[] };
    expect(d3.changes).toHaveLength(0);
  });
});

describe("forget", () => {
  test("soft-delete hides from recall; purge hard-deletes after window", async () => {
    const w = (await invoke(engine, ctx, "remember", {
      text: "temporary embarrassing fact quokka",
      kind: "fact",
    })) as { memory_id: string };
    const f = (await invoke(engine, ctx, "forget", { memory_id: w.memory_id })) as {
      forgotten: number;
      purge_after_hours: number;
    };
    expect(f.forgotten).toBe(1);
    expect(f.purge_after_hours).toBe(72);

    const r = (await invoke(engine, ctx, "recall", { query: "quokka" })) as {
      abstained: boolean;
    };
    expect(r.abstained).toBe(true);

    await db
      .collection("memories")
      .updateOne(
        { memory_id: w.memory_id },
        { $set: { deleted_at: new Date(Date.now() - 80 * 3600 * 1000).toISOString() } },
      );
    const purged = await engine.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await db.collection("memories").findOne({ memory_id: w.memory_id })).toBeNull();
  });
});

describe("synthesize / whoami / stats", () => {
  test("synthesize cites recalled memories, abstains on nothing", async () => {
    const s = (await invoke(engine, ctx, "synthesize", {
      question: "what commit style does the user prefer?",
    })) as { abstained: boolean; citations: string[] };
    expect(s.abstained).toBe(false);
    expect(s.citations.length).toBeGreaterThan(0);

    const empty = (await invoke(engine, ctx, "synthesize", {
      question: "xylophone-tournament-results",
    })) as { abstained: boolean };
    expect(empty.abstained).toBe(true);
  });

  test("whoami and me0_stats", async () => {
    const w = (await invoke(engine, ctx, "whoami", {})) as { user_id: string; remote: boolean };
    expect(w.user_id).toBe("test-user");
    const s = (await invoke(engine, ctx, "me0_stats", {})) as {
      counts: { memories: number; episodes: number };
      health: string;
    };
    expect(s.health).toBe("ok");
    expect(s.counts.memories).toBeGreaterThan(0);
    expect(s.counts.episodes).toBeGreaterThan(0);
  });
});

describe("audit", () => {
  test("writes are audited with actor attribution", async () => {
    const entries = await db.collection("audit").find({}).toArray();
    expect(entries.length).toBeGreaterThan(0);
    const ops = new Set(entries.map((e) => e.op));
    expect(ops.has("remember")).toBe(true);
    expect(ops.has("forget")).toBe(true);
    expect(ops.has("handoff")).toBe(true);
  });
});
