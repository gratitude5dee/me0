import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function hermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}

export function detectHermes(home = hermesHome()): boolean {
  return existsSync(home);
}

export function me0McpYamlBlock(uri: string, userId: string): string {
  // JSON.stringify produces a valid YAML double-quoted scalar (escapes ", \, newlines)
  return [
    "  me0:",
    '    command: "me0-mcp"',
    "    env:",
    `      ME0_MONGODB_URI: ${JSON.stringify(uri)}`,
    `      ME0_USER_ID: ${JSON.stringify(userId)}`,
    '      ME0_HARNESS: "hermes"',
    "",
  ].join("\n");
}

/**
 * Add the me0 MCP server entry to Hermes's config.yaml.
 * Inserts under an existing `mcp_servers:` key when present, otherwise appends
 * a new block. No-op when an me0 entry already exists.
 * Returns true when the file was modified.
 */
export function wireHermesConfig(uri: string, userId: string, home = hermesHome()): boolean {
  const configPath = join(home, "config.yaml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  if (/^\s{2}me0:/m.test(current)) return false;
  const entry = me0McpYamlBlock(uri, userId);
  let next: string;
  const match = current.match(/^mcp_servers:[^\n]*\n/m);
  if (match?.index !== undefined) {
    const insertAt = match.index + match[0].length;
    next = current.slice(0, insertAt) + entry + current.slice(insertAt);
  } else {
    const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    next = `${current}${sep}mcp_servers:\n${entry}`;
  }
  writeFileSync(configPath, next);
  return true;
}

export function printHermesGuidance(home = hermesHome()): void {
  console.log(`hermes detected: ${home}`);
  console.log("  next steps:");
  console.log("  1. copy plugins/memory/me0 into your hermes-agent checkout's plugins/memory/,");
  console.log("     then: hermes config set memory.provider me0");
  console.log("  2. backfill your history: me0 import-hermes");
  console.log("  see plugins/memory/me0/README.md for details.");
}
