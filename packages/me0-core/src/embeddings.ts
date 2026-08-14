import type { Db } from "mongodb";
import type { MemoryDoc } from "./types.js";

export const DEFAULT_VOYAGE_MODEL = "voyage-3-lite";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

/** Pluggable embedding provider. Implementations must be pure over inputs. */
export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VoyageOptions {
  apiKey: string;
  model?: string;
  /** override the REST endpoint (tests) */
  url?: string;
}

/** Voyage AI REST embedder (no SDK dependency; plain fetch). */
export class VoyageEmbedder implements Embedder {
  readonly model: string;
  private apiKey: string;
  private url: string;

  constructor(opts: VoyageOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_VOYAGE_MODEL;
    this.url = opts.url ?? VOYAGE_URL;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });
    if (!res.ok) {
      throw new Error(`voyage embeddings failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    const out: number[][] = new Array(texts.length);
    for (const d of body.data) out[d.index] = d.embedding;
    return out;
  }
}

// explicit injection wins over env-derived; `null` disables embeddings entirely
let injected: Embedder | null | undefined;

export function setEmbedder(embedder: Embedder | null): void {
  injected = embedder;
}

export function clearEmbedder(): void {
  injected = undefined;
}

/**
 * Resolve the active embedder: an injected one (tests, hosts), else a Voyage
 * embedder from `ME0_VOYAGE_API_KEY` / `ME0_EMBEDDING_MODEL`, else none.
 */
export function getEmbedder(): Embedder | null {
  if (injected !== undefined) return injected;
  const apiKey = process.env.ME0_VOYAGE_API_KEY;
  if (!apiKey) return null;
  return new VoyageEmbedder({ apiKey, model: process.env.ME0_EMBEDDING_MODEL });
}

export interface MemoryEmbedding {
  embedding: number[];
  embedding_model: string;
}

/**
 * Best-effort embedding for a memory write. Fail-open: any provider error
 * returns null (the write proceeds without a vector) with a warning.
 */
export async function maybeEmbedText(text: string): Promise<MemoryEmbedding | null> {
  const embedder = getEmbedder();
  if (!embedder) return null;
  try {
    const [vec] = await embedder.embed([text]);
    if (!vec || vec.length === 0) return null;
    return { embedding: vec, embedding_model: embedder.model };
  } catch (err) {
    console.warn(`me0 embeddings (fail-open): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface BackfillReport {
  scanned: number;
  embedded: number;
  failed: number;
  remaining: number;
}

/**
 * Embed memories that are missing vectors, in batches. Fail-open per batch:
 * a failing batch is counted and skipped, never thrown.
 */
export async function embedBackfill(
  db: Db,
  userId: string,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<BackfillReport> {
  const embedder = getEmbedder();
  const report: BackfillReport = { scanned: 0, embedded: 0, failed: 0, remaining: 0 };
  const memories = db.collection<MemoryDoc>("memories");
  const filter = {
    user_id: userId,
    deleted_at: null,
    valid_until: null,
    embedding: { $exists: false },
  };
  if (!embedder) {
    report.remaining = await memories.countDocuments(filter);
    return report;
  }
  const batchSize = Math.max(1, opts.batchSize ?? 32);
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await memories.find(filter).limit(batchSize).toArray();
    if (batch.length === 0) break;
    report.scanned += batch.length;
    let vectors: number[][];
    try {
      vectors = await embedder.embed(batch.map((m) => m.text));
    } catch (err) {
      console.warn(
        `me0 embed-backfill batch failed (fail-open): ${err instanceof Error ? err.message : err}`,
      );
      report.failed += batch.length;
      break;
    }
    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const vec = vectors[j];
      if (!doc || !vec || vec.length === 0) {
        report.failed++;
        continue;
      }
      await memories.updateOne(
        { user_id: userId, memory_id: doc.memory_id },
        { $set: { embedding: vec, embedding_model: embedder.model } },
      );
      report.embedded++;
    }
  }
  report.remaining = await memories.countDocuments(filter);
  return report;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Atlas $vectorSearch index name; unset means no Atlas vector index. */
export function vectorSearchIndex(): string | null {
  const v = process.env.ME0_VECTOR_SEARCH_INDEX;
  return v && v.trim() !== "" ? v.trim() : null;
}
