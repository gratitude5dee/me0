import { randomUUID, timingSafeEqual } from "node:crypto";
import { Me0Engine, type OperationContext } from "me0-core";
import type { Db } from "mongodb";
import { MEMORY_PROFILE_EXTENSION_URI, buildAgentCard } from "./card.js";

export interface A2AServerOptions {
  userId: string;
  port?: number;
  /** bearer token required on every request when set */
  token?: string;
  /** public base url advertised on the agent card */
  url?: string;
  /** bind address; defaults to loopback — non-loopback binds require a token */
  hostname?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MessagePart {
  kind?: string;
  text?: string;
  data?: Record<string, unknown>;
}

const SKILLS = new Set(["memory.recall", "memory.context_pack", "memory.synthesize"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PARTS = 16;
const MAX_BUDGET_TOKENS = 4000;
const MAX_QUERY_CHARS = 2000;

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function remoteCtx(userId: string): OperationContext {
  // Hard rule (goal.md §9.3): A2A callers are remote — visibility ceiling
  // `world`, local-only verbs rejected, every call audited.
  return { user_id: userId, harness: "other", agent: "a2a-peer", episode_id: null, remote: true };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function agentMessage(id: JsonRpcRequest["id"], data: unknown, extension?: string) {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      kind: "message",
      messageId: `msg_${randomUUID().slice(0, 12)}`,
      role: "agent",
      parts: [{ kind: "data", data }],
      ...(extension ? { extensions: [extension] } : {}),
    },
  });
}

async function audit(db: Db, ctx: OperationContext, op: string, detail: string): Promise<void> {
  await db.collection("audit").insertOne({
    ts: new Date().toISOString(),
    actor: { harness: ctx.harness, agent: ctx.agent, remote: true },
    op,
    subject_id: null,
    diff_summary: detail,
  });
}

export async function handleA2ARequest(
  db: Db,
  opts: A2AServerOptions,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
    return Response.json(
      buildAgentCard({
        url: opts.url ?? `http://localhost:${opts.port ?? 4160}`,
        auth: opts.token ? "bearer" : "none",
      }),
    );
  }
  if (req.method !== "POST" || url.pathname !== "/") {
    return new Response("not found", { status: 404 });
  }
  if (opts.token && !tokenMatches(req.headers.get("authorization"), opts.token)) {
    return new Response("unauthorized", { status: 401 });
  }

  let rpc: JsonRpcRequest;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return rpcError(null, -32600, "request too large");
    }
    rpc = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (!rpc || typeof rpc !== "object" || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return rpcError(rpc?.id ?? null, -32600, "invalid request");
  }
  if (rpc.method !== "message/send") {
    return rpcError(rpc.id, -32601, `method not found: ${rpc.method}`);
  }

  const message = (rpc.params?.message ?? {}) as {
    parts?: MessagePart[];
    extensions?: string[];
  };
  const parts = (message.parts ?? []).slice(0, MAX_PARTS);
  const ctx = remoteCtx(opts.userId);
  const engine = new Me0Engine(db);

  try {
    // memory-profile extension: redacted profile pack as a DataPart
    const wantsProfile =
      message.extensions?.includes(MEMORY_PROFILE_EXTENSION_URI) ||
      parts.some((p) => p.data?.extension === MEMORY_PROFILE_EXTENSION_URI);
    if (wantsProfile) {
      const rawBudget = parts.find((p) => typeof p.data?.budget_tokens === "number")?.data
        ?.budget_tokens as number | undefined;
      const budget =
        rawBudget !== undefined && Number.isFinite(rawBudget)
          ? Math.min(Math.max(Math.floor(rawBudget), 1), MAX_BUDGET_TOKENS)
          : undefined;
      const pack = await engine.contextPack(ctx, { scope: "a2a:profile", budget_tokens: budget });
      await audit(db, ctx, "a2a.memory_profile", `budget=${pack._meta.budget_tokens}`);
      return agentMessage(rpc.id, pack, MEMORY_PROFILE_EXTENSION_URI);
    }

    // explicit skill invocation via DataPart {skill, args}
    const skillPart = parts.find((p) => typeof p.data?.skill === "string");
    if (skillPart?.data) {
      const skill = skillPart.data.skill as string;
      if (!SKILLS.has(skill)) return rpcError(rpc.id, -32602, `unknown skill: ${skill}`);
      const args = (skillPart.data.args ?? {}) as Record<string, unknown>;
      let result: unknown;
      if (skill === "memory.recall") {
        result = await engine.recall(ctx, {
          query: String(args.query ?? "").slice(0, MAX_QUERY_CHARS),
        });
      } else if (skill === "memory.context_pack") {
        const b = args.budget_tokens;
        result = await engine.contextPack(ctx, {
          scope: typeof args.scope === "string" ? args.scope.slice(0, 100) : undefined,
          budget_tokens:
            typeof b === "number" && Number.isFinite(b)
              ? Math.min(Math.max(Math.floor(b), 1), MAX_BUDGET_TOKENS)
              : undefined,
        });
      } else {
        result = await engine.synthesize(ctx, {
          question: String(args.question ?? "").slice(0, MAX_QUERY_CHARS),
        });
      }
      await audit(db, ctx, `a2a.${skill}`, JSON.stringify(args).slice(0, 120));
      return agentMessage(rpc.id, result);
    }

    // plain text part → recall
    const text = parts.find((p) => typeof p.text === "string" && p.text.trim())?.text;
    if (text) {
      const result = await engine.recall(ctx, { query: text.slice(0, MAX_QUERY_CHARS) });
      await audit(db, ctx, "a2a.memory.recall", text.slice(0, 120));
      return agentMessage(rpc.id, result);
    }

    return rpcError(rpc.id, -32602, "message has no usable parts");
  } catch (err) {
    // never disclose internal error details (driver/collection info) to peers
    console.error("[me0-a2a] internal error:", err);
    return rpcError(rpc.id, -32000, "internal error");
  }
}

export function startA2AServer(db: Db, opts: A2AServerOptions) {
  const port = opts.port ?? 4160;
  const hostname = opts.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && !opts.token) {
    throw new Error(
      `refusing to bind A2A server to ${hostname} without a bearer token (set --a2a-token or ME0_A2A_TOKEN)`,
    );
  }
  return Bun.serve({
    port,
    hostname,
    fetch: (req) => handleA2ARequest(db, { ...opts, port }, req),
  });
}
