import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function hermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}

export function detectHermes(home = hermesHome()): boolean {
  return existsSync(home);
}

export function me0McpYamlBlock(uri: string, userId: string, indent = "  "): string {
  // JSON.stringify produces a valid YAML double-quoted scalar (escapes ", \, newlines)
  const i2 = indent + indent;
  const i3 = i2 + indent;
  return [
    `${indent}me0:`,
    `${i2}command: "me0-mcp"`,
    `${i2}env:`,
    `${i3}ME0_MONGODB_URI: ${JSON.stringify(uri)}`,
    `${i3}ME0_USER_ID: ${JSON.stringify(userId)}`,
    `${i3}ME0_HARNESS: "hermes"`,
    "",
  ].join("\n");
}

/**
 * Add the me0 MCP server entry to Hermes's config.yaml.
 * Inserts under an existing `mcp_servers:` key when present (matching the
 * indentation of its existing children), otherwise appends a new block.
 * No-op when an me0 entry already exists; bails out (with printed manual
 * instructions) when `mcp_servers` uses flow style (`mcp_servers: {...}`),
 * which cannot be safely extended textually.
 * Returns true when the file was modified.
 */
export function wireHermesConfig(uri: string, userId: string, home = hermesHome()): boolean {
  const configPath = join(home, "config.yaml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  if (/^\s+me0:/m.test(current)) return false;
  let next: string;
  const match = current.match(/^mcp_servers:([^\n]*)\n/m);
  if (match?.index !== undefined) {
    if (match[1] !== undefined && match[1].trim() !== "" && !match[1].trim().startsWith("#")) {
      // flow style (e.g. `mcp_servers: {}`): appending block children would corrupt it
      console.error(
        `could not wire hermes automatically (${configPath} uses flow-style mcp_servers).`,
      );
      console.error("add this entry manually:");
      console.error(`mcp_servers:\n${me0McpYamlBlock(uri, userId)}`);
      return false;
    }
    const after = current.slice(match.index + match[0].length);
    const child = after.match(/^([ \t]+)\S/m);
    const entry = me0McpYamlBlock(uri, userId, child?.[1] ?? "  ");
    const insertAt = match.index + match[0].length;
    next = current.slice(0, insertAt) + entry + current.slice(insertAt);
  } else {
    const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    next = `${current}${sep}mcp_servers:\n${me0McpYamlBlock(uri, userId)}`;
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
