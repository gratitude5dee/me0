/**
 * me0 pi extension.
 *
 * pi has no built-in MCP by design, so this extension registers the me0
 * memory verbs directly as native pi tools (`memory_*`) and taps pi's
 * extension events for deterministic episodic capture.
 *
 * Install: `me0 init` detects `~/.pi/agent/` and writes a wrapper into
 * `~/.pi/agent/extensions/me0.ts` that re-exports this file.
 *
 * `PiApi` below is a thin, documented subset of pi's ExtensionAPI
 * (extensions export a default factory receiving the API object; tools are
 * registered via `registerTool`; lifecycle events via `on("session_start" |
 * "tool_call" | "session_shutdown")`). If pi's surface shifts, only this
 * interface needs adjusting — the wiring is exercised against a mock in
 * `me0.test.ts`.
 *
 * Everything here is fail-open: a memory outage never blocks the agent.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Me0Engine,
  type OperationContext,
  connect,
  ensureCollections,
  getOperation,
  invoke,
} from "me0-core";

export const ME0_PI_TOOLS = [
  "recall",
  "remember",
  "entity",
  "context_pack",
  "delta",
  "episode_recall",
  "handoff",
  "whoami",
  "me0_stats",
] as const;

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface PiToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema for the tool arguments (structurally TypeBox-compatible). */
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult>;
}

export interface PiToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}

export interface PiApi {
  registerTool(tool: PiToolDefinition): void;
  on(
    event: "session_start" | "session_shutdown",
    handler: (event: Record<string, unknown>, ctx?: unknown) => unknown,
  ): void;
  on(event: "tool_call", handler: (event: PiToolCallEvent, ctx?: unknown) => unknown): void;
  /** Inject a message into the session/LLM context (preferred for the pack). */
  sendMessage?(message: { customType: string; content: string; display?: boolean }): void;
  /** Persist an extension entry (fallback injection surface). */
  appendEntry?(customType: string, data?: Record<string, unknown>): void;
}

export interface Me0PiDeps {
  engine: Me0Engine;
  ctx: OperationContext;
  /** Release underlying resources (e.g. the Mongo client). */
  close?: () => Promise<void>;
}

export type Me0PiDepsProvider = () => Promise<Me0PiDeps>;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wire the me0 tools and capture events onto a pi API object.
 * Dependency acquisition is lazy and memoized; every failure path is
 * fail-open (tools report the outage, event handlers swallow it).
 */
export function registerMe0(pi: PiApi, provideDeps: Me0PiDepsProvider): void {
  // Memoize the in-flight promise (not just the resolved value) so
  // overlapping first uses share one connection; reset on rejection so a
  // later call can retry.
  let cached: Promise<Me0PiDeps> | null = null;
  const deps = async (): Promise<Me0PiDeps | null> => {
    cached ??= provideDeps();
    try {
      return await cached;
    } catch (err) {
      cached = null;
      console.error(`me0 pi extension (fail-open): ${errMsg(err)}`);
      return null;
    }
  };

  for (const name of ME0_PI_TOOLS) {
    const op = getOperation(name);
    if (!op) continue;
    pi.registerTool({
      name: `memory_${name}`,
      label: `me0 ${name}`,
      description: op.description,
      parameters: op.inputSchema as unknown as Record<string, unknown>,
      async execute(_toolCallId, params) {
        const d = await deps();
        if (!d) {
          return {
            content: [{ type: "text", text: "me0 memory is unavailable (fail-open)" }],
            isError: true,
          };
        }
        try {
          const result = await invoke(d.engine, d.ctx, name, params ?? {});
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result as Record<string, unknown>,
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `me0 ${name} failed: ${errMsg(err)}` }],
            isError: true,
          };
        }
      },
    });
  }

  pi.on("session_start", async () => {
    const d = await deps();
    if (!d) return;
    try {
      const started = (await d.engine.episodeStart(d.ctx, {
        harness: "pi",
        cwd: process.cwd(),
      })) as { episode_id: string };
      d.ctx.episode_id = started.episode_id;
      const pack = await d.engine.contextPack(d.ctx, {});
      const content = `<me0 episode_id="${started.episode_id}">\n${pack.content}\n</me0>`;
      if (pi.sendMessage) {
        pi.sendMessage({ customType: "me0-context-pack", content, display: false });
      } else if (pi.appendEntry) {
        pi.appendEntry("me0-context-pack", { content });
      }
    } catch (err) {
      console.error(`me0 pi extension (fail-open): ${errMsg(err)}`);
    }
  });

  pi.on("tool_call", (event) => {
    if (typeof event?.toolName !== "string" || event.toolName.startsWith("memory_")) return;
    void (async () => {
      const d = await deps();
      if (!d?.ctx.episode_id) return;
      await d.engine.episodeLog(d.ctx, {
        episode_id: d.ctx.episode_id,
        type: "tool_call",
        tool: event.toolName,
        payload: { input: event.input ?? {} },
      });
    })().catch((err) => console.error(`me0 pi extension (fail-open): ${errMsg(err)}`));
  });

  pi.on("session_shutdown", () => {
    void (async () => {
      const d = await deps();
      if (!d) return;
      if (d.ctx.episode_id) {
        await d.engine.episodeEnd(d.ctx, { episode_id: d.ctx.episode_id });
      }
      await d.close?.();
    })().catch((err) => console.error(`me0 pi extension (fail-open): ${errMsg(err)}`));
  });
}

function loadMe0Config(): { mongodb_uri: string; user_id: string } {
  let fileCfg: Partial<{ mongodb_uri: string; user_id: string }> = {};
  const path = join(process.env.ME0_DATA ?? join(homedir(), ".me0"), "config.json");
  if (existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      fileCfg = {};
    }
  }
  return {
    mongodb_uri: process.env.ME0_MONGODB_URI ?? fileCfg.mongodb_uri ?? "mongodb://127.0.0.1:27017",
    user_id: process.env.ME0_USER_ID ?? fileCfg.user_id ?? "me",
  };
}

async function defaultDeps(): Promise<Me0PiDeps> {
  const cfg = loadMe0Config();
  const store = await connect(cfg.mongodb_uri);
  await ensureCollections(store.db);
  return {
    engine: new Me0Engine(store.db),
    close: () => store.close(),
    ctx: {
      user_id: cfg.user_id,
      harness: "pi",
      agent: "pi",
      episode_id: null,
      remote: false,
    },
  };
}

export default function me0Extension(pi: PiApi): void {
  registerMe0(pi, defaultDeps);
}
