import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  type Embedder,
  clearEmbedder,
  cosineSimilarity,
  embedBackfill,
  getEmbedder,
  maybeEmbedText,
  setEmbedder,
} from "../src/embeddings.js";
import { Me0Engine } from "../src/engine.js";
import {
  parseMongoVersion,
  supportsNativeRankFusion,
  versionSupportsRankFusion,
} from "../src/rankfusion.js";
import { type Store, connect, ensureCollections } from "../src/store/mongo.js";
import type { MemoryDoc, OperationContext } from "../src/types.js";

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "vec-user",
  harness: "claude-code",
  agent: "test-agent",
  episode_id: null,
  remote: false,
};

/** deterministic fake embedder: known phrases map to fixed unit vectors */
function fakeEmbedder(model = "fake-embed-1"): Embedder {
  const axes: Array<[string, number]> = [
    ["coffee", 0],
    ["espresso", 0],
    ["latte", 0],
    ["mongodb", 1],
    ["database", 1],
    ["guitar", 2],
  ];
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = [0, 0, 0, 0.0001];
        const lower = t.toLowerCase();
        for (const [word, axis] of axes) {
          if (lower.includes(word)) v[axis] = (v[axis] ?? 0) + 1;
        }
        return v;
      });
    },
  };
}

const failingEmbedder: Embedder = {
  model: "always-fails",
  async embed(): Promise<number[][]> {
    throw new Error("provider down");
  },
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  db = store.db;
  await ensureCollections(db);
  engine = new Me0Engine(db);
});

afterAll(async () => {
  clearEmbedder();
  await store.close();
  await mongod.stop();
});

afterEach(async () => {
  clearEmbedder();
  Reflect.deleteProperty(process.env, "ME0_RANK_FUSION");
  Reflect.deleteProperty(process.env, "ME0_VOYAGE_API_KEY");
  for (const col of ["memories", "entities", "edges", "retrievals"]) {
    await db.collection(col).deleteMany({ user_id: ctx.user_id });
  }
});

describe("embeddings provider", () => {
  test("getEmbedder resolves injected > env > none", () => {
    expect(getEmbedder()).toBeNull();
    process.env.ME0_VOYAGE_API_KEY = "test-key";
    expect(getEmbedder()?.model).toBe("voyage-3-lite");
    const fake = fakeEmbedder();
    setEmbedder(fake);
    expect(getEmbedder()).toBe(fake);
    setEmbedder(null);
    expect(getEmbedder()).toBeNull();
  });

  test("maybeEmbedText fails open when the provider errors", async () => {
    setEmbedder(failingEmbedder);
    expect(await maybeEmbedText("anything")).toBeNull();
  });

  test("cosineSimilarity basics", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([], [1])).toBe(0);
  });
});

describe("automated embedding on remember", () => {
  test("remember stores the vector and model when configured", async () => {
    setEmbedder(fakeEmbedder());
    const r = (await engine.remember(ctx, {
      text: "I love espresso coffee",
      kind: "preference",
    })) as {
      memory_id: string;
    };
    const doc = await db
      .collection<MemoryDoc>("memories")
      .findOne({ user_id: ctx.user_id, memory_id: r.memory_id });
    expect(doc?.embedding?.[0]).toBeGreaterThan(0);
    expect(doc?.embedding_model).toBe("fake-embed-1");
  });

  test("embedding failure never blocks the write (fail-open)", async () => {
    setEmbedder(failingEmbedder);
    const r = (await engine.remember(ctx, { text: "write survives outage", kind: "fact" })) as {
      memory_id: string;
    };
    const doc = await db
      .collection<MemoryDoc>("memories")
      .findOne({ user_id: ctx.user_id, memory_id: r.memory_id });
    expect(doc).not.toBeNull();
    expect(doc?.embedding).toBeUndefined();
  });
});

