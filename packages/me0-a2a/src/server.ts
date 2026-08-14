import { randomUUID, timingSafeEqual } from "node:crypto";
import { Me0Engine, type OperationContext } from "me0-core";
import type { Db } from "mongodb";
import { MEMORY_PROFILE_EXTENSION_URI, buildAgentCard } from "./card.js";
import {
  type A2AAuthMode,
  type A2AOAuthOptions,
  SCOPE_PROFILE,
  SCOPE_RECALL,
  verifierFor,
} from "./oauth.js";

export interface A2AServerOptions {
  userId: string;
  port?: number;
  /** bearer token required on every request when set */
  token?: string;
  /** public base url advertised on the agent card */
  url?: string;
  /** bind address; defaults to loopback — non-loopback binds require a token or oauth config */
  hostname?: string;
  /** OAuth 2.1 resource-server config: validate Bearer JWT access tokens */
  oauth?: A2AOAuthOptions;
  /** which credentials are accepted; defaults from which of token/oauth are set */
  authMode?: A2AAuthMode;
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

/** RFC 7235: the auth-scheme is case-insensitive; returns the credentials or null */
function bearerCredentials(header: string | null): string | null {
  const match = /^bearer +/i.exec(header ?? "");
  return match ? (header as string).slice(match[0].length) : null;
}

function tokenMatches(provided: string | null, expected: string): boolean {
  const credentials = bearerCredentials(provided);
  if (credentials === null) return false;
  const a = Buffer.from(credentials);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function remoteCtx(userId: string): OperationContext {
  // Hard rule (goal.md §9.3): A2A callers are remote — visibility ceiling
  // `world`, local-only verbs rejected, every call audited.
  return { user_id: userId, harness: "other", agent: "a2a-peer", episode_id: null, remote: true };
}

function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  init?: ResponseInit,
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, init);
}

function effectiveAuthMode(opts: A2AServerOptions): A2AAuthMode | "none" {
  if (opts.authMode) return opts.authMode;
  if (opts.oauth && opts.token) return "either";
  if (opts.oauth) return "oauth";
  if (opts.token) return "token";
  return "none";
}

/** RFC 6750 §3: 401s carry a WWW-Authenticate challenge, never internals */
function unauthorized(hadCredentials: boolean): Response {
  const challenge = hadCredentials
    ? 'Bearer realm="me0", error="invalid_token"'
    : 'Bearer realm="me0"';
  return new Response("unauthorized", {
    status: 401,
    headers: { "www-authenticate": challenge },
  });
}

function insufficientScope(id: JsonRpcRequest["id"], scope: string): Response {
  return rpcError(id, -32003, "insufficient scope", {
    status: 403,
    headers: {
      "www-authenticate": `Bearer realm="me0", error="insufficient_scope", scope="${scope}"`,
    },
  });
}

interface AuthGrant {
  /** token `sub` when OAuth-authenticated; null for static token / open loopback */
  sub: string | null;
  /** granted scopes when OAuth-authenticated; null means unrestricted */
  scopes: Set<string> | null;
}

