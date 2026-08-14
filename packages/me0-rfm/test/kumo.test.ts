import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Me0Engine, type OperationContext, type Store, connect, ensureCollections } from "me0-core";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  KumoBackend,
  heuristicBackend,
  jsonlToCsv,
  resolveBackendName,
  runPredictions,
} from "../src/index.js";

const FAKE_SERVER = join(import.meta.dir, "fake-kumo-server.ts");

let mongod: MongoMemoryServer;
let store: Store;
let engine: Me0Engine;
let workDir: string;

const ctx: OperationContext = {
  user_id: "u_kumo",
  harness: "other",
  agent: "kumo-test",
  episode_id: null,
  remote: false,
};

function fakeBackend(): KumoBackend {
  return new KumoBackend({
    apiKey: "fake-key",
    command: process.execPath,
    args: [FAKE_SERVER],
    workDir: mkdtempSync(join(tmpdir(), "me0-kumo-test-")),
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  await ensureCollections(store.db);
  engine = new Me0Engine(store.db);
  workDir = mkdtempSync(join(tmpdir(), "me0-kumo-"));

  await engine.remember(ctx, { text: "prefers conventional commits", kind: "preference" });
  await engine.remember(ctx, { text: "squash-merge only", kind: "decision" });
  const ep = (await engine.episodeStart(ctx, { title: "kumo test" })) as { episode_id: string };
  await engine.episodeLog(ctx, { episode_id: ep.episode_id, type: "tool_call", tool: "bash" });
  await engine.episodeEnd(ctx, { episode_id: ep.episode_id, summary: "done", success: true });
  await engine.recall(ctx, { query: "conventional commits" });
  await store.db
    .collection("retrievals")
    .updateMany({ user_id: ctx.user_id }, { $set: { used: true } });
});

afterAll(async () => {
  rmSync(workDir, { recursive: true, force: true });
  await store.close();
  await mongod.stop();
});

describe("backend selection", () => {
  test("defaults to heuristic; ME0_RFM_BACKEND=kumo selects kumo", () => {
    expect(resolveBackendName({})).toBe("heuristic");
    expect(resolveBackendName({ ME0_RFM_BACKEND: "kumo" })).toBe("kumo");
    expect(resolveBackendName({ ME0_RFM_BACKEND: "KUMO " })).toBe("kumo");
    expect(resolveBackendName({ ME0_RFM_BACKEND: "nonsense" })).toBe("heuristic");
  });
});

describe("jsonlToCsv", () => {
  test("escapes commas, quotes, and newlines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me0-csv-"));
    const jsonl = join(dir, "t.jsonl");
    const csv = join(dir, "t.csv");
    await Bun.write(jsonl, `${JSON.stringify({ a: 'he said "hi, there"', b: null, c: 2 })}\n`);
    expect(jsonlToCsv(jsonl, csv)).toBe(1);
    const text = await Bun.file(csv).text();
    expect(text).toBe('a,b,c\n"he said ""hi, there""",,2\n');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("kumo backend (fake MCP server over stdio)", () => {
  test("writes kumo predictions in the shared predictions shape", async () => {
    const report = await fakeBackend().predict(store.db, ctx);
    expect(report.backend).toBe("kumo");
    expect(report.counts.forget).toBe(2);
    expect(report.counts.retrieval_utility).toBe(2);
    expect(report.counts.prefetch).toBe(2);
    const preds = await store.db.collection("predictions").find({ model: "kumo-rfm-2" }).toArray();
    expect(preds.length).toBe(6);
    expect(preds.every((p) => p.subject_type === "memory")).toBe(true);
    expect(preds.every((p) => typeof p.score === "number")).toBe(true);
    const utility = preds.find((p) => p.task === "retrieval_utility");
    expect(utility?.score).toBe(0.8);
    expect(utility?.horizon).toBe("7d");
  });

  test("re-run replaces rather than accumulates", async () => {
    await fakeBackend().predict(store.db, ctx);
    const before = await store.db.collection("predictions").countDocuments({ model: "kumo-rfm-2" });
    await fakeBackend().predict(store.db, ctx);
    const after = await store.db.collection("predictions").countDocuments({ model: "kumo-rfm-2" });
    expect(after).toBe(before);
  });

  test("each backend run replaces the other model's predictions (one score per memory)", async () => {
    await heuristicBackend.predict(store.db, ctx);
    await fakeBackend().predict(store.db, ctx);
    const models = await store.db.collection("predictions").distinct("model");
    expect(models).toEqual(["kumo-rfm-2"]);
    await heuristicBackend.predict(store.db, ctx);
    const after = await store.db.collection("predictions").distinct("model");
    expect(after).toEqual(["heuristic"]);
  });

  test("missing API key fails with clear guidance", async () => {
    const backend = new KumoBackend({ command: process.execPath, args: [FAKE_SERVER] });
    const prev = { a: process.env.ME0_KUMO_API_KEY, b: process.env.KUMO_API_KEY };
    // empty string reads as "unset" (falsy) without the delete operator
    process.env.ME0_KUMO_API_KEY = "";
    process.env.KUMO_API_KEY = "";
    try {
      await expect(backend.predict(store.db, ctx)).rejects.toThrow(/ME0_KUMO_API_KEY/);
    } finally {
      process.env.ME0_KUMO_API_KEY = prev.a ?? "";
      process.env.KUMO_API_KEY = prev.b ?? "";
    }
  });
});

describe("runPredictions fail-open policy", () => {
  function unauthorizedBackend(): KumoBackend {
    return new KumoBackend({
      apiKey: "bad-key",
      command: process.execPath,
      args: [FAKE_SERVER],
      env: { FAKE_KUMO_MODE: "unauthorized" },
      workDir: mkdtempSync(join(tmpdir(), "me0-kumo-bad-")),
    });
  }

  test("explicit invocation surfaces kumo failures with setup guidance", async () => {
    await expect(
      runPredictions(store.db, ctx, { backend: unauthorizedBackend(), invocation: "explicit" }),
    ).rejects.toThrow(/kumo backend failed/);
  });

  test("automated invocation falls back silently to heuristics", async () => {
    const report = await runPredictions(store.db, ctx, {
      backend: unauthorizedBackend(),
      invocation: "auto",
    });
    expect(report.backend).toBe("heuristic");
    expect(report.fallback).toContain("Unauthorized");
    expect(report.counts.forget).toBeGreaterThan(0);
  });

  test("heuristic name routes to the heuristic backend", async () => {
    const report = await runPredictions(store.db, ctx, { backend: "heuristic" });
    expect(report.backend).toBe("heuristic");
  });
});
