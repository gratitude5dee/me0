import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { PREDICTION_TTL_MS } from "me0-core";
import type { MemoryDoc, OperationContext } from "me0-core";
import type { Db } from "mongodb";
import type { PredictionBackend, PredictionReport } from "./backend.js";
import { exportTables } from "./export.js";
import type { PredictionDoc } from "./heuristics.js";
import { PQL_QUERIES } from "./pql.js";

/** Max entity indices per `predict` call (kumo-rfm-mcp limit). */
const INDEX_CHUNK = 1000;

export interface KumoBackendOptions {
  /** KumoRFM API key; defaults to ME0_KUMO_API_KEY, then KUMO_API_KEY. */
  apiKey?: string;
  /**
   * Command used to spawn the official `kumo-rfm-mcp` stdio server; defaults
   * to ME0_KUMO_MCP_COMMAND (whitespace-split), then `python -m
   * kumo_rfm_mcp.server`.
   */
  command?: string;
  args?: string[];
  /** Extra environment variables passed to the spawned MCP server. */
  env?: Record<string, string>;
  /** Directory for the exported flat tables; defaults to a fresh temp dir. */
  workDir?: string;
  /** KumoRFM run mode: trades runtime for model quality. */
  runMode?: "fast" | "normal" | "best";
}

interface GraphTableSpec {
  name: string;
  primary_key: string | null;
  time_column: string | null;
}

const GRAPH_TABLES: GraphTableSpec[] = [
  { name: "users", primary_key: "user_id", time_column: "created_at" },
  { name: "memories", primary_key: "memory_id", time_column: "valid_from" },
  { name: "entities", primary_key: "entity_id", time_column: "created_at" },
  { name: "edges", primary_key: "edge_id", time_column: "valid_from" },
  { name: "sessions", primary_key: "session_id", time_column: "started_at" },
  { name: "outcomes", primary_key: null, time_column: "ended_at" },
  { name: "retrievals", primary_key: null, time_column: "ts" },
  { name: "tool_calls", primary_key: null, time_column: "ts" },
];

const GRAPH_LINKS: Array<{ source_table: string; foreign_key: string; destination_table: string }> =
  [
    { source_table: "memories", foreign_key: "user_id", destination_table: "users" },
    { source_table: "entities", foreign_key: "user_id", destination_table: "users" },
    { source_table: "edges", foreign_key: "src", destination_table: "entities" },
    { source_table: "edges", foreign_key: "dst", destination_table: "entities" },
    { source_table: "sessions", foreign_key: "user_id", destination_table: "users" },
    { source_table: "outcomes", foreign_key: "session_id", destination_table: "sessions" },
    { source_table: "retrievals", foreign_key: "user_id", destination_table: "users" },
    { source_table: "retrievals", foreign_key: "session_id", destination_table: "sessions" },
    { source_table: "retrievals", foreign_key: "memory_id", destination_table: "memories" },
    { source_table: "tool_calls", foreign_key: "session_id", destination_table: "sessions" },
  ];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Convert an exported JSONL flat table to CSV (kumo-rfm-mcp reads CSV/Parquet). */
