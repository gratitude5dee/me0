import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Me0Config {
  mongodb_uri: string;
  user_id: string;
  /** Voyage AI API key for automated embeddings (env: ME0_VOYAGE_API_KEY) */
  voyage_api_key?: string;
  /** embedding model name (env: ME0_EMBEDDING_MODEL, default voyage-3-lite) */
  embedding_model?: string;
  /** Atlas $vectorSearch index name (env: ME0_VECTOR_SEARCH_INDEX) */
  vector_search_index?: string;
  /** force native $rankFusion on/off (env: ME0_RANK_FUSION; unset = auto-detect) */
  rank_fusion?: boolean;
}

export function configDir(): string {
  return process.env.ME0_DATA ?? join(homedir(), ".me0");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): Me0Config {
  const envUri = process.env.ME0_MONGODB_URI;
  const envUser = process.env.ME0_USER_ID;
  let fileCfg: Partial<Me0Config> = {};
  if (existsSync(configPath())) {
    fileCfg = JSON.parse(readFileSync(configPath(), "utf-8"));
  }
  const cfg: Me0Config = {
    mongodb_uri: envUri ?? fileCfg.mongodb_uri ?? "mongodb://127.0.0.1:27017",
    user_id: envUser ?? fileCfg.user_id ?? "me",
    voyage_api_key: process.env.ME0_VOYAGE_API_KEY ?? fileCfg.voyage_api_key,
    embedding_model: process.env.ME0_EMBEDDING_MODEL ?? fileCfg.embedding_model,
    vector_search_index: process.env.ME0_VECTOR_SEARCH_INDEX ?? fileCfg.vector_search_index,
    rank_fusion:
      process.env.ME0_RANK_FUSION !== undefined && process.env.ME0_RANK_FUSION !== ""
        ? process.env.ME0_RANK_FUSION === "1" ||
          process.env.ME0_RANK_FUSION.toLowerCase() === "true"
        : fileCfg.rank_fusion,
  };
  applyRetrievalEnv(cfg);
  return cfg;
}

/**
 * me0-core reads retrieval settings from env only; propagate file-config
 * values into the process env so the engine sees them (env vars win).
 */
export function applyRetrievalEnv(cfg: Me0Config): void {
  if (cfg.voyage_api_key && !process.env.ME0_VOYAGE_API_KEY) {
    process.env.ME0_VOYAGE_API_KEY = cfg.voyage_api_key;
  }
  if (cfg.embedding_model && !process.env.ME0_EMBEDDING_MODEL) {
    process.env.ME0_EMBEDDING_MODEL = cfg.embedding_model;
  }
  if (cfg.vector_search_index && !process.env.ME0_VECTOR_SEARCH_INDEX) {
    process.env.ME0_VECTOR_SEARCH_INDEX = cfg.vector_search_index;
  }
  if (
    cfg.rank_fusion !== undefined &&
    (process.env.ME0_RANK_FUSION === undefined || process.env.ME0_RANK_FUSION === "")
  ) {
    process.env.ME0_RANK_FUSION = cfg.rank_fusion ? "true" : "false";
  }
}

export function saveConfig(cfg: Partial<Me0Config> & Pick<Me0Config, "mongodb_uri" | "user_id">) {
  mkdirSync(configDir(), { recursive: true });
  let existing: Partial<Me0Config> = {};
  if (existsSync(configPath())) {
    try {
      existing = JSON.parse(readFileSync(configPath(), "utf-8"));
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...cfg };
  writeFileSync(configPath(), `${JSON.stringify(merged, null, 2)}\n`);
}
