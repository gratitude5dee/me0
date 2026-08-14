import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { slugify } from "./importers/markdown.js";
import type {
  EntityDoc,
  EpisodeDoc,
  EventDoc,
  MemoryDoc,
  MemoryKind,
  MemoryTier,
  OperationContext,
} from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

// ---- provider ----

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Pluggable LLM provider: given chat messages, return the raw completion text. */
export interface LlmProvider {
  complete(messages: LlmMessage[]): Promise<string>;
}

export interface LlmProviderConfig {
  base_url: string;
  model: string;
  api_key?: string;
  /** Request timeout in ms; a stalled endpoint must never hang session end. */
  timeout_ms?: number;
}

export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * OpenAI-compatible chat-completions client over `fetch`. Works with OpenAI,
 * OpenRouter, and local llama.cpp/ollama endpoints — anything that speaks
 * POST {base_url}/chat/completions.
 */
export function openAiCompatProvider(cfg: LlmProviderConfig): LlmProvider {
  return {
    async complete(messages: LlmMessage[]): Promise<string> {
      const url = `${cfg.base_url.replace(/\/+$/, "")}/chat/completions`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cfg.api_key) headers.authorization = `Bearer ${cfg.api_key}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0 }),
        signal: AbortSignal.timeout(cfg.timeout_ms ?? DEFAULT_LLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`llm request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("llm response missing message content");
      return content;
    },
  };
}

/**
 * Build a provider from environment variables (ME0_LLM_BASE_URL, ME0_LLM_MODEL,
 * ME0_LLM_API_KEY). Returns null when not configured — callers treat null as
 * "extraction disabled" (fail-open).
 */
export function providerFromEnv(
  env: Record<string, string | undefined> = process.env,
): LlmProvider | null {
  const base_url = env.ME0_LLM_BASE_URL;
  const model = env.ME0_LLM_MODEL;
  if (!base_url || !model) return null;
  return openAiCompatProvider({ base_url, model, api_key: env.ME0_LLM_API_KEY });
}

// ---- prompt + parsing ----

export const MAX_EXTRACTED_ITEMS = 12;
export const DEFAULT_MIN_CONFIDENCE = 0.5;
const MAX_ITEM_TEXT_CHARS = 500;
const MAX_EVENT_CHARS = 300;
const MAX_EVENTS = 200;

const KINDS: MemoryKind[] = ["fact", "preference", "decision", "commitment", "belief", "procedure"];
// llm-extracted memories start below "core": promotion is earned via the dream cycle
const TIERS: MemoryTier[] = ["standing", "recall", "archive"];

export interface ExtractedItem {
  text: string;
  kind: MemoryKind;
  tier: MemoryTier;
  confidence: number;
  entities: string[];
}

const SYSTEM_PROMPT = `You distill durable memories from an AI agent session log.

Extract ONLY information that will still matter in future sessions: stable facts about the user or their projects, stated preferences, decisions made (and why), commitments, and durable project state. Do NOT extract transient details (single command outputs, intermediate debugging steps, timestamps, one-off errors).

Rules:
- Output STRICT JSON: a single array of objects, no prose, no markdown fences.
- Each object: {"text": string, "kind": "fact"|"preference"|"decision"|"commitment"|"belief"|"procedure", "tier": "standing"|"recall", "confidence": number 0..1, "entities": string[]}.
- "text" must be a single self-contained sentence, understandable without the session log.
- NEVER fabricate: only include statements directly supported by the log. If unsure, lower the confidence or omit the item.
- If nothing durable was established, output exactly: []
- Output at most ${MAX_EXTRACTED_ITEMS} items, most important first.`;

