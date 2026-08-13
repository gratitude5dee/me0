import type { Db } from "mongodb";
import { hybridRecall } from "./retrieval.js";
import type { OperationContext, UserDoc } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

export interface PushResult {
  protocol_version: number;
  pushed: Array<{ memory_id: string; text: string; kind: string; score: number }>;
  suppressed_count: number;
}

/**
 * Gated per-turn ambient recall: confidence-gated (user settings, default >=0.7),
 * capped per turn (default 3), and suppressed for memories already surfaced
 * this session (session_state.surfaced).
 */
export async function push(
  db: Db,
  ctx: OperationContext,
  args: { prompt: string; episode_id?: string },
): Promise<PushResult> {
  const user = await db.collection<UserDoc>("users").findOne({ user_id: ctx.user_id });
  const minConfidence = user?.settings.push.min_confidence ?? 0.7;
  const maxPerTurn = user?.settings.push.max_per_turn ?? 3;
  const episodeId = args.episode_id ?? ctx.episode_id ?? "anonymous";

  const visibility = ctx.remote ? { visibility: "world" } : {};
  // prompts are long free text: any content-word overlap qualifies (confidence gate follows)
  const { scored } = await hybridRecall(
    db,
    ctx,
    { query: args.prompt, limit: 10, minMatchFraction: 0.01 },
    visibility,
  );

  const stateCol = db.collection("session_state");
  const state = await stateCol.findOne({ episode_id: episodeId });
  const surfaced = new Set<string>((state?.surfaced as string[] | undefined) ?? []);

  let suppressed = 0;
  const eligible = scored.filter((s) => {
    if (s.doc.confidence < minConfidence) return false;
    if (surfaced.has(s.doc.memory_id)) {
      suppressed++;
      return false;
    }
    return true;
  });
  const pushed = eligible.slice(0, maxPerTurn);

  if (pushed.length > 0) {
    const ts = new Date().toISOString();
    await stateCol.updateOne(
      { episode_id: episodeId },
      {
        $addToSet: { surfaced: { $each: pushed.map((p) => p.doc.memory_id) } },
        $set: { updated_at: ts },
        $setOnInsert: { standing_entities: [], delta_cursor: "1970-01-01T00:00:00.000Z" },
      },
      { upsert: true },
    );
    await db.collection("retrievals").insertMany(
      pushed.map((p, i) => ({
        ts,
        user_id: ctx.user_id,
        episode_id: episodeId,
        memory_id: p.doc.memory_id,
        surface: "push",
        rank: i,
        score: p.score,
        used: null,
      })),
    );
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    pushed: pushed.map((p) => ({
      memory_id: p.doc.memory_id,
      text: p.doc.text,
      kind: p.doc.kind,
      score: Math.round(p.score * 1000) / 1000,
    })),
    suppressed_count: suppressed,
  };
}
