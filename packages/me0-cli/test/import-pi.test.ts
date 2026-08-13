import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EpisodeDoc, EventDoc, OperationContext, Store } from "me0-core";
import { connect, ensureCollections } from "me0-core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { importPiSessions } from "../src/pi.js";

const FIXTURES = join(import.meta.dir, "fixtures", "pi-sessions");

let mongod: MongoMemoryServer;
let store: Store;

const ctx: OperationContext = {
  user_id: "test-user",
  harness: "pi",
  agent: "me0-cli",
  episode_id: null,
  remote: false,
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  await ensureCollections(store.db);
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("import-pi", () => {
  test("round-trips fixture JSONL sessions into episodes + events", async () => {
    const stats = await importPiSessions(store.db, ctx, FIXTURES);
    expect(stats.files).toBe(2);
    expect(stats.imported).toBe(2);
    expect(stats.skipped).toBe(0);

    const ep = await store.db
      .collection<EpisodeDoc>("episodes")
      .findOne({ user_id: ctx.user_id, episode_id: "ep_pi_abc12345-1111-2222-3333-444455556666" });
    expect(ep).not.toBeNull();
    expect(ep?.harness).toBe("pi");
    expect(ep?.status).toBe("ended");
    expect(ep?.repo.cwd).toBe("/home/user/proj");
    expect(ep?.started_at).toBe("2026-01-02T03:04:05.000Z");
    expect(ep?.ended_at).toBe("2026-01-02T03:05:00.000Z");
    expect(ep?.title).toBe("fix the auth bug in login.ts");
    expect(ep?.agent.model).toBe("test-model-1");
    expect(ep?.tags).toContain("pi-import");
    expect(ep?.summary).toContain("1 prompts, 1 tool calls");

    const events = await store.db
      .collection<EventDoc>("events")
      .find({ episode_id: "ep_pi_abc12345-1111-2222-3333-444455556666" })
      .sort({ ts: 1 })
      .toArray();
    expect(events.map((e) => e.type)).toEqual([
      "prompt",
      "response",
      "tool_call",
      "command",
      "response",
    ]);
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall?.tool).toBe("read");
    expect(toolCall?.ok).toBe(true);
    const command = events.find((e) => e.type === "command");
    expect(command?.ok).toBe(true);

    const ep2 = await store.db
      .collection<EpisodeDoc>("episodes")
      .findOne({ user_id: ctx.user_id, episode_id: "ep_pi_def67890-aaaa-bbbb-cccc-ddddeeeeffff" });
    expect(ep2?.title).toBe("summarize yesterday");
  });

  test("re-running is idempotent (no duplicates)", async () => {
    const before = await store.db.collection("events").countDocuments({});
    const stats = await importPiSessions(store.db, ctx, FIXTURES);
    expect(stats.imported).toBe(0);
    expect(stats.skipped).toBe(2);
    expect(await store.db.collection("events").countDocuments({})).toBe(before);
    expect(await store.db.collection("episodes").countDocuments({ user_id: ctx.user_id })).toBe(2);
  });

  test("importing for a second user does not duplicate the shared event stream", async () => {
    const before = await store.db.collection("events").countDocuments({});
    const stats = await importPiSessions(store.db, { ...ctx, user_id: "second-user" }, FIXTURES);
    expect(stats.imported).toBe(2);
    expect(await store.db.collection("events").countDocuments({})).toBe(before);
    expect(await store.db.collection("episodes").countDocuments({ user_id: "second-user" })).toBe(
      2,
    );
  });

  test("a session missing its events (interrupted run) is repaired on re-import", async () => {
    const episodeId = "ep_pi_abc12345-1111-2222-3333-444455556666";
    // Simulate an import that died before its episode insert: no episode doc
    // (for any user) references the stream, and only partial events landed.
    await store.db.collection("episodes").deleteMany({ episode_id: episodeId });
    await store.db
      .collection("events")
      .deleteMany({ episode_id: episodeId, type: { $ne: "prompt" } });
    const stats = await importPiSessions(store.db, ctx, FIXTURES);
    expect(stats.imported).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(await store.db.collection("events").countDocuments({ episode_id: episodeId })).toBe(5);
  });

  test("re-importing under another user never rewrites a stream an episode already owns", async () => {
    const episodeId = "ep_pi_abc12345-1111-2222-3333-444455556666";
    // Poke the stream so a rewrite would be detectable, then import for a
    // fresh user: since episodes already reference the stream, it must be
    // left untouched.
    await store.db.collection("events").deleteOne({ episode_id: episodeId, type: "command" });
    const stats = await importPiSessions(store.db, { ...ctx, user_id: "third-user" }, FIXTURES);
    expect(stats.imported).toBe(2);
    expect(stats.events).toBe(0);
    expect(await store.db.collection("events").countDocuments({ episode_id: episodeId })).toBe(4);
  });
});