async function authenticate(opts: A2AServerOptions, req: Request): Promise<AuthGrant | Response> {
  const mode = effectiveAuthMode(opts);
  if (mode === "none") return { sub: null, scopes: null };
  const header = req.headers.get("authorization");
  if ((mode === "token" || mode === "either") && opts.token && tokenMatches(header, opts.token)) {
    return { sub: null, scopes: null };
  }
  if ((mode === "oauth" || mode === "either") && opts.oauth) {
    const credentials = bearerCredentials(header);
    if (credentials === null) return unauthorized(header !== null);
    try {
      const verified = await verifierFor(opts.oauth).verify(credentials);
      return { sub: verified.sub, scopes: verified.scopes };
    } catch {
      // fail closed on any validation error; no internals in the body
      return unauthorized(true);
    }
  }
  return unauthorized(header !== null);
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

async function audit(
  db: Db,
  ctx: OperationContext,
  op: string,
  detail: string,
  sub?: string | null,
): Promise<void> {
  await db.collection("audit").insertOne({
    ts: new Date().toISOString(),
    actor: { harness: ctx.harness, agent: ctx.agent, remote: true, ...(sub ? { sub } : {}) },
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
    const mode = effectiveAuthMode(opts);
    const oauthActive = opts.oauth && mode !== "token" ? opts.oauth : undefined;
    return Response.json(
      buildAgentCard({
        url: opts.url ?? `http://localhost:${opts.port ?? 4160}`,
        auth: opts.token && mode !== "oauth" ? "bearer" : "none",
        oauth: oauthActive
          ? {
              issuer: oauthActive.issuer,
              tokenUrl: await verifierFor(oauthActive).tokenEndpoint(),
            }
          : undefined,
      }),
    );
  }
  if (req.method !== "POST" || url.pathname !== "/") {
    return new Response("not found", { status: 404 });
  }
  const grant = await authenticate(opts, req);
  if (grant instanceof Response) return grant;

  // reject oversized bodies before buffering: trust Content-Length when
  // declared, then re-check actual byte length after a streaming read
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return rpcError(null, -32600, "request too large");
  }
  let rpc: JsonRpcRequest;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of req.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        return rpcError(null, -32600, "request too large");
      }
      chunks.push(chunk);
    }
    rpc = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as JsonRpcRequest;
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
      if (grant.scopes && !grant.scopes.has(SCOPE_PROFILE)) {
        return insufficientScope(rpc.id, SCOPE_PROFILE);
      }
      const rawBudget = parts.find((p) => typeof p.data?.budget_tokens === "number")?.data
        ?.budget_tokens as number | undefined;
      const budget =
        rawBudget !== undefined && Number.isFinite(rawBudget)
          ? Math.min(Math.max(Math.floor(rawBudget), 1), MAX_BUDGET_TOKENS)
          : undefined;
      const pack = await engine.contextPack(ctx, { scope: "a2a:profile", budget_tokens: budget });
      await audit(db, ctx, "a2a.memory_profile", `budget=${pack._meta.budget_tokens}`, grant.sub);
      return agentMessage(rpc.id, pack, MEMORY_PROFILE_EXTENSION_URI);
    }

    // explicit skill invocation via DataPart {skill, args}
    const skillPart = parts.find((p) => typeof p.data?.skill === "string");
    if (skillPart?.data) {
      const skill = skillPart.data.skill as string;
      if (!SKILLS.has(skill)) return rpcError(rpc.id, -32602, `unknown skill: ${skill}`);
      if (grant.scopes && !grant.scopes.has(SCOPE_RECALL)) {
        return insufficientScope(rpc.id, SCOPE_RECALL);
      }
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
      await audit(db, ctx, `a2a.${skill}`, JSON.stringify(args).slice(0, 120), grant.sub);
      return agentMessage(rpc.id, result);
    }

    // plain text part → recall
    const text = parts.find((p) => typeof p.text === "string" && p.text.trim())?.text;
    if (text) {
      if (grant.scopes && !grant.scopes.has(SCOPE_RECALL)) {
        return insufficientScope(rpc.id, SCOPE_RECALL);
      }
      const result = await engine.recall(ctx, { query: text.slice(0, MAX_QUERY_CHARS) });
      await audit(db, ctx, "a2a.memory.recall", text.slice(0, 120), grant.sub);
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
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && !opts.token && !opts.oauth) {
    throw new Error(
      `refusing to bind A2A server to ${hostname} without auth (set --a2a-token/ME0_A2A_TOKEN or OAuth issuer/audience)`,
    );
  }
  return Bun.serve({
    port,
    hostname,
    fetch: (req) => handleA2ARequest(db, { ...opts, port }, req),
  });
}
