import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Me0Config {
  mongodb_uri: string;
  user_id: string;
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
  return {
    mongodb_uri: envUri ?? fileCfg.mongodb_uri ?? "mongodb://127.0.0.1:27017",
    user_id: envUser ?? fileCfg.user_id ?? "me",
  };
}

export function saveConfig(cfg: Me0Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}
