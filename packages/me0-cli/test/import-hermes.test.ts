import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EpisodeDoc,
  type EventDoc,
  Me0Engine,
  type MemoryDoc,
  connect,
  ensureCollections,
} from "me0-core";
import type { Store } from "me0-core";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { me0McpYamlBlock, wireHermesConfig } from "../src/hermes.js";
import { importHermes } from "../src/import-hermes.js";

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;
let hermesHome: string;

const USER = "test-user";

function buildFixture(home: string) {
  mkdirSync(join(home, "memories"), { recursive: true });
  const sqlite = new Database(join(home, "state.db"));
  sqlite.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT, model TEXT,
    started_at REAL, ended_at REAL, title TEXT,
    cwd TEXT, git_branch TEXT, git_repo_root TEXT
  )`);
  sqlite.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
    content TEXT, tool_name TEXT, tool_calls TEXT, timestamp REAL
  )`);
  sqlite.run(
    `INSERT INTO sessions VALUES ('sess-1','cli','hermes-4',1755000000,1755000600,'fix the parser','/w','main','git@x:y.git')`,
  );
  sqlite.run(
    `INSERT INTO sessions (id, source, started_at) VALUES ('sess-2','discord',1755001000)`,
  );
  const msg = sqlite.prepare(
    "INSERT INTO messages (session_id, role, content, tool_name, tool_calls, timestamp) VALUES (?,?,?,?,?,?)",
  );
  msg.run("sess-1", "user", "please fix the parser", null, null, 1755000001);
  msg.run("sess-1", "assistant", "on it", null, null, 1755000002);
  msg.run("sess-1", "tool", "grep output", "grep", '{"pattern":"x"}', 1755000003);
  msg.run("sess-1", "system", "system prompt", null, null, 1755000000);
  msg.run("sess-2", "user", "hello", null, null, 1755001001);
  sqlite.close();

  writeFileSync(
    join(home, "memories", "MEMORY.md"),
    "# Memory\n\n- Prefers TypeScript over Python\n- Works on the me0 project\n\n```bash\nrm -rf /tmp/junk\n```\n\n| a | b |\n",
  );
  writeFileSync(join(home, "memories", "USER.md"), "Name: Ada\n\n---\n");
  writeFileSync(
    join(home, "memories", "SOUL.md"),
    "## Style\n1. Always run tests before pushing\n",
  );
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  db = store.db;
  await ensureCollections(db);
  engine = new Me0Engine(db);
  hermesHome = mkdtempSync(join(tmpdir(), "hermes-fixture-"));
  buildFixture(hermesHome);
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
  rmSync(hermesHome, { recursive: true, force: true });
});