export function buildExtractionPrompt(episode: EpisodeDoc, events: EventDoc[]): LlmMessage[] {
  const header = [
    `harness: ${episode.harness}`,
    episode.title ? `title: ${episode.title}` : null,
    episode.project ? `project: ${episode.project}` : null,
    episode.summary ? `summary: ${episode.summary}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const lines = events.slice(0, MAX_EVENTS).map((e) => {
    const payload = JSON.stringify(e.payload ?? {}).slice(0, MAX_EVENT_CHARS);
    return `[${e.type}${e.tool ? `:${e.tool}` : ""}${e.ok === false ? " FAILED" : ""}] ${payload}`;
  });
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Session:\n${header}\n\nEvent log (${lines.length} events):\n${lines.join("\n")}`,
    },
  ];
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Parse and validate raw LLM output into extraction items. Never throws:
 * malformed output yields an empty list, and individually invalid items are
 * dropped rather than failing the batch.
 */
export function parseExtraction(raw: string, maxItems = MAX_EXTRACTED_ITEMS): ExtractedItem[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: ExtractedItem[] = [];
  for (const entry of parsed) {
    if (items.length >= maxItems) break;
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    const itemText = o.text.trim().slice(0, MAX_ITEM_TEXT_CHARS);
    if (itemText.length < 8) continue;
    const kind = KINDS.includes(o.kind as MemoryKind) ? (o.kind as MemoryKind) : null;
    if (!kind) continue;
    const tier = TIERS.includes(o.tier as MemoryTier) ? (o.tier as MemoryTier) : "recall";
    const confidence = typeof o.confidence === "number" ? clamp01(o.confidence) : 0.5;
    const entities = Array.isArray(o.entities)
      ? o.entities.filter((e): e is string => typeof e === "string").slice(0, 8)
      : [];
    items.push({ text: itemText, kind, tier, confidence, entities });
  }
  return items;
}

// ---- extraction ----

