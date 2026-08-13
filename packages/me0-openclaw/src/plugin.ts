import {
  Me0Engine,
  type OperationContext,
  type Store,
  connect,
  ensureCollections,
  invoke,
  operations,
} from "me0-core";
import type {
  OpenClawHookEvent,
  OpenClawPluginApi,
  OpenClawPluginEntry,
  OpenClawToolResult,
} from "./api.js";

export interface Me0OpenClawConfig {
  mongodb_uri: string;
  user_id: string;
  agent?: string;
}

const DEFAULTS: Me0OpenClawConfig = {
  mongodb_uri: "mongodb://127.0.0.1:27017",
  user_id: "me",
  agent: "openclaw",
};

function resolveConfig(api: OpenClawPluginApi): Me0OpenClawConfig {
  const raw = { ...(api.config ?? {}), ...(api.pluginConfig ?? {}) };
  return {
    mongodb_uri: typeof raw.mongodb_uri === "string" ? raw.mongodb_uri : DEFAULTS.mongodb_uri,
    user_id: typeof raw.user_id === "string" ? raw.user_id : DEFAULTS.user_id,
    agent: typeof raw.agent === "string" ? raw.agent : DEFAULTS.agent,
  };
}

function text(result: unknown): OpenClawToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result as Record<string, unknown>,
  };
}

