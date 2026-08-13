import { randomUUID } from "node:crypto";
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
  if (opts.token && req.headers.get("authorization") !== `Bearer ${opts.token}`) {
    return new Response("unauthorized", { status: 401 });
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return rpcError(rpc.id ?? null, -32600, "invalid request");
  }
  if (rpc.method !== "message/send") {
    return rpcError(rpc.id, -32601, `method not found: ${rpc.method}`);
  }

  const message = (rpc.params?.message ?? {}) as {
    parts?: MessagePart[];
    extensions?: string[];
  };
  const parts = message.parts ?? [];
  const ctx = remoteCtx(opts.userId);
  const engine = new Me0Engine(db);

  try {
    // memory-profile extension: redacted profile pack as a DataPart
    const wantsProfile =
      message.extensions?.includes(MEMORY_PROFILE_EXTENSION_URI) ||
      parts.some((p) => p.data?.extension === MEMORY_PROFILE_EXTENSION_URI);
    if (wantsProfile) {
      const budget = parts.find((p) => typeof p.data?.budget_tokens === "number")?.data
        ?.budget_tokens as number | undefined;
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
        result = await engine.recall(ctx, { query: String(args.query ?? "") });
      } else if (skill === "memory.context_pack") {
        result = await engine.contextPack(ctx, {
          scope: typeof args.scope === "string" ? args.scope : undefined,
          budget_tokens: typeof args.budget_tokens === "number" ? args.budget_tokens : undefined,
        });
      } else {
        result = await engine.synthesize(ctx, { question: String(args.question ?? "") });
      }
      await audit(db, ctx, `a2a.${skill}`, JSON.stringify(args).slice(0, 120));
      return agentMessage(rpc.id, result);
    }

    // plain text part → recall
    const text = parts.find((p) => typeof p.text === "string" && p.text.trim())?.text;
    if (text) {
      const result = await engine.recall(ctx, { query: text });
      await audit(db, ctx, "a2a.memory.recall", text.slice(0, 120));
      return agentMessage(rpc.id, result);
    }

    return rpcError(rpc.id, -32602, "message has no usable parts");
  } catch (err) {
    return rpcError(rpc.id, -32000, err instanceof Error ? err.message : String(err));
  }
}

export function startA2AServer(db: Db, opts: A2AServerOptions) {
  const port = opts.port ?? 4160;
  return Bun.serve({
    port,
    fetch: (req) => handleA2ARequest(db, { ...opts, port }, req),
  });
}
