import type { Db } from "mongodb";
import type {
  EntityDoc,
  Evidence,
  MemoryDoc,
  MemoryKind,
  MemoryTier,
  OperationContext,
} from "./types.js";

export interface ScoredMemory {
  doc: MemoryDoc;
  score: number;
  evidence: Evidence;
}

export interface HybridArgs {
  query: string;
  kind?: MemoryKind;
  tier?: MemoryTier;
  limit?: number;
  /** minimum fraction of content words a non-graph hit must match (default 0.5) */
  minMatchFraction?: number;
}

const RRF_K = 60;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "your",
  "this",
  "that",
  "with",
  "from",
  "into",
  "how",
  "what",
  "which",
  "does",
  "did",
  "was",
  "were",
  "has",
  "have",
  "had",
  "can",
  "will",
  "would",
  "should",
  "could",
  "about",
  "who",
  "whom",
  "when",
  "where",
  "why",
  "all",
  "any",
  "user",
]);

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function tokenMatches(token: string, word: string): boolean {
  if (word.length < 4 || token.length < 4) return token === word;
  if (token.startsWith(word) || word.startsWith(token)) return true;
  // stem-ish: shared prefix of >= 5 chars (prefers/preference, decided/decision)
  let shared = 0;
  const n = Math.min(token.length, word.length);
  while (shared < n && token[shared] === word[shared]) shared++;
  return shared >= 5;
}

function matchFraction(text: string, words: string[]): number {
  if (words.length === 0) return 0;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  let n = 0;
  for (const w of words) {
    if (tokens.some((t) => tokenMatches(t, w))) n++;
  }
  return n / words.length;
}

/**
 * Hybrid recall via reciprocal rank fusion over named arms:
 * BM25-ish text arm, keyword arm, and an entity/alias (graph) arm.
 * Native $rankFusion (MongoDB 8.1+/Atlas) covers the same shape server-side;
 * this app-level fusion keeps community/local deployments fully functional.
 */
export async function hybridRecall(
  db: Db,
  ctx: OperationContext,
  args: HybridArgs,
  visibilityFilter: Record<string, unknown>,
): Promise<{ scored: ScoredMemory[]; poolSize: number }> {
  const limit = Math.min(args.limit ?? 8, 50);
  const pool = limit * 3;
  const filter: Record<string, unknown> = {
    user_id: ctx.user_id,
    deleted_at: null,
    valid_until: null,
    ...visibilityFilter,
  };
  if (args.kind) filter.kind = args.kind;
  if (args.tier) filter.tier = args.tier;

  const memories = db.collection<MemoryDoc>("memories");
  const words = queryWords(args.query);

  // arm 1: text index (BM25-ish)
  let textArm: Array<MemoryDoc & { textScore?: number }> = [];
  try {
    textArm = (await memories
      .find({ ...filter, $text: { $search: args.query } })
      .project({ textScore: { $meta: "textScore" } })
      .sort({ textScore: { $meta: "textScore" } })
      .limit(pool)
      .toArray()) as Array<MemoryDoc & { textScore?: number }>;
  } catch {
    textArm = [];
  }

  // arm 2: keyword arm — word-boundary prefix matches, ranked by distinct words hit
  let keywordArm: MemoryDoc[] = [];
  if (words.length > 0) {
    keywordArm = (await memories
      .find({ ...filter, text: { $regex: `\\b(${words.join("|")})`, $options: "i" } })
      .limit(pool)
      .toArray()) as MemoryDoc[];
    keywordArm.sort((a, b) => matchFraction(b.text, words) - matchFraction(a.text, words));
  }

  // arm 3: entity/alias graph arm — memories linked to entities the query names
  let entityArm: MemoryDoc[] = [];
  const aliasHits = new Set<string>();
  if (words.length > 0) {
    const entities = await db
      .collection<EntityDoc>("entities")
      .find({
        user_id: ctx.user_id,
        $or: [
          { slug: { $regex: `^(${words.join("|")})$`, $options: "i" } },
          { names: { $regex: `^(${words.join("|")})$`, $options: "i" } },
        ],
      })
      .limit(10)
      .toArray();
    if (entities.length > 0) {
      const ids = entities.map((e) => e.entity_id);
      entityArm = (await memories
        .find({ ...filter, entity_refs: { $in: ids } })
        .limit(pool)
        .toArray()) as MemoryDoc[];
      for (const m of entityArm) aliasHits.add(m.memory_id);
    }
  }

  // reciprocal rank fusion
  const fused = new Map<string, { doc: MemoryDoc; rrf: number; textScore: number }>();
  const addArm = (arm: Array<MemoryDoc & { textScore?: number }>) => {
    arm.forEach((d, i) => {
      const cur = fused.get(d.memory_id) ?? { doc: d, rrf: 0, textScore: 0 };
      cur.rrf += 1 / (RRF_K + i + 1);
      if (d.textScore && d.textScore > cur.textScore) cur.textScore = d.textScore;
      fused.set(d.memory_id, cur);
    });
  };
  addArm(textArm);
  addArm(keywordArm);
  addArm(entityArm);

  // precision gate: non-graph hits must match enough of the content words
  const minFraction = args.minMatchFraction ?? 0.5;
  if (words.length > 0) {
    for (const [id, { doc }] of fused) {
      if (aliasHits.has(id)) continue;
      const frac = matchFraction(doc.text, words);
      if (frac === 0 || frac < minFraction) fused.delete(id);
    }
  }

  // opportunistic RFM/heuristic utility weights from `predictions` (never required)
  const utility = new Map<string, number>();
  try {
    const preds = await db
      .collection("predictions")
      .find({ user_id: ctx.user_id, subject_type: "memory", task: "retrieval_utility" })
      .limit(500)
      .toArray();
    for (const p of preds) utility.set(p.subject_id as string, (p.score as number) ?? 0);
  } catch {
    // predictions collection may not exist; fall back silently
  }

  const tierBoost: Record<MemoryTier, number> = {
    core: 0.3,
    standing: 0.2,
    recall: 0.1,
    archive: 0,
  };
  const scored: ScoredMemory[] = [...fused.values()]
    .map(({ doc, rrf, textScore }) => {
      const recencyDays = (Date.now() - new Date(doc.valid_from).getTime()) / 86400000;
      const recency = Math.max(0, 0.2 - recencyDays * 0.002);
      const score =
        rrf * 20 +
        matchFraction(doc.text, words) * 0.5 +
        tierBoost[doc.tier] +
        recency +
        doc.notability * 0.1 +
        (utility.get(doc.memory_id) ?? 0) * 0.2;
      const evidence: Evidence = aliasHits.has(doc.memory_id)
        ? "alias_hit"
        : textScore > 1
          ? "keyword"
          : "weak_semantic";
      return { doc, score, evidence };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { scored, poolSize: fused.size };
}
