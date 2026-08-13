import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Me0Engine, type OperationContext, type Store, connect, ensureCollections } from "me0-core";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { importOpenClawWorkspace, parseMarkdownItems } from "../src/import-openclaw.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "openclaw-workspace");

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "test-user",
  harness: "openclaw",
  agent: "openclaw-import",
  episode_id: null,
  remote: false,
};

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

describe("parseMarkdownItems", () => {
  test("extracts bullets and paragraphs, skips headings, fences, and short items", () => {
    const items = parseMarkdownItems(
      "# Head\n\n- bullet item one\n\n```sh\nrm -rf /\n```\n\nA paragraph\nspanning lines.\n\n- x\n",
    );
    expect(items).toEqual(["bullet item one", "A paragraph spanning lines."]);
  });
});

describe("import-openclaw round-trip", () => {
  test("imports memory files and daily logs deterministically", async () => {
    const s = await importOpenClawWorkspace(engine, db, ctx, FIXTURE);
    // MEMORY.md: 3 items (code fence + "Short" skipped), USER.md: 2, SOUL.md: 1
    expect(s.memories_added).toBe(6);
    expect(s.memories_skipped).toBe(0);
    expect(s.episodes_added).toBe(2);
    expect(s.episodes_skipped).toBe(0);

    const recall = await engine.recall(ctx, { query: "TypeScript" });
    expect(recall.abstained).toBe(false);
    expect(recall.results.some((r) => r.text.includes("Prefers TypeScript"))).toBe(true);
    expect(recall.results.every((r) => r.kind !== undefined)).toBe(true);

    const nothing = await engine.recall(ctx, { query: "rm -rf" });
    expect(nothing.results.every((r) => !r.text.includes("rm -rf"))).toBe(true);

    const episodes = await db
      .collection("episodes")
      .find({ user_id: ctx.user_id, tags: "openclaw-import" })
      .sort({ started_at: 1 })
      .toArray();
    expect(episodes.length).toBe(2);
    expect(episodes[0]?.started_at).toBe("2026-08-10T00:00:00.000Z");
    expect(episodes[0]?.status).toBe("ended");
    expect(episodes[0]?.harness).toBe("openclaw");
    expect(String(episodes[0]?.summary)).toContain("auth bug");

    const events = await db
      .collection("events")
      .find({ episode_id: episodes[0]?.episode_id })
      .toArray();
    expect(events.length).toBe(2);
  });

  test("re-running is idempotent", async () => {
    const s = await importOpenClawWorkspace(engine, db, ctx, FIXTURE);
    expect(s.memories_added).toBe(0);
    expect(s.memories_skipped).toBe(6);
    expect(s.episodes_added).toBe(0);
    expect(s.episodes_skipped).toBe(2);
    expect(await db.collection("episodes").countDocuments({ user_id: ctx.user_id })).toBe(2);
  });

  test("imported memories carry openclaw provenance", async () => {
    const mem = await db
      .collection("memories")
      .findOne({ user_id: ctx.user_id, text: /Prefers TypeScript/ });
    expect(mem?.prov?.harness).toBe("openclaw");
    expect(mem?.prov?.method).toBe("deterministic");
    expect(mem?.kind).toBe("preference");
  });
});
