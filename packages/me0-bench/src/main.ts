#!/usr/bin/env bun
import { type OperationContext, connect, ensureCollections } from "me0-core";
import { passes, runBench } from "./bench.js";

const uri = process.env.ME0_MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const ctx: OperationContext = {
  user_id: `bench_${Date.now()}`,
  harness: "other",
  agent: "me0-bench",
  episode_id: null,
  remote: false,
};

const store = await connect(uri);
try {
  await ensureCollections(store.db);
  const scores = await runBench(store.db, ctx);
  console.log(JSON.stringify(scores, null, 2));
  process.exit(passes(scores) ? 0 : 1);
} finally {
  await store.close();
}
