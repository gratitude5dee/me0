import type { MemoryDoc, OperationContext } from "me0-core";
import type { Db } from "mongodb";

export interface PredictionDoc {
  subject_type: "memory" | "entity" | "session" | "user";
  subject_id: string;
  task: "prefetch" | "forget" | "next_tool" | "success_risk" | "link" | "retrieval_utility";
  score: number;
  horizon: string;
  model: "kumo-rfm-2" | "heuristic";
  computed_at: string;
}

export interface HeuristicReport {
  retrieval_utility: number;
  prefetch: number;
  forget: number;
}

const DAY_MS = 86400000;

function decay(lastRetrievedAt: string | null, validFrom: string, accessCount: number): number {
  // never-retrieved memories decay from creation time, not from zero
  const anchor = lastRetrievedAt ?? validFrom;
  const days = (Date.now() - new Date(anchor).getTime()) / DAY_MS;
  // Ebbinghaus-style: strength grows with access count, decays with idle time
  return Math.exp(-days / (7 * (1 + Math.log1p(accessCount))));
}

/**
 * Keyless fallbacks for the RFM predictive tasks (goal.md §12): score
 * `predictions` deterministically from retrieval telemetry so every consumer
 * (retrieval rerank, pack assembly, dream tiering) works without KumoRFM.
 * Existing heuristic predictions for the user's memories are replaced.
 */
export async function runHeuristics(db: Db, ctx: OperationContext): Promise<HeuristicReport> {
  const computedAt = new Date().toISOString();
  const memories = await db
    .collection<MemoryDoc>("memories")
    .find({ user_id: ctx.user_id, deleted_at: null, valid_until: null })
    .toArray();
  const memoryIds = memories.map((m) => m.memory_id);

  // surfaced / used counts per memory from retrieval telemetry
  const surfaced = new Map<string, { surfaced: number; used: number }>();
  const rows = await db
    .collection("retrievals")
    .find({ user_id: ctx.user_id, memory_id: { $in: memoryIds } })
    .toArray();
  for (const r of rows) {
    const cur = surfaced.get(r.memory_id as string) ?? { surfaced: 0, used: 0 };
    cur.surfaced++;
    if (r.used === true) cur.used++;
    surfaced.set(r.memory_id as string, cur);
  }

  const preds: PredictionDoc[] = [];
  for (const m of memories) {
    const tel = surfaced.get(m.memory_id);
    // retrieval_utility: historical used/surfaced ratio. Only written when
    // positive `used` telemetry exists — with `used` unset the ratio would
    // decay with surfacing count and invert the ranking signal.
    if (tel && tel.used > 0) {
      preds.push({
        subject_type: "memory",
        subject_id: m.memory_id,
        task: "retrieval_utility",
        score: (tel.used + 0.5) / (tel.surfaced + 1),
        horizon: "7d",
        model: "heuristic",
        computed_at: computedAt,
      });
    }
    // prefetch: recency x frequency
    const strength = decay(m.access.last_retrieved_at, m.valid_from, m.access.count);
    if (strength > 0.05) {
      preds.push({
        subject_type: "memory",
        subject_id: m.memory_id,
        task: "prefetch",
        score: strength,
        horizon: "24h",
        model: "heuristic",
        computed_at: computedAt,
      });
    }
    // forget: Ebbinghaus decay — high score = safe to demote/archive
    preds.push({
      subject_type: "memory",
      subject_id: m.memory_id,
      task: "forget",
      score: 1 - strength,
      horizon: "90d",
      model: "heuristic",
      computed_at: computedAt,
    });
  }

  // replace ALL prior predictions (any model) for the user's memories,
  // including deleted/superseded ones, so exactly one score exists per
  // (memory, task) and retrieval ranking stays deterministic
  const allIds = await db
    .collection<MemoryDoc>("memories")
    .find({ user_id: ctx.user_id })
    .project<{ memory_id: string }>({ memory_id: 1 })
    .map((m) => m.memory_id)
    .toArray();
  const col = db.collection("predictions");
  if (allIds.length > 0) {
    await col.deleteMany({
      subject_type: "memory",
      subject_id: { $in: allIds },
    });
  }
  if (preds.length > 0) await col.insertMany(preds);

  return {
    retrieval_utility: preds.filter((p) => p.task === "retrieval_utility").length,
    prefetch: preds.filter((p) => p.task === "prefetch").length,
    forget: preds.filter((p) => p.task === "forget").length,
  };
}
