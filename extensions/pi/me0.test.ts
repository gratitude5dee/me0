import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OperationContext, Store } from "me0-core";
import { Me0Engine, connect, ensureCollections } from "me0-core";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  ME0_PI_TOOLS,
  type PiApi,
  type PiToolCallEvent,
  type PiToolDefinition,
  registerMe0,
} from "./me0.js";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

class FakePi implements PiApi {
  tools = new Map<string, PiToolDefinition>();
  handlers = new Map<string, Handler[]>();
  sent: Array<{ customType: string; content: string; display?: boolean }> = [];

  registerTool(tool: PiToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  sendMessage(message: { customType: string; content: string; display?: boolean }): void {
    this.sent.push(message);
  }

  async emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload);
    }
    // capture handlers are fire-and-forget; let their promises settle
    await new Promise((r) => setTimeout(r, 50));
  }
}

let mongod: MongoMemoryServer;
let store: Store;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "pi-user",
  harness: "pi",
  agent: "pi",
  episode_id: null,
  remote: false,
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  await ensureCollections(store.db);
  engine = new Me0Engine(store.db);
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("pi extension", () => {
  test("registers every memory_* tool with schema and description", () => {
    const pi = new FakePi();
    registerMe0(pi, async () => ({ engine, ctx: { ...ctx } }));
    for (const name of ME0_PI_TOOLS) {
      const tool = pi.tools.get(`memory_${name}`);
      expect(tool).toBeDefined();
      expect(tool?.description.length).toBeGreaterThan(0);
      expect(tool?.parameters).toHaveProperty("type", "object");
    }
  });

  test("tool delegation: remember → recall round-trip through the registry", async () => {
    const pi = new FakePi();
    registerMe0(pi, async () => ({ engine, ctx: { ...ctx } }));
    const remember = pi.tools.get("memory_remember");
    const w = await remember?.execute("t1", {
      text: "pi user prefers tabs over spaces",
      kind: "preference",
    });
    expect(w?.isError).toBeUndefined();
    expect(w?.details).toHaveProperty("action", "ADD");

    const recall = pi.tools.get("memory_recall");
    const r = await recall?.execute("t2", { query: "tabs over spaces" });
    const details = r?.details as { abstained: boolean; results: Array<{ text: string }> };
    expect(details.abstained).toBe(false);
    expect(details.results.some((x) => x.text.includes("tabs over spaces"))).toBe(true);
  });

  test("session_start opens an episode and injects the context pack", async () => {
    const pi = new FakePi();
    const liveCtx = { ...ctx };
    registerMe0(pi, async () => ({ engine, ctx: liveCtx }));
    await pi.emit("session_start");
    expect(liveCtx.episode_id).not.toBeNull();
    expect(pi.sent.length).toBe(1);
    expect(pi.sent[0]?.customType).toBe("me0-context-pack");
    expect(pi.sent[0]?.content).toContain(`<me0 episode_id="${liveCtx.episode_id}">`);
  });

  test("tool_call events are captured into the episode log; memory_* calls are not", async () => {
    const pi = new FakePi();
    const liveCtx = { ...ctx };
    registerMe0(pi, async () => ({ engine, ctx: liveCtx }));
    await pi.emit("session_start");
    const event: PiToolCallEvent = { toolName: "bash", input: { command: "ls" } };
    await pi.emit("tool_call", event as unknown as Record<string, unknown>);
    await pi.emit("tool_call", { toolName: "memory_recall", input: { query: "x" } });

    const events = await store.db
      .collection("events")
      .find({ episode_id: liveCtx.episode_id })
      .toArray();
    expect(events.length).toBe(1);
    expect(events[0]?.tool).toBe("bash");
    expect(events[0]?.type).toBe("tool_call");
  });

  test("session_shutdown ends the episode", async () => {
    const pi = new FakePi();
    const liveCtx = { ...ctx };
    registerMe0(pi, async () => ({ engine, ctx: liveCtx }));
    await pi.emit("session_start");
    await pi.emit("session_shutdown");
    const ep = await store.db
      .collection("episodes")
      .findOne({ user_id: ctx.user_id, episode_id: liveCtx.episode_id });
    expect(ep?.status).toBe("ended");
    expect(ep?.ended_at).not.toBeNull();
  });

  test("session_shutdown releases resources via close", async () => {
    const pi = new FakePi();
    let closed = 0;
    registerMe0(pi, async () => ({
      engine,
      ctx: { ...ctx },
      close: async () => {
        closed++;
      },
    }));
    await pi.emit("session_start");
    await pi.emit("session_shutdown");
    expect(closed).toBe(1);
  });

  test("overlapping first uses share one deps acquisition; failures allow retry", async () => {
    const pi = new FakePi();
    let calls = 0;
    let fail = true;
    registerMe0(pi, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      if (fail) throw new Error("mongo down");
      return { engine, ctx: { ...ctx } };
    });
    const recall = pi.tools.get("memory_recall");
    const [a, b] = await Promise.all([
      recall?.execute("t4", { query: "x" }),
      recall?.execute("t5", { query: "x" }),
    ]);
    expect(a?.isError).toBe(true);
    expect(b?.isError).toBe(true);
    expect(calls).toBe(1); // concurrent first uses shared one in-flight acquisition

    fail = false;
    const ok = await recall?.execute("t6", { query: "x" });
    expect(ok?.isError).toBeUndefined(); // rejection was not cached; retry succeeded
    expect(calls).toBe(2);
  });

  test("fail-open: unavailable memory never throws into pi", async () => {
    const pi = new FakePi();
    registerMe0(pi, async () => {
      throw new Error("mongo down");
    });
    const recall = pi.tools.get("memory_recall");
    const r = await recall?.execute("t3", { query: "anything" });
    expect(r?.isError).toBe(true);
    expect(r?.content[0]?.text).toContain("unavailable");
    await pi.emit("session_start");
    await pi.emit("tool_call", { toolName: "bash", input: {} });
    await pi.emit("session_shutdown");
    expect(pi.sent.length).toBe(0);
  });
});