function errorResult(err: unknown): OpenClawToolResult {
  return {
    content: [
      { type: "text", text: `me0 error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

/**
 * Runtime state for the me0 OpenClaw plugin: a lazy, memoized engine
 * connection plus per-session episode ids and delta cursors.
 */
export class Me0OpenClawRuntime {
  private store: Store | null = null;
  private engine: Me0Engine | null = null;
  private connecting: Promise<Me0Engine> | null = null;
  private episodes = new Map<string, string>();
  private cursors = new Map<string, string>();

  constructor(private cfg: Me0OpenClawConfig) {}

  private async getEngine(): Promise<Me0Engine> {
    if (this.engine) return this.engine;
    if (!this.connecting) {
      this.connecting = (async () => {
        let store: Store | null = null;
        try {
          store = await connect(this.cfg.mongodb_uri);
          await ensureCollections(store.db);
          this.store = store;
          this.engine = new Me0Engine(store.db);
          return this.engine;
        } catch (err) {
          await store?.close().catch(() => {});
          this.connecting = null;
          throw err;
        }
      })();
    }
    return this.connecting;
  }

  ctx(sessionKey?: string): OperationContext {
    return {
      user_id: this.cfg.user_id,
      harness: "openclaw",
      agent: this.cfg.agent ?? "openclaw",
      episode_id: (sessionKey && this.episodes.get(sessionKey)) || null,
      remote: false,
    };
  }

  async op(name: string, args: Record<string, unknown>, sessionKey?: string): Promise<unknown> {
    const engine = await this.getEngine();
    return invoke(engine, this.ctx(sessionKey), name, args);
  }

  async getMemory(memoryId: string): Promise<Record<string, unknown> | null> {
    await this.getEngine();
    if (!this.store) return null;
    const doc = await this.store.db.collection("memories").findOne(
      { user_id: this.cfg.user_id, memory_id: memoryId, deleted_at: null },
      {
        projection: {
          _id: 0,
          memory_id: 1,
          text: 1,
          kind: 1,
          tier: 1,
          valid_from: 1,
          entity_refs: 1,
        },
      },
    );
    return doc as Record<string, unknown> | null;
  }

  episodeFor(sessionKey: string): string | undefined {
    return this.episodes.get(sessionKey);
  }

  async startEpisode(sessionKey: string): Promise<string> {
    const started = (await this.op("episode_start", {
      harness: "openclaw",
      agent_name: this.cfg.agent ?? "openclaw",
    })) as { episode_id: string };
    this.episodes.set(sessionKey, started.episode_id);
    return started.episode_id;
  }

  async endEpisode(sessionKey: string, summary?: string): Promise<void> {
    const episodeId = this.episodes.get(sessionKey);
    if (!episodeId) return;
    await this.op("episode_end", { episode_id: episodeId, ...(summary ? { summary } : {}) });
    this.episodes.delete(sessionKey);
  }

  async bankPreCompaction(sessionKey: string, note: string): Promise<string | null> {
    const episodeId = this.episodes.get(sessionKey);
    if (!episodeId) return null;
    const banked = (await this.op(
      "handoff",
      { episode_id: episodeId, banked_state: note },
      sessionKey,
    )) as { token: string };
    // handoff closes the episode; open a fresh one so post-compaction capture continues
    await this.startEpisode(sessionKey);
    return banked.token;
  }

  async delta(sessionKey: string): Promise<{ cursor: string; changes: unknown[] }> {
    const result = (await this.op(
      "delta",
      {
        ...(this.cursors.has(sessionKey) ? { cursor: this.cursors.get(sessionKey) } : {}),
      },
      sessionKey,
    )) as { cursor: string; changes: unknown[] };
    this.cursors.set(sessionKey, result.cursor);
    return result;
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.store = null;
    this.engine = null;
    this.connecting = null;
  }
}

/**
 * Build the me0 OpenClaw plugin entry. Every hook is fail-open: a memory
 * outage logs a warning and never blocks the agent.
 */
export function createMe0Plugin(): OpenClawPluginEntry & {
  runtime: () => Me0OpenClawRuntime | null;
} {
  let runtime: Me0OpenClawRuntime | null = null;

  return {
    id: "me0",
    name: "me0",
    description:
      "me0 memory for OpenClaw: graph-backed memory_search/memory_get, the me0 verbs, and session capture.",
    runtime: () => runtime,
    register(api: OpenClawPluginApi) {
      const cfg = resolveConfig(api);
      const rt = new Me0OpenClawRuntime(cfg);
      runtime = rt;
      const warn = (msg: string) =>
        api.logger ? api.logger.warn(msg) : console.error(`[me0] ${msg}`);
      const failOpen = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          warn(`${label} (fail-open): ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // ---- tools: swap OpenClaw's file-based memory backend for the me0 graph ----
      api.registerTool({
        name: "memory_search",
        description:
          "Semantic search over the me0 memory graph (replaces the file-based memory index). Abstains with 'no recorded memory' rather than guessing.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
        },
        async execute(_id, params) {
          try {
            return text(await rt.op("recall", params));
          } catch (err) {
            return errorResult(err);
          }
        },
      });
      api.registerTool({
        name: "memory_get",
        description:
          "Fetch one memory from the me0 graph by memory_id (as returned by memory_search).",
        parameters: {
          type: "object",
          properties: { memory_id: { type: "string" } },
          required: ["memory_id"],
        },
        async execute(_id, params) {
          try {
            const hit = await rt.getMemory(String(params.memory_id));
            return text(
              hit
                ? { protocol_version: 1, found: true, ...hit }
                : { protocol_version: 1, found: false, message: "no recorded memory" },
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      });

      // ---- the me0 verbs, delegated to me0-core's operation registry ----
      for (const op of operations) {
        api.registerTool({
          name: op.name,
          description: op.description,
          parameters: op.inputSchema as unknown as Record<string, unknown>,
          async execute(_id, params) {
            try {
              return text(await rt.op(op.name, params));
            } catch (err) {
              return errorResult(err);
            }
          },
        });
      }

      // ---- lifecycle capture (session + pre-compaction), all fail-open ----
      const key = (event: OpenClawHookEvent) => event.sessionKey ?? "default";

      api.registerHook(["command:new", "session:auto-reset"], (event) =>
        failOpen("episode_start", async () => {
          await rt.startEpisode(key(event));
        }),
      );
      api.registerHook(["command:stop", "command:reset", "session:end"], (event) =>
        failOpen("episode_end", async () => {
          await rt.endEpisode(key(event));
        }),
      );
      api.registerHook("message:received", (event) =>
        failOpen("episode_log", async () => {
          const episodeId = rt.episodeFor(key(event));
          if (!episodeId) return;
          const content = event.context?.content;
          await rt.op("episode_log", {
            episode_id: episodeId,
            type: "prompt",
            payload: { content: typeof content === "string" ? content.slice(0, 2000) : null },
          });
        }),
      );
      api.registerHook("session:compact:before", (event) =>
        failOpen("pre-compaction banking", async () => {
          const messageCount = event.context?.messageCount ?? "?";
          const token = await rt.bankPreCompaction(
            key(event),
            `OpenClaw pre-compaction bank (${messageCount} messages about to be summarized).`,
          );
          if (token) event.messages?.push(`me0 banked pre-compaction state (resume: ${token})`);
        }),
      );

      // ---- context pack into the workspace bootstrap ----
      api.registerHook("agent:bootstrap", (event) =>
        failOpen("bootstrap pack", async () => {
          const files = event.context?.bootstrapFiles;
          if (!Array.isArray(files)) return;
          const pack = (await rt.op("context_pack", {}, key(event))) as { content: string };
          if (!pack.content) return;
          files.push({
            name: "ME0.md",
            content: `<me0>\n${pack.content}\n</me0>`,
          });
        }),
      );

      // ---- delta on gateway heartbeat (typed hook, optional surface) ----
      api.on?.("heartbeat_prompt_contribution", async (event) => {
        try {
          const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "default";
          const { changes } = await rt.delta(sessionKey);
          if (changes.length === 0) return;
          return {
            prompt: `<me0-delta>\n${JSON.stringify(changes)}\n</me0-delta>`,
          };
        } catch (err) {
          warn(`heartbeat delta (fail-open): ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      });
    },
  };
}

export default createMe0Plugin();
