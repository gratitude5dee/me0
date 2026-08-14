import { type OperationContext, connect, ensureCollections } from "me0-core";
import { type BackendName, resolveBackendName, runPredictions } from "me0-rfm";
import { loadConfig } from "./config.js";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** `me0 rfm predict [--backend heuristic|kumo]` — score predictions via the selected backend. */
export async function cmdRfmPredict(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const uri = flagValue(args, "--uri") ?? cfg.mongodb_uri;
  const userId = flagValue(args, "--user") ?? cfg.user_id;
  const raw = flagValue(args, "--backend");
  let backend: BackendName;
  if (raw === undefined) {
    backend = resolveBackendName();
  } else if (raw === "heuristic" || raw === "kumo") {
    backend = raw;
  } else {
    console.error(`unknown backend: ${raw} (expected heuristic|kumo)`);
    process.exit(1);
  }
  const ctx: OperationContext = {
    user_id: userId,
    harness: "other",
    agent: "me0-cli",
    episode_id: process.env.ME0_EPISODE_ID ?? null,
    remote: false,
  };
  const store = await connect(uri);
  try {
    await ensureCollections(store.db);
    const report = await runPredictions(store.db, ctx, { backend, invocation: "explicit" });
    console.log(
      `rfm (${report.backend}): ${report.counts.retrieval_utility} retrieval_utility, ${report.counts.prefetch} prefetch, ${report.counts.forget} forget predictions written`,
    );
  } finally {
    await store.close();
  }
}
