#!/usr/bin/env bun
// Tiny in-repo stand-in for the official `kumo-rfm-mcp` stdio server, used by
// kumo.test.ts to exercise the MCP client bridge hermetically (no API keys,
// no network). Mirrors the tool surface the bridge calls:
// update_graph_metadata → materialize_graph → predict.
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// unauthorized via env flag or a "bad-key" API key (the bridge spawns the
// server with a minimal environment, so the key is the reliable channel)
const MODE =
  process.env.FAKE_KUMO_MODE === "unauthorized" || process.env.KUMO_API_KEY === "bad-key"
    ? "unauthorized"
    : process.env.KUMO_API_KEY === "empty-key"
      ? "empty"
      : "ok";

let memoriesCsvPath: string | null = null;

function memoryIdsFromCsv(): string[] {
  if (!memoriesCsvPath) return [];
  const lines = readFileSync(memoriesCsvPath, "utf-8").trim().split("\n");
  const header = lines[0]?.split(",") ?? [];
  const idx = header.indexOf("memory_id");
  if (idx < 0) return [];
  return lines.slice(1).map((l) => l.split(",")[idx] ?? "");
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function fail(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const ANY_SCHEMA = { type: "object" as const, additionalProperties: true };

async function main() {
  const server = new Server(
    { name: "fake-kumo-rfm", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "update_graph_metadata", description: "fake", inputSchema: ANY_SCHEMA },
      { name: "materialize_graph", description: "fake", inputSchema: ANY_SCHEMA },
      { name: "predict", description: "fake", inputSchema: ANY_SCHEMA },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (MODE === "unauthorized") {
      return fail("Unauthorized: invalid KUMO_API_KEY");
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    switch (req.params.name) {
      case "update_graph_metadata": {
        const update = args.update as
          | { tables_to_add?: Array<{ name: string; path: string }> }
          | undefined;
        for (const t of update?.tables_to_add ?? []) {
          if (t.name === "memories") memoriesCsvPath = t.path;
        }
        return ok({ errors: [] });
      }
      case "materialize_graph":
        return ok({ num_nodes: 1, num_edges: 0, time_ranges: {} });
      case "predict": {
        if (MODE === "empty") return ok({ predictions: [] });
        const query = String(args.query ?? "");
        const indices = Array.isArray(args.indices) ? args.indices : [];
        if (query.includes("LIST_DISTINCT")) {
          const rows = memoryIdsFromCsv().map((id, i) => ({
            ENTITY: indices[0] ?? null,
            CLASS: id,
            SCORE: 0.9 - i * 0.1,
          }));
          return ok({ predictions: rows });
        }
        const prob = query.includes("used=1") ? 0.8 : 0.3;
        const rows = indices.map((id) => ({
          ENTITY: id,
          ANCHOR_TIMESTAMP: 0,
          TARGET_PRED: prob > 0.5,
          False_PROB: 1 - prob,
          True_PROB: prob,
        }));
        return ok({ predictions: rows });
      }
      default:
        return fail(`unknown tool: ${req.params.name}`);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