function now(): string {
  return new Date().toISOString();
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Resolve extracted entity names to entity ids, creating auto entities as needed. */
async function resolveEntityRefs(
  db: Db,
  ctx: OperationContext,
  names: string[],
  cache: Map<string, string>,
): Promise<string[]> {
  const entities = db.collection<EntityDoc>("entities");
  const refs: string[] = [];
  for (const name of names) {
    const slug = slugify(name);
    if (!slug) continue;
    let entityId = cache.get(slug);
    if (!entityId) {
      const existing = await entities.findOne({ user_id: ctx.user_id, slug });
      if (existing) {
        entityId = existing.entity_id;
      } else {
        const doc: EntityDoc = {
          user_id: ctx.user_id,
          entity_id: `ent_${randomUUID().slice(0, 12)}`,
          slug,
          type: "concept",
          names: [name],
          card: "",
          attrs: {},
          status: "auto",
          salience: 0.5,
          last_retrieved_at: null,
          created_at: now(),
          updated_at: now(),
        };
        await entities.insertOne(doc);
        entityId = doc.entity_id;
      }
      cache.set(slug, entityId);
    }
    if (!refs.includes(entityId)) refs.push(entityId);
  }
  return refs;
}

export interface ExtractOptions {
  /** Items with model confidence below this are skipped. Default 0.5. */
  min_confidence?: number;
  max_items?: number;
}

export interface ExtractReport {
  protocol_version: number;
  episode_id: string;
  considered: number;
  added: number;
  skipped_duplicates: number;
  skipped_low_confidence: number;
  memory_ids: string[];
}

/**
 * Distill durable memories from one episode's event log via the LLM provider
 * and write them with prov.method "llm". Idempotent: normalized-duplicate
 * memories are skipped (create_safety=exists semantics), so re-extraction is
 * safe. Marks the episode with `extracted_at` on completion.
 */
export async function extractEpisode(
  db: Db,
  ctx: OperationContext,
  episodeId: string,
  provider: LlmProvider,
  opts: ExtractOptions = {},
): Promise<ExtractReport> {
  if (ctx.remote) throw new Error("extract is not permitted for remote callers");
  const minConfidence = opts.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
  const episodes = db.collection<EpisodeDoc>("episodes");
  const episode = await episodes.findOne({ user_id: ctx.user_id, episode_id: episodeId });
  if (!episode) throw new Error(`episode not found: ${episodeId}`);

  const report: ExtractReport = {
    protocol_version: PROTOCOL_VERSION,
    episode_id: episodeId,
    considered: 0,
    added: 0,
    skipped_duplicates: 0,
    skipped_low_confidence: 0,
    memory_ids: [],
  };

  const events = await db
    .collection<EventDoc>("events")
    .find({ episode_id: episodeId })
    .sort({ ts: 1 })
    .limit(MAX_EVENTS)
    .toArray();

  if (events.length === 0 && !episode.summary) {
    await episodes.updateOne(
      { user_id: ctx.user_id, episode_id: episodeId },
      { $set: { extracted_at: now() } },
    );
    return report;
  }

  const raw = await provider.complete(buildExtractionPrompt(episode, events));
  const items = parseExtraction(raw, opts.max_items ?? MAX_EXTRACTED_ITEMS);
  report.considered = items.length;

  const memories = db.collection<MemoryDoc>("memories");
  const entityCache = new Map<string, string>();
  for (const item of items) {
    if (item.confidence < minConfidence) {
      report.skipped_low_confidence++;
      continue;
    }
    const escaped = normalize(item.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dupe = await memories.findOne({
      user_id: ctx.user_id,
      deleted_at: null,
      valid_until: null,
      text: { $regex: `^${escaped.replace(/ /g, "\\s+")}$`, $options: "i" },
    });
    if (dupe) {
      report.skipped_duplicates++;
      continue;
    }
    const doc: MemoryDoc = {
      user_id: ctx.user_id,
      memory_id: `mem_${randomUUID().slice(0, 12)}`,
      text: item.text,
      kind: item.kind,
      tier: item.tier,
      entity_refs: await resolveEntityRefs(db, ctx, item.entities, entityCache),
      visibility: "private",
      valid_from: now(),
      valid_until: null,
      superseded_by: null,
      confidence: item.confidence,
      notability: 0.5,
      access: { count: 0, last_retrieved_at: null },
      deleted_at: null,
      prov: {
        episode_id: episodeId,
        harness: episode.harness ?? ctx.harness,
        agent: ctx.agent,
        method: "llm",
        confidence: item.confidence,
        extracted_at: now(),
      },
    };
    await memories.insertOne(doc);
    report.added++;
    report.memory_ids.push(doc.memory_id);
  }

  await episodes.updateOne(
    { user_id: ctx.user_id, episode_id: episodeId },
    { $set: { extracted_at: now() } },
  );
  await db.collection("audit").insertOne({
    ts: now(),
    actor: { harness: ctx.harness, agent: ctx.agent, remote: ctx.remote },
    op: "extract",
    subject_id: episodeId,
    diff_summary: `llm-extracted +${report.added} (${report.skipped_duplicates} dup, ${report.skipped_low_confidence} low-conf)`,
  });
  return report;
}

export interface ExtractSweepReport {
  protocol_version: number;
  episodes_scanned: number;
  extracted: ExtractReport[];
  errors: Array<{ episode_id: string; error: string }>;
}

/**
 * Dream-cycle step: extract from recently-ended episodes that have not been
 * extracted yet (no `extracted_at` flag). Fail-open per episode: one failing
 * extraction (e.g. LLM outage) never aborts the sweep.
 */
export async function extractUnextractedEpisodes(
  db: Db,
  ctx: OperationContext,
  provider: LlmProvider,
  opts: ExtractOptions & { limit?: number } = {},
): Promise<ExtractSweepReport> {
  const candidates = await db
    .collection<EpisodeDoc>("episodes")
    .find({
      user_id: ctx.user_id,
      status: { $in: ["ended", "handed_off"] },
      extracted_at: { $exists: false },
    })
    .sort({ ended_at: -1 })
    .limit(opts.limit ?? 10)
    .toArray();
  const report: ExtractSweepReport = {
    protocol_version: PROTOCOL_VERSION,
    episodes_scanned: candidates.length,
    extracted: [],
    errors: [],
  };
  for (const ep of candidates) {
    try {
      report.extracted.push(await extractEpisode(db, ctx, ep.episode_id, provider, opts));
    } catch (err) {
      report.errors.push({
        episode_id: ep.episode_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}
