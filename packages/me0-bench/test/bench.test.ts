import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type OperationContext, type Store, connect, ensureCollections } from "me0-core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { type BenchScores, THRESHOLDS, passes, runBench } from "../src/bench.js";

let mongod: MongoMemoryServer;
let store: Store;
let scores: BenchScores;

const ctx: OperationContext = {
  user_id: "u_bench",
  harness: "other",
  agent: "me0-bench-test",
  episode_id: null,
  remote: false,
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  await ensureCollections(store.db);
  scores = await runBench(store.db, ctx);
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("me0-bench", () => {
  test("recall P@1 meets threshold", () => {
    expect(scores.recall_p_at_1).toBeGreaterThanOrEqual(THRESHOLDS.recall_p_at_1);
  });

  test("abstains on all adversarial probes", () => {
    expect(scores.abstention_accuracy).toBe(1);
  });

  test("push never fires on unrelated prompts", () => {
    expect(scores.push_false_fire_rate).toBe(0);
  });

  test("push fires on related prompts", () => {
    expect(scores.push_hit_rate).toBeGreaterThanOrEqual(THRESHOLDS.push_hit_rate);
  });

  test("context pack respects budget", () => {
    expect(scores.pack_budget_adherence).toBe(true);
    expect(scores.pack_budget_used).toBeLessThanOrEqual(700);
  });

  test("handoff continuity across harnesses", () => {
    expect(scores.continuity_resume_ok).toBe(true);
  });

  test("overall bench passes", () => {
    expect(passes(scores)).toBe(true);
  });
});
