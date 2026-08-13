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

export type HermesWireStatus = "wired" | "present" | "manual";

/**
 * Add the me0 MCP server entry to Hermes's config.yaml.
 * Inserts under an existing `mcp_servers:` key when present (matching the
 * indentation of its existing children), otherwise appends a new block.
 * Returns "present" when an me0 server entry already exists, "manual" when
 * `mcp_servers` uses flow style (`mcp_servers: {...}`) — which cannot be
 * safely extended textually, so manual instructions are printed — and
 * "wired" when the file was modified.
 */
export function wireHermesConfig(
  uri: string,
  userId: string,
  home = hermesHome(),
): HermesWireStatus {
  const configPath = join(home, "config.yaml");
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  // normalize so a final `mcp_servers:` line without trailing newline still matches
  const current = raw.length > 0 && !raw.endsWith("\n") ? `${raw}\n` : raw;
  let next: string;
  const match = current.match(/^mcp_servers:([^\n]*)\n/m);
  if (match?.index !== undefined) {
    const rest = match[1]?.trim() ?? "";
    if (rest !== "" && !rest.startsWith("#")) {
      if (/\bme0\b/.test(rest)) return "present";
      // flow style (e.g. `mcp_servers: {}`): appending block children would corrupt it
      console.error(
        `could not wire hermes automatically (${configPath} uses flow-style mcp_servers).`,
      );
      console.error("add this entry manually:");
      console.error(`mcp_servers:\n${me0McpYamlBlock(uri, userId)}`);
      return "manual";
    }
    // scope the idempotency check to the mcp_servers block's children
    const after = current.slice(match.index + match[0].length);
    const blockEnd = after.search(/^\S/m);
    const block = blockEnd === -1 ? after : after.slice(0, blockEnd);
    if (/^[ \t]+me0:/m.test(block)) return "present";
    const child = block.match(/^([ \t]+)\S/m);
    const entry = me0McpYamlBlock(uri, userId, child?.[1] ?? "  ");
    const insertAt = match.index + match[0].length;
    next = current.slice(0, insertAt) + entry + current.slice(insertAt);
  } else {
    next = `${current}mcp_servers:\n${me0McpYamlBlock(uri, userId)}`;
  }
  writeFileSync(configPath, next);
  return "wired";
}

export function printHermesGuidance(home = hermesHome()): void {
  console.log(`hermes detected: ${home}`);
  console.log("  next steps:");
  console.log("  1. copy plugins/memory/me0 into your hermes-agent checkout's plugins/memory/,");
  console.log("     then: hermes config set memory.provider me0");
  console.log("  2. backfill your history: me0 import-hermes");
  console.log("  see plugins/memory/me0/README.md for details.");
}