describe("embed-backfill", () => {
  test("embeds memories missing vectors in batches", async () => {
    setEmbedder(null);
    await engine.remember(ctx, { text: "mongodb database tuning", kind: "fact" });
    await engine.remember(ctx, { text: "guitar practice schedule", kind: "fact" });
    setEmbedder(fakeEmbedder());
    const report = await embedBackfill(db, ctx.user_id, { batchSize: 1 });
    expect(report.embedded).toBe(2);
    expect(report.remaining).toBe(0);
    const docs = await db
      .collection<MemoryDoc>("memories")
      .find({ user_id: ctx.user_id, embedding: { $exists: true } })
      .toArray();
    expect(docs.length).toBe(2);
  });

  test("reports remaining when no embedder is configured", async () => {
    setEmbedder(null);
    await engine.remember(ctx, { text: "unembedded note", kind: "fact" });
    const report = await embedBackfill(db, ctx.user_id);
    expect(report.embedded).toBe(0);
    expect(report.remaining).toBe(1);
  });

  test("fails open when the provider errors mid-backfill", async () => {
    setEmbedder(null);
    await engine.remember(ctx, { text: "still unembedded", kind: "fact" });
    setEmbedder(failingEmbedder);
    const report = await embedBackfill(db, ctx.user_id);
    expect(report.failed).toBe(1);
    expect(report.remaining).toBe(1);
  });

  test("terminates when the provider returns degenerate (empty) vectors", async () => {
    setEmbedder(null);
    await engine.remember(ctx, { text: "degenerate one", kind: "fact" });
    await engine.remember(ctx, { text: "degenerate two", kind: "fact" });
    setEmbedder({
      model: "empty-vectors",
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => []);
      },
    });
    const report = await embedBackfill(db, ctx.user_id, { batchSize: 1 });
    expect(report.embedded).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.scanned).toBe(2);
    expect(report.remaining).toBe(2);
  });
});

describe("vector arm (exact cosine fallback)", () => {
  test("recall surfaces semantically-near memories with high_vector evidence", async () => {
    setEmbedder(fakeEmbedder());
    await engine.remember(ctx, { text: "morning latte ritual", kind: "preference" });
    await engine.remember(ctx, { text: "guitar strings need replacing", kind: "fact" });
    const r = await engine.recall(ctx, { query: "espresso coffee" });
    expect(r.abstained).toBe(false);
    const hit = r.results.find((x) => x.text === "morning latte ritual");
    expect(hit).toBeDefined();
    expect(hit?.evidence).toBe("high_vector");
    expect(r.results.some((x) => x.text.includes("guitar"))).toBe(false);
  });

  test("vectors from a different embedding model are ignored", async () => {
    setEmbedder(fakeEmbedder("old-model"));
    await engine.remember(ctx, { text: "morning latte ritual v2", kind: "preference" });
    setEmbedder(fakeEmbedder("new-model"));
    const r = await engine.recall(ctx, { query: "espresso coffee" });
    const hit = r.results.find((x) => x.text === "morning latte ritual v2");
    expect(hit?.evidence ?? "none").not.toBe("high_vector");
  });

  test("query embedding failure fails open to lexical arms", async () => {
    setEmbedder(fakeEmbedder());
    await engine.remember(ctx, { text: "espresso machine descaling", kind: "fact" });
    setEmbedder(failingEmbedder);
    const r = await engine.recall(ctx, { query: "espresso descaling" });
    expect(r.abstained).toBe(false);
    expect(r.results.some((x) => x.text.includes("espresso machine"))).toBe(true);
  });
});

