import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function openclawDir(): string {
  return process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
}

/**
 * Detect an OpenClaw install (~/.openclaw) and wire the me0 plugin config
 * into openclaw.json (`plugins.entries.me0.config`). Prints guidance;
 * returns true when OpenClaw was detected.
 */
export function wireOpenClaw(uri: string, userId: string): boolean {
  const dir = openclawDir();
  if (!existsSync(dir)) {
    console.log("openclaw not detected (~/.openclaw missing) — skipped");
    return false;
  }
  const configPath = join(dir, "openclaw.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.log(`openclaw: could not parse ${configPath} — wire the plugin manually`);
      return true;
    }
  }
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  config.plugins = plugins;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  plugins.entries = entries;
  if (entries.me0) {
    console.log("openclaw already wired");
  } else {
    entries.me0 = { enabled: true, config: { mongodb_uri: uri, user_id: userId } };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`openclaw wired: ${configPath} (plugins.entries.me0)`);
  }
  console.log(
    "openclaw: install the me0 plugin (this repo's openclaw.plugin.json + packages/me0-openclaw) via `openclaw plugins install`, then run `me0 import-openclaw` to backfill MEMORY.md and daily logs.",
  );
  return true;
}
