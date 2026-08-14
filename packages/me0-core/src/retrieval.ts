import type { Db, Document } from "mongodb";
import { cosineSimilarity, getEmbedder, vectorSearchIndex } from "./embeddings.js";
import { nativeRankFusion, supportsNativeRankFusion } from "./rankfusion.js";
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
  /** max entity hops for the $graphLookup arm (default 2) */
  graphDepth?: number;
}

const RRF_K = 60;
const VECTOR_CANDIDATE_CAP = 400;
const HIGH_VECTOR_SIM = 0.6;
const MIN_VECTOR_SIM = 0.3;

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

interface FusedEntry {
  doc: MemoryDoc;
  rrf: number;
  textScore: number;
}

async function findSeedEntities(db: Db, userId: string, words: string[]): Promise<EntityDoc[]> {
  if (words.length === 0) return [];
  return db
    .collection<EntityDoc>("entities")
    .find({
      user_id: userId,
      $or: [
        { slug: { $regex: `^(${words.join("|")})$`, $options: "i" } },
        { names: { $regex: `^(${words.join("|")})$`, $options: "i" } },
      ],
    })
    .limit(10)
    .toArray();
}

/**
 * $graphLookup arm: walk entity edges outward from the seed entities
 * (both directions, bounded depth) and collect memories linked to the
 * neighbor entities. Depth is in entity hops (1 = direct neighbor).
 * Fail-open: any server error yields an empty arm.
 */
async function graphArmLookup(
  db: Db,
  userId: string,
  seeds: EntityDoc[],
  filter: Record<string, unknown>,
  maxEntityHops: number,
  pool: number,
): Promise<{ arm: MemoryDoc[]; depths: Map<string, number> }> {
  const depths = new Map<string, number>();
  if (seeds.length === 0 || maxEntityHops < 1) return { arm: [], depths };
  const seedIds = seeds.map((e) => e.entity_id);
  const seedSet = new Set(seedIds);
  try {
    const lookup = (from: "src" | "dst", to: "src" | "dst") =>
      db
        .collection("entities")
        .aggregate([
          { $match: { user_id: userId, entity_id: { $in: seedIds } } },
          {
            $graphLookup: {
              from: "edges",
              startWith: "$entity_id",
              connectFromField: from,
              connectToField: to,
              as: "walk",
              maxDepth: maxEntityHops - 1,
              depthField: "depth",
              restrictSearchWithMatch: { user_id: userId, valid_until: null },
            },
          },
          { $project: { _id: 0, walk: { src: 1, dst: 1, depth: 1 } } },
        ])
        .toArray();
    const [outward, inward] = await Promise.all([lookup("dst", "src"), lookup("src", "dst")]);

    const entityDepth = new Map<string, number>();
    const note = (entityId: string, hops: number) => {
      if (seedSet.has(entityId)) return;
      const cur = entityDepth.get(entityId);
      if (cur === undefined || hops < cur) entityDepth.set(entityId, hops);
    };
    for (const row of outward) {
      for (const e of (row.walk ?? []) as Array<{ src: string; dst: string; depth: number }>) {
        note(e.dst, e.depth + 1);
      }
    }
    for (const row of inward) {
      for (const e of (row.walk ?? []) as Array<{ src: string; dst: string; depth: number }>) {
        note(e.src, e.depth + 1);
      }
    }
    if (entityDepth.size === 0) return { arm: [], depths };

    const neighborIds = [...entityDepth.keys()];
    const arm = (await db
      .collection<MemoryDoc>("memories")
      .find({ ...filter, entity_refs: { $in: neighborIds } })
      .limit(pool)
      .toArray()) as MemoryDoc[];
    for (const m of arm) {
      let best = Number.POSITIVE_INFINITY;
      for (const ref of m.entity_refs) {
        const d = entityDepth.get(ref);
        if (d !== undefined && d < best) best = d;
      }
      if (Number.isFinite(best)) depths.set(m.memory_id, best);
    }
    arm.sort(
      (a, b) =>
        (depths.get(a.memory_id) ?? Number.MAX_SAFE_INTEGER) -
        (depths.get(b.memory_id) ?? Number.MAX_SAFE_INTEGER),
    );
    return { arm, depths };
  } catch {
    return { arm: [], depths };
  }
}

/**
 * Vector arm. Preferred path is an Atlas `$vectorSearch` when an index name
 * is configured (never probed); fallback is exact in-process cosine scoring
 * over a capped candidate set of already-embedded memories. Fail-open.
 */
