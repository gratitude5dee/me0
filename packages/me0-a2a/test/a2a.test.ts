import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Me0Engine, type OperationContext, type Store, connect, ensureCollections } from "me0-core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MEMORY_PROFILE_EXTENSION_URI, handleA2ARequest } from "../src/index.js";

let mongod: MongoMemoryServer;
let store: Store;

const ctx: OperationContext = {
  user_id: "u_a2a",
  harness: "other",
  agent: "a2a-test",
  episode_id: null,
  remote: false,
};

const opts = { userId: ctx.user_id, port: 4160 };

function rpc(params: Record<string, unknown>, token?: string): Request {
  return new Request("http://localhost:4160/", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params }),
  });
}

async function send(params: Record<string, unknown>) {
  const res = await handleA2ARequest(store.db, opts, rpc(params));
  return (await res.json()) as {
    result?: { parts: Array<{ data: Record<string, unknown> }>; extensions?: string[] };
    error?: { code: number; message: string };
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  await ensureCollections(store.db);
  const engine = new Me0Engine(store.db);
  await engine.remember(ctx, {
    text: "public: prefers dark documentation themes",
    kind: "preference",
    tier: "standing",
    visibility: "world",
  });
  await engine.remember(ctx, {
    text: "secret: private api key location documentation",
    kind: "fact",
    tier: "standing",
    visibility: "private",
  });
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("agent card", () => {
  test("served at the well-known path with memory skills + extension", async () => {
    const res = await handleA2ARequest(
      store.db,
      opts,
      new Request("http://localhost:4160/.well-known/agent-card.json"),
    );
    const card = (await res.json()) as {
      skills: Array<{ id: string }>;
      capabilities: { extensions: Array<{ uri: string }> };
    };
    expect(card.skills.map((s) => s.id)).toEqual([
      "memory.recall",
      "memory.context_pack",
      "memory.synthesize",
    ]);
    expect(card.capabilities.extensions[0]?.uri).toBe(MEMORY_PROFILE_EXTENSION_URI);
  });
});

describe("message/send", () => {
  test("recall skill sees world memories only (visibility ceiling)", async () => {
    const body = await send({
      message: {
        parts: [
          {
            kind: "data",
            data: { skill: "memory.recall", args: { query: "documentation themes" } },
          },
        ],
      },
    });
    const data = body.result?.parts[0]?.data as { results: Array<{ text: string }> };
    expect(data.results.some((r) => r.text.includes("dark documentation"))).toBe(true);
    expect(data.results.some((r) => r.text.includes("secret"))).toBe(false);
  });

  test("plain text part falls back to recall", async () => {
    const body = await send({ message: { parts: [{ kind: "text", text: "dark themes" }] } });
    const data = body.result?.parts[0]?.data as { results: unknown[] };
    expect(Array.isArray(data.results)).toBe(true);
  });

  test("memory-profile extension returns a redacted pack DataPart", async () => {
    const body = await send({
      message: {
        extensions: [MEMORY_PROFILE_EXTENSION_URI],
        parts: [{ kind: "data", data: { budget_tokens: 200 } }],
      },
    });
    expect(body.result?.extensions).toContain(MEMORY_PROFILE_EXTENSION_URI);
    const pack = body.result?.parts[0]?.data as { content: string; _meta: { budget_used: number } };
    expect(pack.content).toContain("dark documentation");
    expect(pack.content).not.toContain("secret");
    expect(pack._meta.budget_used).toBeLessThanOrEqual(200);
  });

  test("episode summaries and identity card never leak to remote peers", async () => {
    await store.db
      .collection("users")
      .updateOne(
        { user_id: ctx.user_id },
        { $set: { identity_card: "identity-card-local-only-notes" } },
      );
    await store.db.collection("episodes").insertOne({
      episode_id: "ep_a2a_leak",
      user_id: ctx.user_id,
      harness: "claude-code",
      agent: "test",
      title: "confidential migration plan",
      status: "handed_off",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      summary: "worked on the private api key rotation",
      handoff: null,
    });
    const body = await send({
      message: {
        extensions: [MEMORY_PROFILE_EXTENSION_URI],
        parts: [{ kind: "data", data: {} }],
      },
    });
    const pack = body.result?.parts[0]?.data as { content: string };
    expect(pack.content).not.toContain("confidential migration plan");
    expect(pack.content).not.toContain("private api key rotation");
    expect(pack.content).not.toContain("identity-card-local-only-notes");
    expect(pack.content).toContain("dark documentation");
  });

  test("non-object json bodies get an invalid-request error, not a crash", async () => {
    for (const raw of ["null", "42", '"hi"']) {
      const res = await handleA2ARequest(
        store.db,
        opts,
        new Request("http://localhost:4160/", { method: "POST", body: raw }),
      );
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32600);
    }
  });

  test("local-only verbs are not exposed as skills", async () => {
    const body = await send({
      message: {
        parts: [
          { kind: "data", data: { skill: "memory.remember", args: { text: "x", kind: "fact" } } },
        ],
      },
    });
    expect(body.error?.code).toBe(-32602);
  });

  test("every call is audited as remote", async () => {
    const audits = await store.db
      .collection("audit")
      .find({ op: { $regex: "^a2a\\." } })
      .toArray();
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.actor.remote === true)).toBe(true);
  });

  test("bearer token enforced when configured", async () => {
    const guarded = { ...opts, token: "sekrit" };
    const denied = await handleA2ARequest(
      store.db,
      guarded,
      rpc({ message: { parts: [{ kind: "text", text: "hi" }] } }),
    );
    expect(denied.status).toBe(401);
    const allowed = await handleA2ARequest(
      store.db,
      guarded,
      rpc({ message: { parts: [{ kind: "text", text: "hi" }] } }, "sekrit"),
    );
    expect(allowed.status).toBe(200);
  });

  test("unknown methods and malformed json get JSON-RPC errors", async () => {
    const res = await handleA2ARequest(
      store.db,
      opts,
      new Request("http://localhost:4160/", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get" }),
      }),
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
    const bad = await handleA2ARequest(
      store.db,
      opts,
      new Request("http://localhost:4160/", { method: "POST", body: "{not json" }),
    );
    const badBody = (await bad.json()) as { error: { code: number } };
    expect(badBody.error.code).toBe(-32700);
  });
});