export function jsonlToCsv(jsonlPath: string, csvPath: string): number {
  const raw = readFileSync(jsonlPath, "utf-8").trim();
  if (!raw) return 0;
  const rows = raw.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  writeFileSync(csvPath, `${lines.join("\n")}\n`);
  return rows.length;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface PredictRow {
  ENTITY?: unknown;
  CLASS?: unknown;
  SCORE?: unknown;
  True_PROB?: unknown;
  [key: string]: unknown;
}

function rowsFrom(result: Record<string, unknown>): PredictRow[] {
  if (result.isError) {
    throw new Error(`kumo predict tool error: ${textFrom(result.content)}`);
  }
  const structured = result.structuredContent as { predictions?: PredictRow[] } | undefined;
  if (structured?.predictions) return structured.predictions;
  const text = textFrom(result.content);
  try {
    const parsed = JSON.parse(text) as { predictions?: PredictRow[] };
    return parsed.predictions ?? [];
  } catch {
    throw new Error(`kumo predict returned an unparseable payload: ${text.slice(0, 200)}`);
  }
}

function textFrom(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * KumoRFM prediction backend (goal.md §12): bridges to the official
 * `kumo-rfm-mcp` stdio server via the MCP client SDK. Exports the flat tables
 * as CSV, builds/materializes the LocalGraph, runs the PQL queries from
 * pql.ts, and writes results into the same `predictions` collection shape the
 * heuristic backend uses — retrieval ranking consumes them unchanged.
 */
export class KumoBackend implements PredictionBackend {
  readonly name = "kumo" as const;
  private readonly opts: KumoBackendOptions;

  constructor(opts: KumoBackendOptions = {}) {
    this.opts = opts;
  }

  async predict(db: Db, ctx: OperationContext): Promise<PredictionReport> {
    const apiKey = this.opts.apiKey ?? process.env.ME0_KUMO_API_KEY ?? process.env.KUMO_API_KEY;
    if (!apiKey) {
      throw new Error(
        "KumoRFM API key missing: set ME0_KUMO_API_KEY (create a free key at https://kumorfm.ai)",
      );
    }
    const envCommand = process.env.ME0_KUMO_MCP_COMMAND?.trim();
    const envParts = envCommand ? envCommand.split(/\s+/) : null;
    const command = this.opts.command ?? envParts?.[0] ?? "python";
    const args = this.opts.args ?? (envParts ? envParts.slice(1) : ["-m", "kumo_rfm_mcp.server"]);

    const workDir = this.opts.workDir ?? mkdtempSync(join(tmpdir(), "me0-kumo-"));
    const selfCreatedWorkDir = this.opts.workDir === undefined;
    try {
      return await this.run(db, ctx, { apiKey, command, args, workDir });
    } finally {
      if (selfCreatedWorkDir) rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async run(
    db: Db,
    ctx: OperationContext,
    cfg: { apiKey: string; command: string; args: string[]; workDir: string },
  ): Promise<PredictionReport> {
    const { apiKey, command, args, workDir } = cfg;
    // structure-only export: no free text ever leaves the store for the cloud model
    const exported = await exportTables(db, ctx.user_id, workDir, { redact: true });
    const csvDir = join(workDir, "rfm");
    const nonEmpty = new Set<string>();
    for (const t of exported.tables) {
      const csvPath = join(csvDir, `${t.name}.csv`);
      if (existsSync(t.path) && jsonlToCsv(t.path, csvPath) > 0) nonEmpty.add(t.name);
    }
    if (!nonEmpty.has("memories")) {
      throw new Error("no memories to score: nothing to send to KumoRFM");
    }

    const client = new Client({ name: "me0-rfm", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command,
      args,
      // minimal environment: default safe vars + the Kumo key only, so the
      // spawned server never sees unrelated secrets from the caller's env
      env: { ...getDefaultEnvironment(), ...this.opts.env, KUMO_API_KEY: apiKey },
      stderr: "ignore",
    });
    await client.connect(transport);
    try {
      const tablesToAdd = GRAPH_TABLES.filter((t) => nonEmpty.has(t.name)).map((t) => ({
        path: join(csvDir, `${t.name}.csv`),
        name: t.name,
        primary_key: t.primary_key,
        time_column: t.time_column,
        end_time_column: null,
      }));
      const linksToAdd = GRAPH_LINKS.filter(
        (l) => nonEmpty.has(l.source_table) && nonEmpty.has(l.destination_table),
      );
      const updated = await client.callTool({
        name: "update_graph_metadata",
        arguments: { update: { tables_to_add: tablesToAdd, links_to_add: linksToAdd } },
      });
      if (updated.isError) {
        throw new Error(`kumo graph setup failed: ${textFrom(updated.content)}`);
      }
      const materialized = await client.callTool({ name: "materialize_graph", arguments: {} });
      if (materialized.isError) {
        throw new Error(`kumo graph materialization failed: ${textFrom(materialized.content)}`);
      }

      const memoryIds = await db
        .collection<MemoryDoc>("memories")
        .find({ user_id: ctx.user_id, deleted_at: null, valid_until: null })
        .project<{ memory_id: string }>({ memory_id: 1 })
        .map((m) => m.memory_id)
        .toArray();
      const computedAt = new Date().toISOString();
      // stale predictions are reaped natively by the ttl_expire_at TTL index
      const expireAt = new Date(Date.now() + PREDICTION_TTL_MS);
      const runMode = this.opts.runMode ?? "fast";
      const preds: PredictionDoc[] = [];

      // binary tasks FOR EACH memories.memory_id → True_PROB per memory
      const binaryTasks: Array<{ task: "forget" | "retrieval_utility"; horizon: string }> = [
        { task: "forget", horizon: "90d" },
        { task: "retrieval_utility", horizon: "7d" },
      ];
      for (const { task, horizon } of binaryTasks) {
        for (const ids of chunk(memoryIds, INDEX_CHUNK)) {
          const result = await client.callTool({
            name: "predict",
            arguments: { query: PQL_QUERIES[task], indices: ids, run_mode: runMode },
          });
          for (const row of rowsFrom(result)) {
            const score = Number(row.True_PROB);
            if (typeof row.ENTITY !== "string" || !Number.isFinite(score)) continue;
            preds.push({
              subject_type: "memory",
              subject_id: row.ENTITY,
              task,
              score,
              horizon,
              model: "kumo-rfm-2",
              computed_at: computedAt,
              expire_at: expireAt,
            });
          }
        }
      }

      // prefetch: LIST_DISTINCT FOR EACH users.user_id → (CLASS=memory, SCORE)
      const prefetch = await client.callTool({
        name: "predict",
        arguments: { query: PQL_QUERIES.prefetch, indices: [ctx.user_id], run_mode: runMode },
      });
      for (const row of rowsFrom(prefetch)) {
        const score = Number(row.SCORE);
        if (typeof row.CLASS !== "string" || !Number.isFinite(score)) continue;
        preds.push({
          subject_type: "memory",
          subject_id: row.CLASS,
          task: "prefetch",
          score,
          horizon: "24h",
          model: "kumo-rfm-2",
          computed_at: computedAt,
          expire_at: expireAt,
        });
      }

      // replace ALL prior predictions (any model) for the user's memories so
      // exactly one score exists per (memory, task) and retrieval stays
      // deterministic; latest backend run wins
      const allIds = await db
        .collection<MemoryDoc>("memories")
        .find({ user_id: ctx.user_id })
        .project<{ memory_id: string }>({ memory_id: 1 })
        .map((m) => m.memory_id)
        .toArray();
      const col = db.collection("predictions");
      if (allIds.length > 0) {
        await col.deleteMany({
          subject_type: "memory",
          subject_id: { $in: allIds },
        });
      }
      if (preds.length > 0) await col.insertMany(preds);

      return {
        backend: "kumo",
        counts: {
          retrieval_utility: preds.filter((p) => p.task === "retrieval_utility").length,
          prefetch: preds.filter((p) => p.task === "prefetch").length,
          forget: preds.filter((p) => p.task === "forget").length,
        },
      };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
