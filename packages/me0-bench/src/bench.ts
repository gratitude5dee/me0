import { Me0Engine, type OperationContext } from "me0-core";
import type { Db } from "mongodb";
import {
  ABSTENTION_PROBES,
  FIXTURE_ENTITIES,
  FIXTURE_MEMORIES,
  PUSH_NEGATIVE_PROMPTS,
  PUSH_POSITIVE_PROMPTS,
  RECALL_PROBES,
} from "./fixtures.js";

export interface BenchScores {
  recall_p_at_1: number;
  abstention_accuracy: number;
  push_false_fire_rate: number;
  push_hit_rate: number;
  pack_budget_adherence: boolean;
  pack_budget_used: number;
  continuity_resume_ok: boolean;
}

export const THRESHOLDS = {
  recall_p_at_1: 0.8,
  abstention_accuracy: 1.0,
  push_false_fire_rate: 0.0,
  push_hit_rate: 0.5,
};

export async function seedFixtures(engine: Me0Engine, ctx: OperationContext): Promise<void> {
  const slugToId = new Map<string, string>();
  for (const e of FIXTURE_ENTITIES) {
    const doc = await engine.upsertEntity(ctx, {
      slug: e.slug,
      type: e.type,
      names: e.names,
      card: e.card,
      status: "verified",
    });
    slugToId.set(e.slug, doc.entity_id);
  }
  for (const m of FIXTURE_MEMORIES) {
    const entityId = m.entity_slug ? slugToId.get(m.entity_slug) : undefined;
    await engine.remember(ctx, {
      text: m.text,
      kind: m.kind,
      notability: m.notability,
      confidence: m.confidence,
      entity_refs: entityId ? [entityId] : [],
    });
  }
}

export async function runBench(db: Db, ctx: OperationContext): Promise<BenchScores> {
  const engine = new Me0Engine(db);
  await engine.ensureUser(ctx, ["Riley Kestrel"]);
  await seedFixtures(engine, ctx);

  // recall P@1
  let hits = 0;
  for (const probe of RECALL_PROBES) {
    const r = await engine.recall(ctx, { query: probe.query, limit: 3 });
    const top = r.results[0];
    if (top?.text.toLowerCase().includes(probe.expect.toLowerCase())) hits++;
  }
  const recallP1 = hits / RECALL_PROBES.length;

  // abstention accuracy
  let abstained = 0;
  for (const q of ABSTENTION_PROBES) {
    const r = await engine.recall(ctx, { query: q, limit: 3 });
    if (r.abstained) abstained++;
  }
  const abstentionAcc = abstained / ABSTENTION_PROBES.length;

  // push false-fire + hit rate (fresh episodes so suppression doesn't interfere)
  let falseFires = 0;
  for (const prompt of PUSH_NEGATIVE_PROMPTS) {
    const p = await engine.push(ctx, { prompt, episode_id: `bench_neg_${Math.random()}` });
    if (p.pushed.length > 0) falseFires++;
  }
  let pushHits = 0;
  for (const prompt of PUSH_POSITIVE_PROMPTS) {
    const p = await engine.push(ctx, { prompt, episode_id: `bench_pos_${Math.random()}` });
    if (p.pushed.length > 0) pushHits++;
  }

  // pack budget adherence
  const pack = await engine.contextPack(ctx, { budget_tokens: 700 });
  const budgetOk = pack._meta.budget_used <= 700;

  // continuity: handoff in one harness, resume pack in another
  const ep = await engine.episodeStart(ctx, { harness: "claude-code", title: "bench task" });
  const { token } = await engine.handoff(ctx, {
    episode_id: ep.episode_id,
    banked_state: "bench: implementing aviary tagger, tried approach A, next step B",
  });
  const resumeCtx: OperationContext = { ...ctx, harness: "codex" };
  const resumed = await engine.contextPack(resumeCtx, { resume: token });
  const continuityOk = resumed.content.includes("approach A");

  return {
    recall_p_at_1: recallP1,
    abstention_accuracy: abstentionAcc,
    push_false_fire_rate: falseFires / PUSH_NEGATIVE_PROMPTS.length,
    push_hit_rate: pushHits / PUSH_POSITIVE_PROMPTS.length,
    pack_budget_adherence: budgetOk,
    pack_budget_used: pack._meta.budget_used,
    continuity_resume_ok: continuityOk,
  };
}

export function passes(scores: BenchScores): boolean {
  return (
    scores.recall_p_at_1 >= THRESHOLDS.recall_p_at_1 &&
    scores.abstention_accuracy >= THRESHOLDS.abstention_accuracy &&
    scores.push_false_fire_rate <= THRESHOLDS.push_false_fire_rate &&
    scores.push_hit_rate >= THRESHOLDS.push_hit_rate &&
    scores.pack_budget_adherence &&
    scores.continuity_resume_ok
  );
}