describe("import-hermes", () => {
  test("round-trips sessions, messages, and markdown memories", async () => {
    const counts = await importHermes(db, engine, USER, { hermesHome });
    expect(counts.episodes).toBe(2);
    expect(counts.events).toBe(4); // system message skipped
    expect(counts.memories).toBe(4);

    const ep = await db
      .collection<EpisodeDoc>("episodes")
      .findOne({ user_id: USER, episode_id: "hermes_sess-1" });
    expect(ep).not.toBeNull();
    expect(ep?.harness).toBe("hermes");
    expect(ep?.title).toBe("fix the parser");
    expect(ep?.started_at).toBe(new Date(1755000000 * 1000).toISOString());
    expect(ep?.repo.branch).toBe("main");

    const events = await db
      .collection<EventDoc>("events")
      .find({ episode_id: "hermes_sess-1" })
      .toArray();
    expect(events.length).toBe(3);
    expect(events.map((e) => e.type).sort()).toEqual(["prompt", "response", "tool_call"].sort());
    const toolEvent = events.find((e) => e.type === "tool_call");
    expect(toolEvent?.tool).toBe("grep");

    const mems = await db
      .collection<MemoryDoc>("memories")
      .find({ user_id: USER, "prov.harness": "hermes" })
      .toArray();
    const texts = mems.map((m) => m.text);
    expect(texts).toContain("Prefers TypeScript over Python");
    // fenced code blocks and table rows are skipped
    expect(texts.some((t) => t.includes("rm -rf") || t.includes("```") || t.startsWith("|"))).toBe(
      false,
    );
    expect(texts).toContain("Name: Ada");
    expect(texts).toContain("Always run tests before pushing");
    for (const m of mems) {
      expect(m.prov.method).toBe("deterministic");
      expect(m.prov.agent).toBe("hermes-import");
      expect(m.visibility).toBe("private");
    }
    const userMem = mems.find((m) => m.text === "Name: Ada");
    expect(userMem?.tier).toBe("core");
  });

  test("is idempotent on re-import", async () => {
    const counts = await importHermes(db, engine, USER, { hermesHome });
    expect(counts.episodes).toBe(0);
    expect(counts.events).toBe(0);
    expect(counts.memories).toBe(0);
    expect(counts.skipped_memories).toBe(4);
    expect(await db.collection("events").countDocuments({ episode_id: "hermes_sess-1" })).toBe(3);
    expect(
      await db
        .collection("memories")
        .countDocuments({ user_id: USER, "prov.harness": "hermes", deleted_at: null }),
    ).toBe(4);
  });

  test("skips missing state.db / memories dir without throwing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hermes-empty-"));
    try {
      const counts = await importHermes(db, engine, USER, { hermesHome: empty });
      expect(counts).toEqual({ episodes: 0, events: 0, memories: 0, skipped_memories: 0 });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("hermes config wiring", () => {
  test("creates config.yaml with mcp_servers.me0 and is idempotent", () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-config-"));
    try {
      expect(wireHermesConfig("mongodb://127.0.0.1:27017", "me", home)).toBe(true);
      const written = readFileSync(join(home, "config.yaml"), "utf-8");
      expect(written).toContain("mcp_servers:");
      expect(written).toContain(me0McpYamlBlock("mongodb://127.0.0.1:27017", "me"));
      expect(wireHermesConfig("mongodb://127.0.0.1:27017", "me", home)).toBe(false);
      expect(readFileSync(join(home, "config.yaml"), "utf-8")).toBe(written);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("tolerates a messages table with missing optional columns", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-mincols-"));
    try {
      mkdirSync(join(home, "memories"), { recursive: true });
      const sqlite = new Database(join(home, "state.db"));
      sqlite.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL)");
      sqlite.run(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT)",
      );
      sqlite.run("INSERT INTO sessions VALUES ('s1', 1755000000)");
      sqlite.run("INSERT INTO messages VALUES (1, 's1', 'user', 'hi there')");
      sqlite.close();
      const counts = await importHermes(db, engine, "mincols-user", { hermesHome: home });
      expect(counts.episodes).toBe(1);
      expect(counts.events).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("inserts under an existing mcp_servers key", () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-config2-"));
    try {
      writeFileSync(
        join(home, "config.yaml"),
        'model: hermes-4\nmcp_servers:\n  other:\n    command: "other-mcp"\n',
      );
      expect(wireHermesConfig("mongodb://127.0.0.1:27017", "me", home)).toBe(true);
      const written = readFileSync(join(home, "config.yaml"), "utf-8");
      expect(written.indexOf("me0:")).toBeGreaterThan(written.indexOf("mcp_servers:"));
      expect(written).toContain("  other:");
      expect(written.match(/^\s{2}me0:/gm)?.length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("matches the indentation of existing children", () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-config4-"));
    try {
      writeFileSync(
        join(home, "config.yaml"),
        'mcp_servers:\n    other:\n        command: "other-mcp"\n',
      );
      expect(wireHermesConfig("mongodb://127.0.0.1:27017", "me", home)).toBe(true);
      const written = readFileSync(join(home, "config.yaml"), "utf-8");
      expect(written).toContain("\n    me0:\n");
      expect(written).toContain('\n        command: "me0-mcp"\n');
      expect(written).toContain("\n    other:\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("bails out on flow-style mcp_servers without corrupting the file", () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-config5-"));
    try {
      const original = 'mcp_servers: {other: {command: "other-mcp"}}\n';
      writeFileSync(join(home, "config.yaml"), original);
      expect(wireHermesConfig("mongodb://127.0.0.1:27017", "me", home)).toBe(false);
      expect(readFileSync(join(home, "config.yaml"), "utf-8")).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
