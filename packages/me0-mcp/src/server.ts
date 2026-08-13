#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type Harness,
  Me0Engine,
  type OperationContext,
  connect,
  ensureCollections,
  invoke,
  operations,
} from "me0-core";

const MONGODB_URI = process.env.ME0_MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const USER_ID = process.env.ME0_USER_ID ?? "me";
const HARNESS = (process.env.ME0_HARNESS ?? "other") as Harness;
const AGENT = process.env.ME0_AGENT ?? "unknown-agent";

async function main() {
  const store = await connect(MONGODB_URI);
  await ensureCollections(store.db);
  const engine = new Me0Engine(store.db);

  const server = new Server({ name: "me0", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: op.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const ctx: OperationContext = {
      user_id: USER_ID,
      harness: HARNESS,
      agent: AGENT,
      episode_id: process.env.ME0_EPISODE_ID ?? null,
      remote: false,
    };
    try {
      const result = await invoke(engine, ctx, req.params.name, req.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("me0-mcp fatal:", err);
  process.exit(1);
});