async function vectorArmLookup(
  db: Db,
  filter: Record<string, unknown>,
  queryVector: number[],
  pool: number,
): Promise<{ arm: MemoryDoc[]; sims: Map<string, number> }> {
  const sims = new Map<string, number>();
  const memories = db.collection<MemoryDoc>("memories");
  const index = vectorSearchIndex();
  if (index) {
    try {
      const rows = (await memories
        .aggregate([
          {
            $vectorSearch: {
              index,
              path: "embedding",
              queryVector,
              numCandidates: Math.max(pool * 10, 100),
              limit: pool,
              filter,
            },
          },
          { $addFields: { __vs: { $meta: "vectorSearchScore" } } },
        ])
        .toArray()) as Array<MemoryDoc & { __vs?: number }>;
      const arm: MemoryDoc[] = [];
      for (const row of rows) {
        const { __vs, ...doc } = row;
        sims.set(doc.memory_id, __vs ?? HIGH_VECTOR_SIM);
        arm.push(doc as MemoryDoc);
      }
      return { arm, sims };
    } catch {
      // fall through to exact cosine fallback
    }
  }
  try {
    const candidates = (await memories
      .find({ ...filter, embedding: { $exists: true } })
      .limit(VECTOR_CANDIDATE_CAP)
      .toArray()) as MemoryDoc[];
    const scored = candidates
      .map((doc) => ({ doc, sim: cosineSimilarity(queryVector, doc.embedding ?? []) }))
      .filter(({ sim }) => sim >= MIN_VECTOR_SIM)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, pool);
    for (const { doc, sim } of scored) sims.set(doc.memory_id, sim);
    return { arm: scored.map((s) => s.doc), sims };
  } catch {
    return { arm: [], sims };
  }
}

/**
 * Native $rankFusion fusion of the text/keyword/entity/(vector) arms.
 * Recovers per-pipeline ranks from scoreDetails and applies the exact same
 * 1/(K+rank) weighting as the in-process path, so the result shape and
 * evidence fields are identical. Throws on failure — the caller falls back.
 */
async function nativeFusion(
  db: Db,
  filter: Record<string, unknown>,
  query: string,
  words: string[],
  entityIds: string[],
  queryVector: number[] | null,
  pool: number,
): Promise<{ fused: Map<string, FusedEntry>; aliasHits: Set<string>; vectorRanked: Set<string> }> {
  const pipelines: Record<string, Document[]> = {
    text: [
      { $match: { ...filter, $text: { $search: query } } },
      { $sort: { score: { $meta: "textScore" }, _id: 1 } },
      { $limit: pool },
    ],
  };
  if (words.length > 0) {
    pipelines.keyword = [
      { $match: { ...filter, text: { $regex: `\\b(${words.join("|")})`, $options: "i" } } },
      { $sort: { notability: -1, valid_from: -1, _id: 1 } },
      { $limit: pool },
    ];
  }
  if (entityIds.length > 0) {
    pipelines.entity = [
      { $match: { ...filter, entity_refs: { $in: entityIds } } },
      { $sort: { notability: -1, valid_from: -1, _id: 1 } },
      { $limit: pool },
    ];
  }
  const index = vectorSearchIndex();
  if (index && queryVector) {
    pipelines.vector = [
      {
        $vectorSearch: {
          index,
          path: "embedding",
          queryVector,
          numCandidates: Math.max(pool * 10, 100),
          limit: pool,
          filter,
        },
      },
    ];
  }

  const hits = await nativeRankFusion(db, "memories", pipelines, pool * 4);
  const fused = new Map<string, FusedEntry>();
  const aliasHits = new Set<string>();
  const vectorRanked = new Set<string>();
  for (const hit of hits) {
    const doc = hit.doc as MemoryDoc;
    let rrf = 0;
    for (const rank of hit.ranks.values()) rrf += 1 / (RRF_K + rank);
    if (rrf === 0) continue;
    // textScore proxy: a text-index hit carries the same evidence weight
    // ("keyword") as an in-process textScore > 1
    const textScore = hit.ranks.has("text") ? 2 : 0;
    if (hit.ranks.has("entity")) aliasHits.add(doc.memory_id);
    if (hit.ranks.has("vector")) vectorRanked.add(doc.memory_id);
    fused.set(doc.memory_id, { doc, rrf, textScore });
  }
  return { fused, aliasHits, vectorRanked };
}

