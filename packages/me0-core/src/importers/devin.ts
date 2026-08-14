import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "mongodb";
import type { Me0Engine } from "../engine.js";
import type { EpisodeDoc, EventDoc, OperationContext } from "../types.js";
import { MAX_EVENTS_PER_TRANSCRIPT, MAX_PAYLOAD_CHARS } from "./claude.js";

export interface ImportDevinResult {
  file: string;
  session_id: string;
  episode_id: string;
  action: "ADD" | "NOOP";
  events: number;
}

function now(): string {
  return new Date().toISOString();
}

function cap(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS ? `${text.slice(0, MAX_PAYLOAD_CHARS)}…` : text;
}

/** One event as exported from the Devin session-events API. */
interface DevinEvent {
  event_id?: string;
  type?: string;
  category?: string;
  created_at?: string;
  contents?: {
    type?: string;
    message?: string;
    command?: string;
    exit_code?: string | number;
    output_trunc?: string;
    tool_name?: string;
    file_updates?: Array<{ file_path?: string; action_type?: string }>;
  };
}

/** A Devin session export: session metadata plus its event stream. */
interface DevinExport {
  session_id?: string;
  title?: string;
  events?: DevinEvent[];
}

function mapEvent(episodeId: string, ev: DevinEvent): EventDoc | null {
  const ts = ev.created_at ?? now();
  const c = ev.contents ?? {};
  const t = c.type ?? ev.type ?? "";
  switch (t) {
    case "initial_user_message":
    case "user_message":
      return typeof c.message === "string" && c.message.trim()
        ? {
            ts,
            episode_id: episodeId,
            type: "prompt",
            tool: null,
            ok: null,
            payload: { text: cap(c.message) },
          }
        : null;
    case "devin_message":
      return typeof c.message === "string" && c.message.trim()
        ? {
            ts,
            episode_id: episodeId,
            type: "response",
            tool: null,
            ok: null,
            payload: { text: cap(c.message) },
          }
        : null;
    case "shell_process_started":
      return typeof c.command === "string"
        ? {
            ts,
            episode_id: episodeId,
            type: "command",
            tool: "shell",
            ok: null,
            payload: { command: cap(c.command) },
          }
        : null;
    case "shell_process_completed":
      return {
        ts,
        episode_id: episodeId,
        type: "command",
        tool: "shell",
        ok: String(c.exit_code ?? "") === "0",
        payload: { output: cap(c.output_trunc ?? "") },
      };
    case "multi_edit_result": {
      const writes = (c.file_updates ?? []).filter(
        (u) => u.action_type && u.action_type !== "open",
      );
      return writes.length > 0
        ? {
            ts,
            episode_id: episodeId,
            type: "file_edit",
            tool: "editor",
            ok: null,
            payload: { files: writes.map((u) => u.file_path ?? "").filter(Boolean) },
          }
        : null;
    }
    default:
      if (ev.category === "mcp" || ev.category === "git") {
        return {
          ts,
          episode_id: episodeId,
          type: "tool_call",
          tool: t || ev.category,
          ok: null,
          payload: {},
        };
      }
      return null;
  }
}

/**
 * Deterministic import of a Devin session export (JSON: { session_id, title,
 * events: [...] } as returned by the Devin session-events API) as an episode
 * plus capped events. Idempotent: the episode id is derived from the Devin
 * session id, so re-import is a NOOP.
 */
export async function importDevinSession(
  engine: Me0Engine,
  db: Db,
  ctx: OperationContext,
  file: string,
): Promise<ImportDevinResult> {
  if (ctx.remote) throw new Error("import-devin is local-only");
  await engine.ensureUser(ctx);

  let parsed: DevinExport;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as DevinExport;
  } catch (err) {
    throw new Error(`not a valid Devin session export: ${file} (${(err as Error).message})`);
  }
  const sessionId = parsed.session_id ?? "";
  if (!sessionId || !Array.isArray(parsed.events)) {
    throw new Error(`not a valid Devin session export: ${file} (need session_id + events[])`);
  }

  const episodeId = `ep_devin_${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
  const episodes = db.collection<EpisodeDoc>("episodes");
  const existing = await episodes.findOne({ user_id: ctx.user_id, episode_id: episodeId });
  if (existing) {
    return { file, session_id: sessionId, episode_id: episodeId, action: "NOOP", events: 0 };
  }

  const events: EventDoc[] = [];
  for (const ev of parsed.events) {
    if (events.length >= MAX_EVENTS_PER_TRANSCRIPT) break;
    const mapped = mapEvent(episodeId, ev);
    if (mapped) events.push(mapped);
  }

  const timestamps = parsed.events
    .map((e) => e.created_at)
    .filter((t): t is string => Boolean(t))
    .sort();
  const firstPrompt = events.find((e) => e.type === "prompt");
  const title =
    parsed.title ?? (firstPrompt ? String(firstPrompt.payload.text).slice(0, 120) : null);

  const doc: EpisodeDoc = {
    user_id: ctx.user_id,
    episode_id: episodeId,
    harness: "devin",
    agent: { name: "devin", model: null },
    project: null,
    repo: { remote: null, branch: null, cwd: null },
    started_at: timestamps[0] ?? now(),
    ended_at: timestamps[timestamps.length - 1] ?? null,
    status: "ended",
    title,
    summary: null,
    outcome: { success: null, artifacts: [], commits: [] },
    handoff: null,
    tags: ["imported", `source:${sessionId}`],
  };
  await episodes.insertOne(doc);
  if (events.length > 0) await db.collection<EventDoc>("events").insertMany(events);

  await db.collection("audit").insertOne({
    ts: now(),
    actor: { harness: ctx.harness, agent: ctx.agent, remote: ctx.remote },
    op: "import_devin_session",
    subject_id: episodeId,
    diff_summary: `${sessionId}: +1 episode, +${events.length} events`,
  });
  return {
    file,
    session_id: sessionId,
    episode_id: episodeId,
    action: "ADD",
    events: events.length,
  };
}
