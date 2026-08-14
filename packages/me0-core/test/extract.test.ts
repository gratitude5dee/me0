import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Me0Engine } from "../src/engine.js";
import {
  type LlmMessage,
  type LlmProvider,
  MAX_EXTRACTED_ITEMS,
  buildExtractionPrompt,
  extractEpisode,
  extractUnextractedEpisodes,
  parseExtraction,
  providerFromEnv,
} from "../src/extract.js";
import { type Store, connect, ensureCollections } from "../src/store/mongo.js";
import type { EpisodeDoc, EventDoc, MemoryDoc, OperationContext } from "../src/types.js";

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "extract-user",
  harness: "claude-code",
  agent: "test-agent",
  episode_id: null,
  remote: false,
};

function fakeProvider(response: string): LlmProvider {
  return { complete: async () => response };
}

async function startEpisode(withEvents = true): Promise<string> {
  const ep = (await engine.episodeStart(ctx, { title: "test session" })) as {
    episode_id: string;
  };
  if (withEvents) {
    await engine.episodeLog(ctx, {
      episode_id: ep.episode_id,
      type: "prompt",
      payload: { text: "I prefer bun over npm" },
    });
    await engine.episodeLog(ctx, {
      episode_id: ep.episode_id,
      type: "response",
      payload: { text: "noted" },
    });
  }
  await engine.episodeEnd(ctx, { episode_id: ep.episode_id, summary: "prefs discussed" });
  return ep.episode_id;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  db = store.db;
  await ensureCollections(db);
  engine = new Me0Engine(db);
  await engine.ensureUser(ctx);
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("parseExtraction", () => {
  test("parses a valid array and clamps confidence", () => {
    const items = parseExtraction(
      JSON.stringify([
        {
          text: "User prefers bun over npm",
          kind: "preference",
          tier: "standing",
          confidence: 1.7,
        },
        {
          text: "The repo uses biome for linting",
          kind: "fact",
          confidence: -2,
          entities: ["biome"],
        },
      ]),
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.confidence).toBe(1);
    expect(items[1]?.confidence).toBe(0);
    expect(items[1]?.entities).toEqual(["biome"]);
  });

  test("drops invalid items instead of failing", () => {
    const items = parseExtraction(
      JSON.stringify([
        { text: "valid memory about project state", kind: "fact", confidence: 0.9 },
        { text: "bad kind stays out", kind: "banana", confidence: 0.9 },
        { kind: "fact", confidence: 0.9 },
        { text: "short", kind: "fact" },
        "not an object",
      ]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("fact");
  });

  test("invalid tier suggestions fall back to recall; core is not allowed", () => {
    const items = parseExtraction(
      JSON.stringify([
        { text: "tier gets clamped here", kind: "fact", tier: "core", confidence: 0.9 },
      ]),
    );
    expect(items[0]?.tier).toBe("recall");
  });

  test("handles fenced JSON and surrounding prose", () => {
    const raw =
      'Here you go:\n```json\n[{"text":"User decided to ship v0.4 next week","kind":"decision","confidence":0.8}]\n```';
    expect(parseExtraction(raw)).toHaveLength(1);
  });

  test("malformed output yields empty array (honest abstention)", () => {
    expect(parseExtraction("I could not find anything")).toEqual([]);
    expect(parseExtraction("[{broken json")).toEqual([]);
    expect(parseExtraction('{"not":"an array"}')).toEqual([]);
    expect(parseExtraction("")).toEqual([]);
  });

  test("caps the item count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      text: `durable fact number ${i} about the project`,
      kind: "fact",
      confidence: 0.9,
    }));
    expect(parseExtraction(JSON.stringify(many))).toHaveLength(MAX_EXTRACTED_ITEMS);
  });
});

describe("providerFromEnv", () => {
  test("returns null when unconfigured", () => {
    expect(providerFromEnv({})).toBeNull();
    expect(providerFromEnv({ ME0_LLM_BASE_URL: "http://x" })).toBeNull();
  });
  test("returns a provider when base url and model are set", () => {
    expect(
      providerFromEnv({ ME0_LLM_BASE_URL: "http://localhost:1", ME0_LLM_MODEL: "m" }),
    ).not.toBeNull();
  });
});

describe("buildExtractionPrompt", () => {
  test("includes episode header and event lines", async () => {
    const epId = await startEpisode();
    const episode = await db.collection<EpisodeDoc>("episodes").findOne({ episode_id: epId });
    const events = await db.collection<EventDoc>("events").find({ episode_id: epId }).toArray();
    if (!episode) throw new Error("episode missing");
    const messages: LlmMessage[] = buildExtractionPrompt(episode, events);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("STRICT JSON");
    expect(messages[1]?.content).toContain("bun over npm");
  });
});

