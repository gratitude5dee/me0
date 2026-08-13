import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EpisodeDoc, EventDoc, Me0Engine, MemoryKind, MemoryTier } from "me0-core";
import type { OperationContext } from "me0-core";
import type { Db } from "mongodb";

export interface HermesImportCounts {
  episodes: number;
  events: number;
  memories: number;
  skipped_memories: number;
}

interface SessionRow {
  id: string;
  source?: string;
  user_id?: string | null;
  model?: string | null;
  started_at: number;
  ended_at?: number | null;
  title?: string | null;
  cwd?: string | null;
  git_branch?: string | null;
  git_repo_root?: string | null;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_calls: string | null;
  timestamp: number;
}

function iso(epochSeconds: number | null | undefined): string {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) {
    return new Date(0).toISOString();
  }
  return new Date(epochSeconds * 1000).toISOString();
}

function eventType(role: string): EventDoc["type"] | null {
  switch (role) {
    case "user":
      return "prompt";
    case "assistant":
      return "response";
    case "tool":
      return "tool_call";
    default:
      return null; // system / other roles carry no episodic signal
  }
}

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Import Hermes's SQLite state.db (sessions/messages) into me0 episodes/events.
 * Deterministic (no LLM) and idempotent: episodes are keyed `hermes_<session id>`
 * and upserted; events are deduped on their Hermes message id.
 */
export async function importHermesStateDb(
  mongo: Db,
  ctx: OperationContext,
  dbPath: string,
): Promise<{ episodes: number; events: number }> {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const sessionCols = tableColumns(sqlite, "sessions");
    const pick = (col: string) => (sessionCols.has(col) ? col : `NULL AS ${col}`);
    const sessions = sqlite
      .query(
        `SELECT id, ${pick("source")}, ${pick("model")}, started_at, ${pick("ended_at")},
                ${pick("title")}, ${pick("cwd")}, ${pick("git_branch")}, ${pick("git_repo_root")}
         FROM sessions ORDER BY started_at`,
      )
      .all() as SessionRow[];

    const episodes = mongo.collection<EpisodeDoc>("episodes");
    const events = mongo.collection<EventDoc>("events");
    let episodeCount = 0;
    let eventCount = 0;

    for (const s of sessions) {
      const episodeId = `hermes_${s.id}`;
      const doc: EpisodeDoc = {
        user_id: ctx.user_id,
        episode_id: episodeId,
        harness: "hermes",
        agent: { name: "hermes", model: s.model ?? null },
        project: null,
        repo: { remote: s.git_repo_root ?? null, branch: s.git_branch ?? null, cwd: s.cwd ?? null },
        started_at: iso(s.started_at),
        ended_at: s.ended_at != null ? iso(s.ended_at) : null,
        status: "ended",
        title: s.title ?? `hermes ${s.source ?? "session"} ${s.id}`,
        summary: null,
        outcome: { success: null, artifacts: [], commits: [] },
        handoff: null,
        tags: ["hermes-import"],
      };
      const r = await episodes.updateOne(
        { user_id: ctx.user_id, episode_id: episodeId },
        { $setOnInsert: doc },
        { upsert: true },
      );
      if (r.upsertedCount > 0) episodeCount++;

      const messages = sqlite
        .query(
          `SELECT id, session_id, role, content, tool_name, tool_calls, timestamp
           FROM messages WHERE session_id = ? ORDER BY id`,
        )
        .all(s.id) as MessageRow[];
      const existing = new Set(
        (
          await events
            .find({ episode_id: episodeId, "payload.hermes_message_id": { $exists: true } })
            .project<{ payload: { hermes_message_id: number } }>({
              "payload.hermes_message_id": 1,
            })
            .toArray()
        ).map((e) => e.payload.hermes_message_id),
      );
      const fresh = messages
        .map((m): EventDoc | null => {
          const type = eventType(m.role);
          if (type === null || existing.has(m.id)) return null;
          return {
            ts: iso(m.timestamp),
            episode_id: episodeId,
            type,
            tool: m.tool_name ?? null,
            ok: null,
            payload: {
              hermes_message_id: m.id,
              text: (m.content ?? "").slice(0, 2000),
              ...(m.tool_calls ? { tool_calls: m.tool_calls.slice(0, 2000) } : {}),
            },
          };
        })
        .filter((e): e is EventDoc => e !== null);
      if (fresh.length > 0) {
        await events.insertMany(fresh);
        eventCount += fresh.length;
      }
    }
    return { episodes: episodeCount, events: eventCount };
  } finally {
    sqlite.close();
  }
}

const MEMORY_FILES: Array<{ file: string; kind: MemoryKind; tier: MemoryTier }> = [
  { file: "MEMORY.md", kind: "fact", tier: "standing" },
  { file: "USER.md", kind: "fact", tier: "core" },
  { file: "SOUL.md", kind: "procedure", tier: "standing" },
];

function parseMarkdownLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter((line) => line.length > 2 && !line.startsWith("#") && !/^[-=*_]{3,}$/.test(line));
}

/**
 * Import Hermes's markdown memory files (MEMORY.md / USER.md / SOUL.md) as
 * typed me0 memories. Idempotent via remember's exact-text dedupe (NOOP).
 */
export async function importHermesMemoryFiles(
  engine: Me0Engine,
  ctx: OperationContext,
  memoriesDir: string,
): Promise<{ memories: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for (const { file, kind, tier } of MEMORY_FILES) {
    const path = join(memoriesDir, file);
    if (!existsSync(path)) continue;
    for (const line of parseMarkdownLines(readFileSync(path, "utf-8"))) {
      const r = (await engine.remember(ctx, { text: line, kind, tier })) as { action: string };
      if (r.action === "ADD") added++;
      else skipped++;
    }
  }
  return { memories: added, skipped };
}

export function hermesImportContext(userId: string): OperationContext {
  return {
    user_id: userId,
    harness: "hermes",
    agent: "hermes-import",
    episode_id: null,
    remote: false,
  };
}

export async function importHermes(
  mongo: Db,
  engine: Me0Engine,
  userId: string,
  opts: { dbPath?: string; hermesHome?: string } = {},
): Promise<HermesImportCounts> {
  const home = opts.hermesHome ?? join(homedir(), ".hermes");
  const dbPath = opts.dbPath ?? join(home, "state.db");
  const ctx = hermesImportContext(userId);
  const counts: HermesImportCounts = { episodes: 0, events: 0, memories: 0, skipped_memories: 0 };
  if (existsSync(dbPath)) {
    const r = await importHermesStateDb(mongo, ctx, dbPath);
    counts.episodes = r.episodes;
    counts.events = r.events;
  } else {
    console.error(`hermes state.db not found at ${dbPath} — skipping session import`);
  }
  const memoriesDir = join(home, "memories");
  if (existsSync(memoriesDir)) {
    const r = await importHermesMemoryFiles(engine, ctx, memoriesDir);
    counts.memories = r.memories;
    counts.skipped_memories = r.skipped;
  } else {
    console.error(`hermes memories dir not found at ${memoriesDir} — skipping file import`);
  }
  return counts;
}
