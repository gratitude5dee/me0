import type { Me0Engine } from "../engine.js";
import type { OperationContext } from "../types.js";

export type OpScope = "read" | "write" | "admin";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Operation {
  name: string;
  description: string;
  scope: OpScope;
  localOnly: boolean;
  inputSchema: JsonSchema;
  // biome-ignore lint/suspicious/noExplicitAny: args are validated against inputSchema at the boundary
  handler: (engine: Me0Engine, ctx: OperationContext, args: any) => Promise<unknown>;
}

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;

export const operations: Operation[] = [
  {
    name: "recall",
    description:
      "Hybrid search over the user's memories. Returns evidence-tagged results; abstains explicitly ('no recorded memory') rather than guessing.",
    scope: "read",
    localOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        query: str,
        kind: {
          type: "string",
          enum: ["fact", "preference", "decision", "commitment", "belief", "procedure"],
        },
        tier: { type: "string", enum: ["core", "standing", "recall", "archive"] },
        limit: num,
      },
      required: ["query"],
    },
    handler: (e, ctx, a) => e.recall(ctx, a),
  },
  {
    name: "remember",
    description:
      "Write a typed memory (fact/preference/decision/commitment/belief/procedure) with auto-stamped provenance and conflict-safe dedupe.",
    scope: "write",
    localOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        text: str,
        kind: {
          type: "string",
          enum: ["fact", "preference", "decision", "commitment", "belief", "procedure"],
        },
        tier: { type: "string", enum: ["core", "standing", "recall", "archive"] },
        entity_refs: { type: "array", items: str },
        visibility: { type: "string", enum: ["private", "shared", "world"] },
        confidence: num,
        notability: num,
      },
      required: ["text", "kind"],
    },
    handler: (e, ctx, a) => e.remember(ctx, a),
  },
  {
    name: "entity",
    description:
      "Zero-LLM entity card lookup by slug or alias, with typed edges and neighbor cards.",
    scope: "read",
    localOnly: false,
    inputSchema: { type: "object", properties: { slug: str }, required: ["slug"] },
    handler: (e, ctx, a) => e.entity(ctx, a),
  },
  {
    name: "context_pack",
    description:
      "Budgeted session-start context pack: identity card, standing memories, recent session summaries, and resume state when a handoff token is supplied.",
    scope: "read",
    localOnly: false,
    inputSchema: {
      type: "object",
      properties: { scope: str, resume: str, budget_tokens: num },
    },
    handler: (e, ctx, a) => e.contextPack(ctx, a),
  },
  {
    name: "delta",
    description: "Changes since the session's cursor (at-least-once). The heartbeat verb.",
    scope: "read",
    localOnly: false,
    inputSchema: { type: "object", properties: { cursor: str } },
    handler: (e, ctx, a) => e.delta(ctx, a),
  },
  {
    name: "forget",
    description:
      "User-ordered removal: soft-delete with a 72h purge window. Accepts a memory_id or entity_slug (scope-wide).",
    scope: "admin",
    localOnly: true,
    inputSchema: {
      type: "object",
      properties: { memory_id: str, entity_slug: str },
    },
    handler: (e, ctx, a) => e.forget(ctx, a),
  },
  {
    name: "synthesize",
    description:
      "Cited answer over recalled memories. Degrades to structured recall citations in keyless mode; abstains when nothing is recorded.",
    scope: "read",
    localOnly: false,
    inputSchema: { type: "object", properties: { question: str }, required: ["question"] },
    handler: (e, ctx, a) => e.synthesize(ctx, a),
  },
  // ---- episodic extension (me0 namespace, additive) ----
  {
    name: "episode_start",
    description: "Open an episode for the current agent session (any harness).",
    scope: "write",
    localOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        harness: {
          type: "string",
          enum: ["claude-code", "codex", "pi", "hermes", "openclaw", "other"],
        },
        agent_name: str,
        model: str,
        project: str,
        cwd: str,
        repo_remote: str,
        branch: str,
        title: str,
      },
    },
    handler: (e, ctx, a) => e.episodeStart(ctx, a),
  },
  {
    name: "episode_log",
    description: "Append an event (tool_call, file_edit, command, ...) to a live episode.",
    scope: "write",
    localOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        episode_id: str,
        type: {
          type: "string",
          enum: ["prompt", "response", "tool_call", "file_edit", "command", "error"],
        },
        tool: str,
        ok: bool,
        payload: { type: "object", properties: {} },
      },
      required: ["episode_id", "type"],
    },
    handler: (e, ctx, a) => e.episodeLog(ctx, a),
  },
  {
    name: "episode_end",
    description: "Close an episode with a distilled summary and outcome.",
    scope: "write",
    localOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        episode_id: str,
        summary: str,
        success: bool,
        commits: { type: "array", items: str },
      },
      required: ["episode_id"],
    },
    handler: (e, ctx, a) => e.episodeEnd(ctx, a),
  },
  {
    name: "episode_recall",
    description: "Search past sessions across all harnesses ('what did we try on the auth bug?').",
    scope: "read",
    localOnly: false,
    inputSchema: {
      type: "object",
      properties: { query: str, limit: num },
      required: ["query"],
    },
    handler: (e, ctx, a) => e.episodeRecall(ctx, a),
  },
  {
    name: "handoff",
    description: "Bank live state and mint a resume token for a cross-harness switch.",
    scope: "write",
    localOnly: true,
    inputSchema: {
      type: "object",
      properties: { episode_id: str, banked_state: str },
      required: ["episode_id", "banked_state"],
    },
    handler: (e, ctx, a) => e.handoff(ctx, a),
  },
  {
    name: "whoami",
    description: "Identity card plus consent scopes in force for this caller.",
    scope: "read",
    localOnly: false,
    inputSchema: { type: "object", properties: {} },
    handler: (e, ctx) => e.whoami(ctx),
  },
  {
    name: "push",
    description:
      "Gated per-turn ambient recall for a user prompt: confidence-gated (>=0.7 default), capped per turn, deduped against memories already surfaced this session.",
    scope: "read",
    localOnly: true,
    inputSchema: {
      type: "object",
      properties: { prompt: str, episode_id: str },
      required: ["prompt"],
    },
    handler: (e, ctx, a) => e.push(ctx, a),
  },
  {
    name: "dream",
    description:
      "Consolidation pass: purge expired soft-deletes, dedupe memories, heat-based tier promotion/demotion, recompile identity card, refresh cached packs.",
    scope: "admin",
    localOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: (e, ctx) => e.dream(ctx),
  },
  {
    name: "me0_stats",
    description: "Memory counts and health.",
    scope: "read",
    localOnly: false,
    inputSchema: { type: "object", properties: {} },
    handler: (e, ctx) => e.stats(ctx),
  },
];

export function getOperation(name: string): Operation | undefined {
  return operations.find((o) => o.name === name);
}

export function validateArgs(op: Operation, args: Record<string, unknown>): string | null {
  for (const req of op.inputSchema.required ?? []) {
    if (args[req] === undefined || args[req] === null) return `missing required argument: ${req}`;
  }
  return null;
}

export async function invoke(
  engine: Me0Engine,
  ctx: OperationContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const op = getOperation(name);
  if (!op) throw new Error(`unknown operation: ${name}`);
  if (op.localOnly && ctx.remote) throw new Error(`${name} is local-only`);
  const err = validateArgs(op, args);
  if (err) throw new Error(err);
  return op.handler(engine, ctx, args);
}
