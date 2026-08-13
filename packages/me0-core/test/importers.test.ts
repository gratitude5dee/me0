import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Me0Engine } from "../src/engine.js";
import { importClaudeDir, importClaudeTranscript } from "../src/importers/claude.js";
import {
  IMPORT_CONFIDENCE,
  type ImportedMemoryDoc,
  discoverContextFiles,
  importContextFile,
} from "../src/importers/context.js";
import { classifyKind, normalizeText, parseMarkdown } from "../src/importers/markdown.js";
import { type Store, connect, ensureCollections } from "../src/store/mongo.js";
import type { OperationContext } from "../src/types.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const CLAUDE_MD = join(FIXTURES, "CLAUDE.md");
const CLAUDE_HOME = join(FIXTURES, "claude-home");
const TRANSCRIPT = join(CLAUDE_HOME, "projects", "my-project", "session-abc.jsonl");

let mongod: MongoMemoryServer;
let store: Store;
let db: Db;
let engine: Me0Engine;

const ctx: OperationContext = {
  user_id: "import-user",
  harness: "other",
  agent: "me0-cli",
  episode_id: null,
  remote: false,
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  db = store.db;
  await ensureCollections(db);
  engine = new Me0Engine(db);
});

afterAll(async () => {
  await store.close();
  await mongod.stop();
});

describe("markdown parsing + kind heuristics", () => {
  test("classifyKind", () => {
    expect(classifyKind("Prefer tabs over spaces")).toBe("preference");
    expect(classifyKind("We decided to use Postgres")).toBe("decision");
    expect(classifyKind("Run npm install before building")).toBe("procedure");
    expect(classifyKind("The API lives at api.example.com")).toBe("fact");
  });

  test("normalizeText strips bullets and collapses whitespace", () => {
    expect(normalizeText("- some   text\n")).toBe("some text");
    expect(normalizeText("1. numbered item")).toBe("numbered item");
  });

  test("parseMarkdown tracks headings and skips code fences", () => {
    const items = parseMarkdown(
      "# Top\n\n## Sub\n- bullet one\n\npara text here\n\n```\nfenced line\n```\n",
    );
    expect(items.map((i) => i.text)).toEqual(["bullet one", "para text here"]);
    expect(items[0]?.heading_path).toEqual(["Top", "Sub"]);
    expect(items.some((i) => i.text.includes("fenced"))).toBe(false);
  });
});

describe("import-context", () => {
  test("imports fixture markdown with expected kinds, provenance, and source", async () => {
    const r = await importContextFile(engine, db, ctx, CLAUDE_MD);
    expect(r.added).toBe(7);
    expect(r.skipped).toBe(0);
    expect(r.kinds.preference).toBe(2); // "Prefer conventional..." + "Always deploy..."
    expect(r.kinds.decision).toBe(1);
    expect(r.kinds.procedure).toBe(2); // "Run `bun test`..." + "Use the staging..."
    expect(r.kinds.fact).toBe(2);

    const docs = await db
      .collection<ImportedMemoryDoc>("memories")
      .find({ user_id: ctx.user_id, "source.file": CLAUDE_MD })
      .toArray();
    expect(docs).toHaveLength(7);
    for (const d of docs) {
      expect(d.prov.method).toBe("deterministic");
      expect(d.prov.confidence).toBe(IMPORT_CONFIDENCE);
      expect(d.source.file).toBe(CLAUDE_MD);
    }
    expect(docs.some((d) => d.text.includes("never import this line"))).toBe(false);

    const codeStyle = docs.find((d) => d.text.startsWith("Prefer conventional"));
    expect(codeStyle?.source.heading_path).toEqual(["Project conventions", "Code style"]);
    expect(codeStyle?.entity_refs.length).toBe(1);
    const ent = await db
      .collection("entities")
      .findOne({ user_id: ctx.user_id, slug: "code-style" });
    expect(ent?.type).toBe("concept");
    expect(codeStyle?.entity_refs[0]).toBe(ent?.entity_id as string);
  });

  test("re-import is idempotent (all duplicates skipped)", async () => {
    const r = await importContextFile(engine, db, ctx, CLAUDE_MD);
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(7);
    const count = await db
      .collection("memories")
      .countDocuments({ user_id: ctx.user_id, "source.file": CLAUDE_MD });
    expect(count).toBe(7);
  });

  test("rejects remote callers", async () => {
    await expect(
      importContextFile(engine, db, { ...ctx, remote: true }, CLAUDE_MD),
    ).rejects.toThrow("local-only");
  });

  test("discoverContextFiles walks up and checks harness homes", () => {
    const files = discoverContextFiles(join(CLAUDE_HOME, "projects", "my-project"), CLAUDE_HOME);
    expect(files).toContain(join(CLAUDE_HOME, "projects", "my-project", "MEMORY.md"));
  });
});

describe("import-claude", () => {
  test("imports transcript as episode + capped events", async () => {
    const r = await importClaudeTranscript(engine, db, ctx, TRANSCRIPT, "my-project");
    expect(r.action).toBe("ADD");
    expect(r.episode_id).toStartWith("ep_claude_");
    expect(r.events).toBe(5); // 2 prompts, 2 responses, 1 tool_call

    const ep = await db
      .collection("episodes")
      .findOne({ user_id: ctx.user_id, episode_id: r.episode_id });
    expect(ep?.harness).toBe("claude-code");
    expect(ep?.summary).toBe("Fixed the auth bug");
    expect(ep?.status).toBe("ended");
    expect(ep?.started_at).toBe("2026-01-01T10:00:00.000Z");
    expect(ep?.ended_at).toBe("2026-01-01T10:01:30.000Z");

    const events = await db.collection("events").find({ episode_id: r.episode_id }).toArray();
    expect(events).toHaveLength(5);
    expect(events.filter((e) => e.type === "prompt")).toHaveLength(2);
    expect(events.filter((e) => e.type === "response")).toHaveLength(2);
    const tool = events.find((e) => e.type === "tool_call");
    expect(tool?.tool).toBe("Bash");
  });

  test("re-import of the same transcript is a NOOP keyed on session id", async () => {
    const r = await importClaudeTranscript(engine, db, ctx, TRANSCRIPT, "my-project");
    expect(r.action).toBe("NOOP");
    expect(r.events).toBe(0);
    const count = await db
      .collection("episodes")
      .countDocuments({ user_id: ctx.user_id, episode_id: r.episode_id });
    expect(count).toBe(1);
  });

  test("importClaudeDir walks projects: memories + transcripts, idempotent", async () => {
    const freshCtx: OperationContext = { ...ctx, user_id: "claude-dir-user" };
    const r1 = await importClaudeDir(engine, db, freshCtx, CLAUDE_HOME);
    expect(r1.memories_added).toBe(2);
    expect(r1.transcripts).toHaveLength(1);
    expect(r1.transcripts[0]?.action).toBe("ADD");

    const prefs = await db
      .collection("memories")
      .findOne({ user_id: freshCtx.user_id, text: "User prefers dark mode in all tools" });
    expect(prefs?.kind).toBe("preference");

    const r2 = await importClaudeDir(engine, db, freshCtx, CLAUDE_HOME);
    expect(r2.memories_added).toBe(0);
    expect(r2.memories_skipped).toBe(2);
    expect(r2.transcripts[0]?.action).toBe("NOOP");
  });

  test("missing dir is a no-op (fail-open)", async () => {
    const r = await importClaudeDir(engine, db, ctx, join(FIXTURES, "does-not-exist"));
    expect(r.memories_added).toBe(0);
    expect(r.transcripts).toHaveLength(0);
  });
});