describe("extractEpisode", () => {
  test("writes memories with prov.method llm and marks the episode", async () => {
    const epId = await startEpisode();
    const provider = fakeProvider(
      JSON.stringify([
        {
          text: "User prefers bun over npm for this monorepo",
          kind: "preference",
          tier: "standing",
          confidence: 0.9,
        },
        { text: "Low confidence guess about something", kind: "belief", confidence: 0.2 },
      ]),
    );
    const r = await extractEpisode(db, ctx, epId, provider);
    expect(r.added).toBe(1);
    expect(r.skipped_low_confidence).toBe(1);
    const mem = await db
      .collection<MemoryDoc>("memories")
      .findOne({ user_id: ctx.user_id, memory_id: r.memory_ids[0] });
    expect(mem?.prov.method).toBe("llm");
    expect(mem?.prov.episode_id).toBe(epId);
    expect(mem?.prov.harness).toBe("claude-code");
    expect(mem?.visibility).toBe("private");
    expect(mem?.tier).toBe("standing");
    expect(mem?.confidence).toBe(0.9);
    const episode = await db.collection<EpisodeDoc>("episodes").findOne({ episode_id: epId });
    expect(typeof episode?.extracted_at).toBe("string");
  });

  test("re-extraction is idempotent via normalized dedupe", async () => {
    const epId = await startEpisode();
    const provider = fakeProvider(
      JSON.stringify([
        { text: "The deploy target is Vercel for this project", kind: "fact", confidence: 0.9 },
      ]),
    );
    const first = await extractEpisode(db, ctx, epId, provider);
    expect(first.added).toBe(1);
    // same content, different whitespace/case → normalized duplicate
    const again = await extractEpisode(
      db,
      ctx,
      epId,
      fakeProvider(
        JSON.stringify([
          { text: "the  deploy target is  vercel for this project", kind: "fact", confidence: 0.9 },
        ]),
      ),
    );
    expect(again.added).toBe(0);
    expect(again.skipped_duplicates).toBe(1);
  });

  test("malformed LLM output writes nothing but still marks the episode", async () => {
    const epId = await startEpisode();
    const before = await db.collection("memories").countDocuments({ user_id: ctx.user_id });
    const r = await extractEpisode(db, ctx, epId, fakeProvider("sorry, no json here"));
    expect(r.added).toBe(0);
    expect(r.considered).toBe(0);
    const after = await db.collection("memories").countDocuments({ user_id: ctx.user_id });
    expect(after).toBe(before);
    const episode = await db.collection<EpisodeDoc>("episodes").findOne({ episode_id: epId });
    expect(typeof episode?.extracted_at).toBe("string");
  });

  test("empty episode is marked extracted without calling the LLM", async () => {
    const ep = (await engine.episodeStart(ctx, {})) as { episode_id: string };
    await engine.episodeEnd(ctx, { episode_id: ep.episode_id });
    let called = false;
    const provider: LlmProvider = {
      complete: async () => {
        called = true;
        return "[]";
      },
    };
    const r = await extractEpisode(db, ctx, ep.episode_id, provider);
    expect(called).toBe(false);
    expect(r.added).toBe(0);
  });

  test("throws for unknown episodes and remote callers", async () => {
    await expect(extractEpisode(db, ctx, "ep_nope", fakeProvider("[]"))).rejects.toThrow(
      "episode not found",
    );
    await expect(
      extractEpisode(db, { ...ctx, remote: true }, "ep_nope", fakeProvider("[]")),
    ).rejects.toThrow("not permitted for remote callers");
  });
});

describe("extractUnextractedEpisodes", () => {
  test("sweeps only unextracted ended episodes and is fail-open per episode", async () => {
    const sweepCtx: OperationContext = { ...ctx, user_id: "sweep-user" };
    const sweepEngine = engine;
    const a = (await sweepEngine.episodeStart(sweepCtx, {})) as { episode_id: string };
    await sweepEngine.episodeLog(sweepCtx, {
      episode_id: a.episode_id,
      type: "prompt",
      payload: { text: "we decided to use mongo" },
    });
    await sweepEngine.episodeEnd(sweepCtx, { episode_id: a.episode_id });
    const b = (await sweepEngine.episodeStart(sweepCtx, {})) as { episode_id: string };
    await sweepEngine.episodeLog(sweepCtx, {
      episode_id: b.episode_id,
      type: "prompt",
      payload: { text: "another session" },
    });
    await sweepEngine.episodeEnd(sweepCtx, { episode_id: b.episode_id });
    // still-active episode must not be swept
    const active = (await sweepEngine.episodeStart(sweepCtx, {})) as { episode_id: string };

    let calls = 0;
    const flaky: LlmProvider = {
      complete: async () => {
        calls++;
        if (calls === 1) throw new Error("llm outage");
        return JSON.stringify([
          {
            text: "The team decided to use MongoDB as the store",
            kind: "decision",
            confidence: 0.9,
          },
        ]);
      },
    };
    const r = await extractUnextractedEpisodes(db, sweepCtx, flaky);
    expect(r.episodes_scanned).toBe(2);
    expect(r.errors).toHaveLength(1);
    expect(r.extracted).toHaveLength(1);
    expect(r.extracted[0]?.added).toBe(1);

    // second sweep only retries the failed episode (the other is flagged)
    const r2 = await extractUnextractedEpisodes(db, sweepCtx, flaky);
    expect(r2.episodes_scanned).toBe(1);
    expect(r2.errors).toHaveLength(0);

    const activeDoc = await db
      .collection<EpisodeDoc>("episodes")
      .findOne({ episode_id: active.episode_id });
    expect(activeDoc?.extracted_at).toBeUndefined();
  });
});
