import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Me0Engine, type OperationContext, type Store, connect, ensureCollections } from "me0-core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { exportTables, runHeuristics } from "../src/index.js";

let mongod: MongoMemoryServer;
let store: Store;
let engine: Me0Engine;
let outDir: string;

const ctx: OperationContext = {
  user_id: "u_rfm",
  harness: "other",
  agent: "rfm-test",
  episode_id: null,
  remote: false,
};

const other: OperationContext = { ...ctx, user_id: "u_other" };

function readRows(name: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(outDir, `${name}.jsonl`), "utf-8").trim();
  return raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  await ensureCollections(store.db);
  engine = new Me0Engine(store.db);
  outDir = mkdtempSync(join(tmpdir(), "me0-rfm-"));

  await engine.remember(ctx, { text: "prefers conventional commits", kind: "preference" });
  await engine.remember(ctx, { text: "squash-merge only", kind: "decision" });
  await engine.remember(other, { text: "other user memory", kind: "fact" });
  const ep = (await engine.episodeStart(ctx, { title: "rfm test" })) as { episode_id: string };
  await engine.episodeLog(ctx, { episode_id: ep.episode_id, type: "tool_call", tool: "bash" });
  await engine.episodeEnd(ctx, { episode_id: ep.episode_id, summary: "done", success: true });
  // generate retrieval telemetry
  await engine.recall(ctx, { query: "conventional commits" });
  await store.db
    .collection("retrievals")
    .updateMany({ user_id: ctx.user_id }, { $set: { used: true } });
});

afterAll(async () => {
  rmSync(outDir, { recursive: true, force: true });
  await store.close();
  await mongod.stop();
});

describe("export", () => {
  test("writes flat tables scoped to the user", async () => {
    const report = await exportTables(store.db, ctx.user_id, outDir);
    const names = report.tables.map((t) => t.name).sort();
    expect(names).toEqual(
      ["edges", "entities", "memories", "outcomes", "retrievals", "sessions", "tool_calls"].sort(),
    );
    const memories = readRows("memories");
    expect(memories.length).toBe(2);
    expect(memories.every((m) => m.user_id === ctx.user_id)).toBe(true);
    expect(readRows("sessions").length).toBe(1);
    expect(readRows("tool_calls").length).toBe(1);
    expect(readRows("outcomes")[0]?.success).toBe(true);
  });

  test("redacts free text by default; --no-redact keeps it", async () => {
    expect(readRows("memories").every((m) => m.text === null)).toBe(true);
    await exportTables(store.db, ctx.user_id, outDir, { redact: false });
    expect(readRows("memories").some((m) => m.text === "squash-merge only")).toBe(true);
  });
});

describe("heuristics", () => {
  test("writes predictions consumed by retrieval ranking", async () => {
    const report = await runHeuristics(store.db, ctx);
    expect(report.retrieval_utility).toBeGreaterThan(0);
    expect(report.forget).toBe(2);
    const preds = await store.db
      .collection("predictions")
      .find({ task: "retrieval_utility" })
      .toArray();
    expect(preds.length).toBeGreaterThan(0);
    expect(preds.every((p) => p.model === "heuristic")).toBe(true);
    expect(preds.every((p) => p.score > 0 && p.score <= 1)).toBe(true);
    // consumed opportunistically by hybridRecall
    const r = await engine.recall(ctx, { query: "conventional commits" });
    expect(r.results[0]?.text).toContain("conventional commits");
  });

  test("re-run replaces rather than accumulates", async () => {
    const before = await store.db.collection("predictions").countDocuments({ model: "heuristic" });
    await runHeuristics(store.db, ctx);
    const after = await store.db.collection("predictions").countDocuments({ model: "heuristic" });
    expect(after).toBe(before);
  });
});