describe("$graphLookup graph arm", () => {
  async function seedGraph() {
    const a = await engine.upsertEntity(ctx, { slug: "acme", type: "org", names: ["Acme"] });
    const b = await engine.upsertEntity(ctx, { slug: "widgetline", type: "project" });
    const c = await engine.upsertEntity(ctx, { slug: "gearbox", type: "project" });
    const edge = (src: string, dst: string) => ({
      user_id: ctx.user_id,
      edge_id: `edg_${src.slice(-4)}${dst.slice(-4)}`,
      src,
      dst,
      rel: "works_on",
      weight: 1,
      valid_from: new Date().toISOString(),
      valid_until: null,
      superseded_by: null,
      prov: {
        episode_id: null,
        harness: "claude-code",
        agent: "test-agent",
        method: "deterministic",
        confidence: 1,
        extracted_at: new Date().toISOString(),
      },
    });
    await db
      .collection("edges")
      .insertMany([edge(a.entity_id, b.entity_id), edge(b.entity_id, c.entity_id)]);
    return { a, b, c };
  }

  test("recall reaches memories of neighbor entities with graph_hit evidence", async () => {
    const { b, c } = await seedGraph();
    await engine.remember(ctx, {
      text: "shipping milestone slipped to June",
      kind: "fact",
      entity_refs: [b.entity_id],
    });
    await engine.remember(ctx, {
      text: "prototype passed thermal testing",
      kind: "fact",
      entity_refs: [c.entity_id],
    });
    const r = await engine.recall(ctx, { query: "acme" });
    expect(r.abstained).toBe(false);
    const depth1 = r.results.find((x) => x.text.includes("shipping milestone"));
    const depth2 = r.results.find((x) => x.text.includes("thermal testing"));
    expect(depth1?.evidence).toBe("graph_hit");
    expect(depth2?.evidence).toBe("graph_hit");
    expect((depth1?.score ?? 0) > (depth2?.score ?? 0)).toBe(true);
  });

  test("graph arm respects maxDepth", async () => {
    const { b, c } = await seedGraph();
    await engine.remember(ctx, {
      text: "depth one note about the line",
      kind: "fact",
      entity_refs: [b.entity_id],
    });
    await engine.remember(ctx, {
      text: "depth two note about the box",
      kind: "fact",
      entity_refs: [c.entity_id],
    });
    const { hybridRecall } = await import("../src/retrieval.js");
    const { scored } = await hybridRecall(db, ctx, { query: "acme", graphDepth: 1 }, {});
    expect(scored.some((s) => s.doc.text.includes("depth one"))).toBe(true);
    expect(scored.some((s) => s.doc.text.includes("depth two"))).toBe(false);
  });

  test("graph arm follows reverse edges too", async () => {
    const a = await engine.upsertEntity(ctx, { slug: "zenith", type: "org", names: ["Zenith"] });
    const b = await engine.upsertEntity(ctx, { slug: "upstream", type: "project" });
    await db.collection("edges").insertOne({
      user_id: ctx.user_id,
      edge_id: "edg_rev1",
      src: b.entity_id,
      dst: a.entity_id,
      rel: "owned_by",
      weight: 1,
      valid_from: new Date().toISOString(),
      valid_until: null,
      superseded_by: null,
      prov: {
        episode_id: null,
        harness: "claude-code",
        agent: "test-agent",
        method: "deterministic",
        confidence: 1,
        extracted_at: new Date().toISOString(),
      },
    });
    await engine.remember(ctx, {
      text: "quarterly report drafted",
      kind: "fact",
      entity_refs: [b.entity_id],
    });
    const r = await engine.recall(ctx, { query: "zenith" });
    expect(r.results.find((x) => x.text.includes("quarterly"))?.evidence).toBe("graph_hit");
  });
});

describe("native $rankFusion gate", () => {
  test("parseMongoVersion", () => {
    expect(parseMongoVersion("8.1.0")).toEqual([8, 1]);
    expect(parseMongoVersion("7.0.14")).toEqual([7, 0]);
    expect(parseMongoVersion("nonsense")).toBeNull();
  });

  test("versionSupportsRankFusion requires 8.1+", () => {
    expect(versionSupportsRankFusion("8.1.0")).toBe(true);
    expect(versionSupportsRankFusion("9.0.0")).toBe(true);
    expect(versionSupportsRankFusion("8.0.4")).toBe(false);
    expect(versionSupportsRankFusion("7.0.14")).toBe(false);
    expect(versionSupportsRankFusion("garbage")).toBe(false);
  });

  test("ME0_RANK_FUSION env flag overrides detection", async () => {
    process.env.ME0_RANK_FUSION = "false";
    expect(await supportsNativeRankFusion(db)).toBe(false);
    process.env.ME0_RANK_FUSION = "true";
    expect(await supportsNativeRankFusion(db)).toBe(true);
  });

  test("recall stays correct whichever fusion path the server supports", async () => {
    // integration: when the test server can't run $rankFusion the forced
    // native path must fail open to in-process fusion with identical shape
    process.env.ME0_RANK_FUSION = "true";
    await engine.remember(ctx, { text: "biome lint config decision", kind: "decision" });
    const r = await engine.recall(ctx, { query: "biome lint decision" });
    expect(r.abstained).toBe(false);
    const hit = r.results.find((x) => x.text.includes("biome lint"));
    expect(hit).toBeDefined();
    expect(["keyword", "weak_semantic"]).toContain(hit?.evidence ?? "");
  });

  test("native $rankFusion path (skipped unless the server supports it)", async () => {
    Reflect.deleteProperty(process.env, "ME0_RANK_FUSION");
    const info = (await db.admin().serverInfo()) as { version?: string };
    if (!versionSupportsRankFusion(info.version ?? "")) {
      console.log(`skipping native $rankFusion integration (server ${info.version})`);
      return;
    }
    await engine.remember(ctx, { text: "native fusion smoke memory", kind: "fact" });
    const r = await engine.recall(ctx, { query: "native fusion smoke" });
    expect(r.abstained).toBe(false);
    expect(r.results.some((x) => x.text.includes("native fusion"))).toBe(true);
  });
});