/**
 * Hybrid recall via reciprocal rank fusion over named arms:
 * BM25-ish text arm, keyword arm, entity/alias arm, a $graphLookup graph
 * arm, and (when embeddings are configured) a vector arm.
 * When the server supports MongoDB 8.1+ native $rankFusion, the
 * text/keyword/entity/(vector) arms are fused server-side; otherwise the
 * fusion runs in-process so community/local deployments stay fully
 * functional. Every Mongo-native capability fails open.
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

  // query embedding (fail-open: retrieval proceeds without a vector arm)
  let queryVector: number[] | null = null;
  const embedder = getEmbedder();
  if (embedder) {
    try {
      queryVector = (await embedder.embed([args.query]))[0] ?? null;
    } catch {
      queryVector = null;
    }
  }

  const seedEntities = await findSeedEntities(db, ctx.user_id, words);
  const seedIds = seedEntities.map((e) => e.entity_id);

  let fused = new Map<string, FusedEntry>();
  let aliasHits = new Set<string>();
  const vectorSims = new Map<string, number>();
  let vectorRanked = new Set<string>();
  let nativeUsed = false;

  if (await supportsNativeRankFusion(db)) {
    try {
      const native = await nativeFusion(db, filter, args.query, words, seedIds, queryVector, pool);
      fused = native.fused;
      aliasHits = native.aliasHits;
      vectorRanked = native.vectorRanked;
      nativeUsed = true;
    } catch {
      nativeUsed = false;
    }
  }

  const addArm = (arm: Array<MemoryDoc & { textScore?: number }>) => {
    arm.forEach((d, i) => {
      const cur = fused.get(d.memory_id) ?? { doc: d, rrf: 0, textScore: 0 };
      cur.rrf += 1 / (RRF_K + i + 1);
      if (d.textScore && d.textScore > cur.textScore) cur.textScore = d.textScore;
      fused.set(d.memory_id, cur);
    });
  };

  if (!nativeUsed) {
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

    // arm 3: entity/alias arm — memories linked to entities the query names
    let entityArm: MemoryDoc[] = [];
    if (seedIds.length > 0) {
      entityArm = (await memories
        .find({ ...filter, entity_refs: { $in: seedIds } })
        .limit(pool)
        .toArray()) as MemoryDoc[];
      for (const m of entityArm) aliasHits.add(m.memory_id);
    }

    // arm 4: vector arm ($vectorSearch or exact cosine fallback)
    let vectorArm: MemoryDoc[] = [];
    if (queryVector) {
      const v = await vectorArmLookup(db, filter, queryVector, pool);
      vectorArm = v.arm;
      for (const [id, sim] of v.sims) vectorSims.set(id, sim);
    }

    addArm(textArm);
    addArm(keywordArm);
    addArm(entityArm);
    addArm(vectorArm);
  }

  // arm 5: $graphLookup graph arm — memories of entities near the seeds
  const { arm: graphArm, depths: graphDepths } = await graphArmLookup(
    db,
    ctx.user_id,
    seedEntities,
    filter,
    args.graphDepth ?? 2,
    pool,
  );
  addArm(graphArm);

  // precision gate: hits with no structural evidence (alias/graph/vector)
  // must match enough of the content words
  const minFraction = args.minMatchFraction ?? 0.5;
  if (words.length > 0) {
    for (const [id, { doc }] of fused) {
      if (aliasHits.has(id) || graphDepths.has(id)) continue;
      if (vectorRanked.has(id) || (vectorSims.get(id) ?? 0) >= HIGH_VECTOR_SIM) continue;
      const frac = matchFraction(doc.text, words);
      if (frac === 0 || frac < minFraction) fused.delete(id);
    }
  }

  // opportunistic RFM/heuristic utility weights from `predictions` (never required)
  const utility = new Map<string, number>();
  try {
    const preds = await db
      .collection("predictions")
      .find({
        subject_type: "memory",
        task: "retrieval_utility",
        subject_id: { $in: [...fused.keys()] },
      })
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
      const graphDepth = graphDepths.get(doc.memory_id);
      const graphBoost = graphDepth !== undefined ? 0.3 * 0.5 ** (graphDepth - 1) : 0;
      const vectorSim = vectorSims.get(doc.memory_id) ?? 0;
      const score =
        rrf * 20 +
        matchFraction(doc.text, words) * 0.5 +
        tierBoost[doc.tier] +
        recency +
        doc.notability * 0.1 +
        vectorSim * 0.5 +
        graphBoost +
        (utility.get(doc.memory_id) ?? 0) * 0.2;
      const evidence: Evidence = aliasHits.has(doc.memory_id)
        ? "alias_hit"
        : graphDepth !== undefined
          ? "graph_hit"
          : vectorRanked.has(doc.memory_id) || vectorSim >= HIGH_VECTOR_SIM
            ? "high_vector"
            : textScore > 1
              ? "keyword"
              : "weak_semantic";
      return { doc, score, evidence };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { scored, poolSize: fused.size };
}
