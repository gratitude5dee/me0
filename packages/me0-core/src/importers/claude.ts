import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Db } from "mongodb";
import type { Me0Engine } from "../engine.js";
import type { EpisodeDoc, EventDoc, OperationContext } from "../types.js";
import { importContextFile } from "./context.js";

export const MAX_EVENTS_PER_TRANSCRIPT = 500;
export const MAX_PAYLOAD_CHARS = 1000;

export interface ImportTranscriptResult {
  file: string;
  episode_id: string;
  action: "ADD" | "NOOP";
  events: number;
}

export interface ImportClaudeResult {
  memories_added: number;
  memories_skipped: number;
  transcripts: ImportTranscriptResult[];
}

function now(): string {
  return new Date().toISOString();
}

function cap(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS ? `${text.slice(0, MAX_PAYLOAD_CHARS)}…` : text;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  summary?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
}

type MessageContent = NonNullable<TranscriptLine["message"]>["content"];

function contentText(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/**
 * Deterministic import of one Claude Code session transcript (JSONL) as an
 * episode plus capped events. Idempotent: the episode id is derived from the
 * session id (falling back to the file name), so re-import is a NOOP.
 */
export async function importClaudeTranscript(
  engine: Me0Engine,
  db: Db,
  ctx: OperationContext,
  file: string,
  project: string | null,
): Promise<ImportTranscriptResult> {
  if (ctx.remote) throw new Error("import-claude is local-only");
  await engine.ensureUser(ctx);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const parsed: TranscriptLine[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // skip malformed lines: import must be deterministic and fail-open
    }
  }

  const sessionId = parsed.find((l) => l.sessionId)?.sessionId ?? basename(file, ".jsonl");
  const episodeId = `ep_claude_${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;

  const episodes = db.collection<EpisodeDoc>("episodes");
  const existing = await episodes.findOne({ user_id: ctx.user_id, episode_id: episodeId });
  if (existing) {
    return { file, episode_id: episodeId, action: "NOOP", events: 0 };
  }

  const first = parsed.find((l) => l.timestamp);
  const timestamps = parsed.map((l) => l.timestamp).filter((t): t is string => Boolean(t));
  const summary = parsed.find((l) => l.type === "summary")?.summary ?? null;
  const model = parsed.find((l) => l.message?.model)?.message?.model ?? null;
  const firstPrompt = parsed.find((l) => l.type === "user");
  const title = summary ?? (contentText(firstPrompt?.message?.content).slice(0, 120) || null);

  const events: EventDoc[] = [];
  for (const line of parsed) {
    if (events.length >= MAX_EVENTS_PER_TRANSCRIPT) break;
    const ts = line.timestamp ?? now();
    if (line.type === "user") {
      const text = contentText(line.message?.content);
      if (text) {
        events.push({
          ts,
          episode_id: episodeId,
          type: "prompt",
          tool: null,
          ok: null,
          payload: { text: cap(text) },
        });
      }
    } else if (line.type === "assistant") {
      const content = line.message?.content;
      const text = contentText(content);
      if (text) {
        events.push({
          ts,
          episode_id: episodeId,
          type: "response",
          tool: null,
          ok: null,
          payload: { text: cap(text) },
        });
      }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (events.length >= MAX_EVENTS_PER_TRANSCRIPT) break;
          if (c.type === "tool_use" && typeof c.name === "string") {
            events.push({
              ts,
              episode_id: episodeId,
              type: "tool_call",
              tool: c.name,
              ok: null,
              payload: { input: cap(JSON.stringify(c.input ?? {})) },
            });
          }
        }
      }
    }
  }

  const doc: EpisodeDoc = {
    user_id: ctx.user_id,
    episode_id: episodeId,
    harness: "claude-code",
    agent: { name: "claude-code", model },
    project,
    repo: { remote: null, branch: first?.gitBranch ?? null, cwd: first?.cwd ?? null },
    started_at: timestamps[0] ?? now(),
    ended_at: timestamps[timestamps.length - 1] ?? null,
    status: "ended",
    title,
    summary,
    outcome: { success: null, artifacts: [], commits: [] },
    handoff: null,
    tags: ["imported", `source:${file}`],
  };
  await episodes.insertOne(doc);
  if (events.length > 0) await db.collection<EventDoc>("events").insertMany(events);

  await db.collection("audit").insertOne({
    ts: now(),
    actor: { harness: ctx.harness, agent: ctx.agent, remote: ctx.remote },
    op: "import_claude_transcript",
    subject_id: episodeId,
    diff_summary: `${file}: +1 episode, +${events.length} events`,
  });
  return { file, episode_id: episodeId, action: "ADD", events: events.length };
}

/**
 * Import a Claude Code home dir (default ~/.claude): per-project auto-memory
 * markdown files as memories and session transcripts as episodes+events.
 */
export async function importClaudeDir(
  engine: Me0Engine,
  db: Db,
  ctx: OperationContext,
  dir: string = join(homedir(), ".claude"),
): Promise<ImportClaudeResult> {
  const result: ImportClaudeResult = { memories_added: 0, memories_skipped: 0, transcripts: [] };
  const projectsDir = join(dir, "projects");
  if (!existsSync(projectsDir)) return result;

  for (const project of readdirSync(projectsDir).sort()) {
    const projectDir = join(projectsDir, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const entry of readdirSync(projectDir).sort()) {
      const path = join(projectDir, entry);
      if (!statSync(path).isFile()) continue;
      if (entry.endsWith(".md")) {
        const r = await importContextFile(engine, db, ctx, path);
        result.memories_added += r.added;
        result.memories_skipped += r.skipped;
      } else if (entry.endsWith(".jsonl")) {
        result.transcripts.push(await importClaudeTranscript(engine, db, ctx, path, project));
      }
    }
  }
  return result;
}
