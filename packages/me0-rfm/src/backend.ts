import type { OperationContext } from "me0-core";
import type { Db } from "mongodb";
import { runHeuristics } from "./heuristics.js";

export type BackendName = "heuristic" | "kumo";

export interface PredictionReport {
  backend: BackendName;
  counts: { retrieval_utility: number; prefetch: number; forget: number };
  /** set when an automated kumo run fell back to heuristics (fail-open) */
  fallback?: string;
}

export interface PredictionBackend {
  readonly name: BackendName;
  predict(db: Db, ctx: OperationContext): Promise<PredictionReport>;
}

export const heuristicBackend: PredictionBackend = {
  name: "heuristic",
  async predict(db, ctx) {
    const h = await runHeuristics(db, ctx);
    return { backend: "heuristic", counts: h };
  },
};

/** ME0_RFM_BACKEND=heuristic|kumo; unset/unknown values keep the zero-dependency default. */
export function resolveBackendName(
  env: Record<string, string | undefined> = process.env,
): BackendName {
  return env.ME0_RFM_BACKEND?.trim().toLowerCase() === "kumo" ? "kumo" : "heuristic";
}

export interface RunPredictionsOptions {
  /** backend instance or name; defaults to resolveBackendName() */
  backend?: PredictionBackend | BackendName;
  /**
   * "explicit" (CLI `me0 rfm predict --backend kumo`): kumo failures surface
   * as clear errors. "auto" (dream cycle): fail-open — kumo failures fall
   * back silently to the heuristic backend so memory never blocks the agent.
   */
  invocation?: "explicit" | "auto";
}

export async function runPredictions(
  db: Db,
  ctx: OperationContext,
  opts: RunPredictionsOptions = {},
): Promise<PredictionReport> {
  const requested = opts.backend ?? resolveBackendName();
  let backend: PredictionBackend;
  if (typeof requested === "string") {
    if (requested === "kumo") {
      const { KumoBackend } = await import("./kumo.js");
      backend = new KumoBackend();
    } else {
      backend = heuristicBackend;
    }
  } else {
    backend = requested;
  }
  if (backend.name === "heuristic") return backend.predict(db, ctx);
  try {
    return await backend.predict(db, ctx);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if ((opts.invocation ?? "explicit") === "explicit") {
      throw new Error(
        `kumo backend failed: ${detail}\nSetup: pip install kumo-rfm-mcp, set ME0_KUMO_API_KEY (free key at https://kumorfm.ai), optionally ME0_KUMO_MCP_COMMAND to override the server command. Or rerun with --backend heuristic.`,
      );
    }
    const report = await heuristicBackend.predict(db, ctx);
    return { ...report, fallback: detail };
  }
}
