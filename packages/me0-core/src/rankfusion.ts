import type { Db, Document } from "mongodb";

/** Parse "8.1.0" → [8, 1]; returns null when unparseable. */
export function parseMongoVersion(version: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Native $rankFusion requires MongoDB 8.1+. */
export function versionSupportsRankFusion(version: string): boolean {
  const v = parseMongoVersion(version);
  if (!v) return false;
  const [major, minor] = v;
  return major > 8 || (major === 8 && minor >= 1);
}

const detected = new WeakMap<Db, boolean>();

/**
 * Whether the connected server can run native $rankFusion.
 * `ME0_RANK_FUSION=true|false` overrides detection; otherwise the server's
 * buildInfo version decides. Fail-open: any detection error means "no".
 */
export async function supportsNativeRankFusion(db: Db): Promise<boolean> {
  const flag = process.env.ME0_RANK_FUSION;
  if (flag !== undefined && flag !== "") {
    return flag === "1" || flag.toLowerCase() === "true";
  }
  const cached = detected.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const info = (await db.admin().serverInfo()) as { version?: string };
    ok = typeof info.version === "string" && versionSupportsRankFusion(info.version);
  } catch {
    ok = false;
  }
  detected.set(db, ok);
  return ok;
}

export interface RankedHit {
  doc: Document;
  /** 1-based ranks per input pipeline name */
  ranks: Map<string, number>;
}

/**
 * Run a native $rankFusion over named ranked pipelines against `collection`,
 * returning per-pipeline 1-based ranks recovered from scoreDetails so the
 * caller can apply the exact same reciprocal-rank-fusion weighting it uses
 * in-process. Throws on server error — callers must fail open to the
 * in-process fusion path.
 */
export async function nativeRankFusion(
  db: Db,
  collection: string,
  pipelines: Record<string, Document[]>,
  limit: number,
): Promise<RankedHit[]> {
  const rows = await db
    .collection(collection)
    .aggregate([
      {
        $rankFusion: {
          input: { pipelines },
          scoreDetails: true,
        },
      },
      { $addFields: { __scoreDetails: { $meta: "scoreDetails" } } },
      { $limit: limit },
    ])
    .toArray();

  return rows.map((row) => {
    const { __scoreDetails, ...doc } = row as Document & {
      __scoreDetails?: {
        details?: Array<{ inputPipelineName?: string; rank?: number }>;
      };
    };
    const ranks = new Map<string, number>();
    for (const d of __scoreDetails?.details ?? []) {
      if (typeof d.inputPipelineName === "string" && typeof d.rank === "number" && d.rank > 0) {
        ranks.set(d.inputPipelineName, d.rank);
      }
    }
    return { doc, ranks };
  });
}
