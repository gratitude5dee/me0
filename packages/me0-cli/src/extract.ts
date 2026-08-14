import { existsSync, readFileSync } from "node:fs";
import {
  type ExtractOptions,
  type LlmProvider,
  type OperationContext,
  type Store,
  extractEpisode,
  extractUnextractedEpisodes,
  openAiCompatProvider,
} from "me0-core";
import { configPath } from "./config.js";

export interface ExtractSettings {
  provider: LlmProvider | null;
  extract_on_episode_end: boolean;
  min_confidence?: number;
}

/**
 * Resolve LLM extraction settings from env (ME0_LLM_BASE_URL, ME0_LLM_MODEL,
 * ME0_LLM_API_KEY, ME0_EXTRACT_ON_EPISODE_END, ME0_EXTRACT_MIN_CONFIDENCE)
 * with ~/.me0/config.json fallbacks (llm_base_url, llm_model, llm_api_key,
 * extract_on_episode_end, extract_min_confidence).
 */
export function loadExtractSettings(): ExtractSettings {
  let fileCfg: Record<string, unknown> = {};
  try {
    if (existsSync(configPath())) {
      fileCfg = JSON.parse(readFileSync(configPath(), "utf-8"));
    }
  } catch {
    // unreadable config never blocks: extraction just stays disabled
  }
  const str = (envName: string, fileKey: string): string | undefined => {
    const env = process.env[envName];
    if (env) return env;
    const v = fileCfg[fileKey];
    return typeof v === "string" && v ? v : undefined;
  };
  const base_url = str("ME0_LLM_BASE_URL", "llm_base_url");
  const model = str("ME0_LLM_MODEL", "llm_model");
  const api_key = str("ME0_LLM_API_KEY", "llm_api_key");
  const envAuto = process.env.ME0_EXTRACT_ON_EPISODE_END;
  const extract_on_episode_end = envAuto
    ? envAuto === "1" || envAuto.toLowerCase() === "true"
    : fileCfg.extract_on_episode_end === true;
  const envMin = process.env.ME0_EXTRACT_MIN_CONFIDENCE;
  const fileMin = fileCfg.extract_min_confidence;
  const min_confidence = envMin
    ? Number(envMin)
    : typeof fileMin === "number"
      ? fileMin
      : undefined;
  return {
    provider: base_url && model ? openAiCompatProvider({ base_url, model, api_key }) : null,
    extract_on_episode_end,
    min_confidence:
      min_confidence !== undefined && !Number.isNaN(min_confidence) ? min_confidence : undefined,
  };
}

function extractOpts(s: ExtractSettings): ExtractOptions {
  return s.min_confidence !== undefined ? { min_confidence: s.min_confidence } : {};
}

/** `me0 extract --episode <id>` (or `--all` for unextracted ended episodes). */
export async function runExtractCommand(
  db: Store["db"],
  ctx: OperationContext,
  args: { episode_id?: string; all?: boolean },
): Promise<void> {
  const settings = loadExtractSettings();
  if (!settings.provider) {
    console.error(
      "extract: no LLM configured — set ME0_LLM_BASE_URL and ME0_LLM_MODEL (and optionally ME0_LLM_API_KEY), or llm_base_url/llm_model in ~/.me0/config.json",
    );
    process.exit(1);
  }
  if (args.episode_id) {
    const r = await extractEpisode(
      db,
      ctx,
      args.episode_id,
      settings.provider,
      extractOpts(settings),
    );
    console.log(
      `extract ${r.episode_id}: +${r.added} memories (${r.skipped_duplicates} duplicates, ${r.skipped_low_confidence} low-confidence, ${r.considered} candidates)`,
    );
  } else if (args.all) {
    const r = await extractUnextractedEpisodes(db, ctx, settings.provider, extractOpts(settings));
    const added = r.extracted.reduce((n, e) => n + e.added, 0);
    console.log(
      `extract: ${r.episodes_scanned} episodes scanned, +${added} memories, ${r.errors.length} errors`,
    );
    for (const e of r.errors) console.error(`  ${e.episode_id}: ${e.error}`);
  } else {
    console.error("usage: me0 extract --episode <id> | me0 extract --all");
    process.exit(1);
  }
}

/**
 * Fail-open automatic extraction after episode_end: only runs when
 * extract_on_episode_end is configured AND an LLM is configured; any error is
 * logged to stderr and swallowed — the episode end must never be blocked.
 */
export async function maybeExtractOnEpisodeEnd(
  db: Store["db"],
  ctx: OperationContext,
  episodeId: string,
): Promise<void> {
  try {
    const settings = loadExtractSettings();
    if (!settings.extract_on_episode_end || !settings.provider) return;
    const r = await extractEpisode(db, ctx, episodeId, settings.provider, extractOpts(settings));
    console.error(`me0 extract (episode_end): +${r.added} memories from ${episodeId}`);
  } catch (err) {
    console.error(
      `me0 extract (fail-open, episode still ended): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Dream-cycle step: sweep recently-ended unextracted episodes. Fail-open. */
export async function dreamExtractStep(db: Store["db"], ctx: OperationContext): Promise<void> {
  try {
    const settings = loadExtractSettings();
    if (!settings.provider) return;
    const r = await extractUnextractedEpisodes(db, ctx, settings.provider, extractOpts(settings));
    const added = r.extracted.reduce((n, e) => n + e.added, 0);
    console.log(
      `extract: ${r.episodes_scanned} unextracted episodes, +${added} memories, ${r.errors.length} errors`,
    );
  } catch (err) {
    console.error(`me0 extract (fail-open): ${err instanceof Error ? err.message : err}`);
  }
}
