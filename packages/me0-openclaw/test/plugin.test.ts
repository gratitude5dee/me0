import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Store, connect, operations } from "me0-core";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type {
  OpenClawHookEvent,
  OpenClawHookHandler,
  OpenClawPluginApi,
  OpenClawTool,
} from "../src/api.js";
import { createMe0Plugin } from "../src/plugin.js";

class MockApi implements OpenClawPluginApi {
  tools = new Map<string, OpenClawTool>();
  hooks = new Map<string, OpenClawHookHandler[]>();
  typed = new Map<string, (event: Record<string, unknown>) => unknown | Promise<unknown>>();
  warnings: string[] = [];
  logger = {
    info: (_: string) => {},
    warn: (msg: string) => {
      this.warnings.push(msg);
    },
    error: (_: string) => {},
  };

  constructor(public pluginConfig: Record<string, unknown>) {}

  registerTool(tool: OpenClawTool): void {
    this.tools.set(tool.name, tool);
  }
  registerHook(events: string | string[], handler: OpenClawHookHandler): void {
    for (const e of Array.isArray(events) ? events : [events]) {
      this.hooks.set(e, [...(this.hooks.get(e) ?? []), handler]);
    }
  }
  on(name: string, handler: (event: Record<string, unknown>) => unknown | Promise<unknown>): void {
    this.typed.set(name, handler);
  }
  async fire(event: OpenClawHookEvent): Promise<void> {
    const key = event.action ? `${event.type}:${event.action}` : event.type;
    for (const h of this.hooks.get(key) ?? []) await h(event);
  }
}

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let api: MockApi;
let plugin: ReturnType<typeof createMe0Plugin>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  api = new MockApi({ mongodb_uri: mongod.getUri(), user_id: "clawuser" });
  plugin = createMe0Plugin();
  await plugin.register(api);
  store = await connect(mongod.getUri());
  db = store.db;
});

afterAll(async () => {
  await plugin.runtime()?.close();
  await store.close();
  await mongod.stop();
});

describe("tool registration", () => {
  test("registers memory_search, memory_get, and every me0 verb", () => {
    expect(api.tools.has("memory_search")).toBe(true);
    expect(api.tools.has("memory_get")).toBe(true);
    for (const op of operations) expect(api.tools.has(op.name)).toBe(true);
  });
});

describe("tool delegation", () => {
  test("remember → memory_search → memory_get delegate to the me0 graph", async () => {
    const remembered = await api.tools
      .get("remember")
      ?.execute("t1", { text: "openclaw likes the me0 graph", kind: "fact", tier: "standing" });
    expect(remembered?.isError).toBeUndefined();
    const { memory_id } = remembered?.details as { memory_id: string };

    const search = await api.tools.get("memory_search")?.execute("t2", { query: "me0 graph" });
    const searchDetails = search?.details as { results: Array<{ memory_id: string }> };
    expect(searchDetails.results.some((r) => r.memory_id === memory_id)).toBe(true);

    const got = await api.tools.get("memory_get")?.execute("t3", { memory_id });
    expect((got?.details as { memory_id?: string }).memory_id).toBe(memory_id);

    // provenance stamped with the openclaw harness
    const doc = await db.collection("memories").findOne({ memory_id });
    expect(doc?.prov?.harness).toBe("openclaw");
  });

  test("memory_search abstains honestly when nothing matches", async () => {
    const r = await api.tools.get("memory_search")?.execute("t4", { query: "zzz-nonexistent-zzz" });
    const details = r?.details as { abstained: boolean; message?: string };
    expect(details.abstained).toBe(true);
    expect(details.message).toBe("no recorded memory");
  });
});

describe("lifecycle hooks", () => {
  test("command:new opens an episode; command:stop ends it", async () => {
    await api.fire({ type: "command", action: "new", sessionKey: "s1" });
    const episodeId = plugin.runtime()?.episodeFor("s1");
    expect(episodeId).toBeDefined();
    const ep = await db.collection("episodes").findOne({ episode_id: episodeId });
    expect(ep?.status).toBe("active");
    expect(ep?.harness).toBe("openclaw");

    await api.fire({ type: "command", action: "stop", sessionKey: "s1" });
    const ended = await db.collection("episodes").findOne({ episode_id: episodeId });
    expect(ended?.status).toBe("ended");
    expect(plugin.runtime()?.episodeFor("s1")).toBeUndefined();
  });

  test("session:compact:before banks a handoff and reopens an episode", async () => {
    await api.fire({ type: "command", action: "new", sessionKey: "s2" });
    const before = plugin.runtime()?.episodeFor("s2");
    const messages: string[] = [];
    await api.fire({
      type: "session",
      action: "compact:before",
      sessionKey: "s2",
      messages,
      context: { messageCount: 42 },
    });
    const banked = await db.collection("episodes").findOne({ episode_id: before });
    expect(banked?.status).toBe("handed_off");
    expect(banked?.handoff?.token).toStartWith("hd_");
    expect(messages[0]).toContain("resume: hd_");
    const after = plugin.runtime()?.episodeFor("s2");
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("agent:bootstrap injects the context pack", async () => {
    const bootstrapFiles: Array<{ name: string; content: string }> = [];
    await api.fire({
      type: "agent",
      action: "bootstrap",
      sessionKey: "s3",
      context: { bootstrapFiles },
    });
    expect(bootstrapFiles.length).toBe(1);
    expect(bootstrapFiles[0]?.name).toBe("ME0.md");
    expect(bootstrapFiles[0]?.content).toContain("<me0>");
  });

  test("heartbeat typed hook returns delta contributions", async () => {
    const handler = api.typed.get("heartbeat_prompt_contribution");
    expect(handler).toBeDefined();
    await api.tools.get("remember")?.execute("t5", { text: "fresh heartbeat fact", kind: "fact" });
    const contribution = (await handler?.({ sessionKey: "hb" })) as { prompt: string };
    expect(contribution.prompt).toContain("me0-delta");
    // cursor advanced: an immediate second heartbeat has nothing new
    expect(await handler?.({ sessionKey: "hb" })).toBeUndefined();
  });
});

describe("fail-open", () => {
  test("hooks never throw when MongoDB is unreachable", async () => {
    const deadApi = new MockApi({
      mongodb_uri: "mongodb://127.0.0.1:59999/?serverSelectionTimeoutMS=200",
      user_id: "clawuser",
    });
    const deadPlugin = createMe0Plugin();
    await deadPlugin.register(deadApi);

    await deadApi.fire({ type: "command", action: "new", sessionKey: "dead" });
    const bootstrapFiles: unknown[] = [];
    await deadApi.fire({
      type: "agent",
      action: "bootstrap",
      sessionKey: "dead",
      context: { bootstrapFiles },
    });
    expect(bootstrapFiles.length).toBe(0);
    expect(deadApi.warnings.some((w) => w.includes("fail-open"))).toBe(true);

    const r = await deadApi.tools.get("memory_search")?.execute("t6", { query: "anything" });
    expect(r?.isError).toBe(true);
    await deadPlugin.runtime()?.close();
  }, 20000);
});
