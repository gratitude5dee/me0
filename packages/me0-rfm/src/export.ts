import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db, Document } from "mongodb";

export interface ExportOptions {
  /** structure-only export: IDs + timestamps + categorical fields, no free text */
  redact?: boolean;
}

export interface TableSpec {
  name: string;
  collection: string;
  filter: (userId: string) => Document;
  /** map a Mongo doc to a flat RFM-friendly row; return null to skip */
  row: (doc: Document, redact: boolean) => Record<string, unknown> | null;
}

function txt(v: unknown, redact: boolean): string | null {
  if (redact) return null;
  return typeof v === "string" ? v : null;
}

/**
 * Flat tables materialized for the KumoRFM LocalGraph bridge: each carries a
 * primary key + time column; foreign keys mirror the graph edges. Written as
 * JSONL (one row per line) — convertible to Parquet by any downstream loader.
 */
export const TABLES: TableSpec[] = [
  {
    name: "memories",
    collection: "memories",
    filter: (u) => ({ user_id: u, deleted_at: null }),
    row: (d, r) => ({
      memory_id: d.memory_id,
      user_id: d.user_id,
      kind: d.kind,
      tier: d.tier,
      visibility: d.visibility,
      confidence: d.confidence,
      notability: d.notability,
      access_count: d.access?.count ?? 0,
      last_retrieved_at: d.access?.last_retrieved_at ?? null,
      valid_from: d.valid_from,
      text: txt(d.text, r),
    }),
  },
  {
    name: "entities",
    collection: "entities",
    filter: (u) => ({ user_id: u }),
    row: (d, r) => ({
      entity_id: d.entity_id,
      user_id: d.user_id,
      type: d.type,
      status: d.status,
      salience: d.salience,
      created_at: d.created_at,
      slug: txt(d.slug, r),
    }),
  },
  {
    name: "edges",
    collection: "edges",
    filter: (u) => ({ user_id: u }),
    row: (d) => ({
      edge_id: d.edge_id,
      user_id: d.user_id,
      src: d.src,
      dst: d.dst,
      rel: d.rel,
      weight: d.weight,
      valid_from: d.valid_from,
    }),
  },
  {
    name: "sessions",
    collection: "episodes",
    filter: (u) => ({ user_id: u }),
    row: (d, r) => ({
      session_id: d.episode_id,
      user_id: d.user_id,
      harness: d.harness,
      status: d.status,
      started_at: d.started_at,
      ended_at: d.ended_at,
      title: txt(d.title, r),
    }),
  },
  {
    name: "outcomes",
    collection: "episodes",
    filter: (u) => ({ user_id: u, "outcome.success": { $ne: null } }),
    row: (d) => ({
      session_id: d.episode_id,
      user_id: d.user_id,
      success: d.outcome?.success ?? null,
      ended_at: d.ended_at,
    }),
  },
  {
    name: "retrievals",
    collection: "retrievals",
    filter: (u) => ({ user_id: u }),
    row: (d) => ({
      user_id: d.user_id,
      session_id: d.episode_id,
      memory_id: d.memory_id,
      surface: d.surface,
      rank: d.rank,
      score: d.score,
      used: d.used,
      ts: d.ts,
    }),
  },
];

export interface ExportReport {
  tables: Array<{ name: string; rows: number; path: string }>;
}

/** tool_calls is derived from events but events are not user-keyed; joined via the user's episodes. */
async function exportToolCalls(
  db: Db,
  userId: string,
  outDir: string,
  redact: boolean,
): Promise<{ name: string; rows: number; path: string }> {
  const episodeIds = await db
    .collection("episodes")
    .find({ user_id: userId })
    .project<{ episode_id: string }>({ episode_id: 1, _id: 0 })
    .map((e) => e.episode_id)
    .toArray();
  const events = await db
    .collection("events")
    .find({ episode_id: { $in: episodeIds }, type: "tool_call" })
    .toArray();
  const path = join(outDir, "tool_calls.jsonl");
  const lines = events.map((d) =>
    JSON.stringify({
      session_id: d.episode_id,
      tool_name: redact ? null : (d.tool ?? null),
      ok: d.ok,
      ts: d.ts,
    }),
  );
  writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return { name: "tool_calls", rows: lines.length, path };
}

export async function exportTables(
  db: Db,
  userId: string,
  outDir: string,
  opts: ExportOptions = {},
): Promise<ExportReport> {
  const redact = opts.redact ?? true;
  mkdirSync(outDir, { recursive: true });
  const tables: ExportReport["tables"] = [];
  for (const spec of TABLES) {
    const docs = await db.collection(spec.collection).find(spec.filter(userId)).toArray();
    const rows = docs
      .map((d) => spec.row(d, redact))
      .filter((r): r is Record<string, unknown> => r !== null);
    const path = join(outDir, `${spec.name}.jsonl`);
    const lines = rows.map((r) => JSON.stringify(r));
    writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    tables.push({ name: spec.name, rows: rows.length, path });
  }
  tables.push(await exportToolCalls(db, userId, outDir, redact));
  return { tables };
}
