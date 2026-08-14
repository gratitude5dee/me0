import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Db } from "mongodb";
import { maybeEmbedText } from "../embeddings.js";
import type { Me0Engine } from "../engine.js";
import type { MemoryDoc, MemoryKind, OperationContext } from "../types.js";
import { parseMarkdown, slugify } from "./markdown.js";

export const CONTEXT_FILE_NAMES = ["CLAUDE.md", "AGENTS.md", "MEMORY.md", "USER.md", "SOUL.md"];

export const IMPORT_CONFIDENCE = 0.6;

export interface ImportedMemoryDoc extends MemoryDoc {
  source: { file: string; heading_path: string[] };
}

export interface ImportFileResult {
  file: string;
  added: number;
  skipped: number;
  kinds: Record<string, number>;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Discover context files: explicit paths, per-repo walk-up from cwd, and the
 * global harness homes (~/.claude, ~/.codex, ~).
 */
export function discoverContextFiles(cwd: string, home: string = homedir()): string[] {
  const found = new Set<string>();
  const addIfFile = (p: string) => {
    if (existsSync(p) && statSync(p).isFile()) found.add(resolve(p));
  };

  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONTEXT_FILE_NAMES) addIfFile(join(dir, name));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const name of CONTEXT_FILE_NAMES) {
    addIfFile(join(home, name));
    addIfFile(join(home, ".claude", name));
    addIfFile(join(home, ".codex", name));
  }
  return [...found];
}

const STANDING_KINDS: MemoryKind[] = ["preference", "decision"];

/**
 * Deterministic markdown-context import: each bullet/paragraph becomes a memory
 * with kind heuristics, heading-derived concept entities, provenance
 * `method: "deterministic"` at moderate confidence, and the source file
 * recorded. Idempotent: dedupes on normalized text (NOOP on duplicate).
 */
export async function importContextFile(
  engine: Me0Engine,
  db: Db,
  ctx: OperationContext,
  file: string,
): Promise<ImportFileResult> {
  if (ctx.remote) throw new Error("import-context is local-only");
  await engine.ensureUser(ctx);
  const items = parseMarkdown(readFileSync(file, "utf-8"));
  const memories = db.collection<ImportedMemoryDoc>("memories");
  const entityCache = new Map<string, string>();
  const result: ImportFileResult = { file, added: 0, skipped: 0, kinds: {} };

  for (const item of items) {
    const existing = await memories.findOne({
      user_id: ctx.user_id,
      text: item.text,
      deleted_at: null,
      valid_until: null,
    });
    if (existing) {
      result.skipped++;
      continue;
    }

    const entity_refs: string[] = [];
    const topic = item.heading_path[item.heading_path.length - 1];
    if (topic) {
      const slug = slugify(topic);
      if (slug) {
        let entityId = entityCache.get(slug);
        if (!entityId) {
          const ent = await engine.upsertEntity(ctx, {
            slug,
            type: "concept",
            names: [topic],
            status: "auto",
          });
          entityId = ent.entity_id;
          entityCache.set(slug, entityId);
        }
        entity_refs.push(entityId);
      }
    }

    const doc: ImportedMemoryDoc = {
      user_id: ctx.user_id,
      memory_id: `mem_${randomUUID().slice(0, 12)}`,
      text: item.text,
      kind: item.kind,
      tier: STANDING_KINDS.includes(item.kind) ? "standing" : "recall",
      entity_refs,
      visibility: "private",
      valid_from: now(),
      valid_until: null,
      superseded_by: null,
      confidence: IMPORT_CONFIDENCE,
      notability: 0.5,
      access: { count: 0, last_retrieved_at: null },
      deleted_at: null,
      prov: {
        episode_id: ctx.episode_id,
        harness: ctx.harness,
        agent: ctx.agent,
        method: "deterministic",
        confidence: IMPORT_CONFIDENCE,
        extracted_at: now(),
      },
      source: { file, heading_path: item.heading_path },
    };
    const emb = await maybeEmbedText(doc.text);
    if (emb) {
      doc.embedding = emb.embedding;
      doc.embedding_model = emb.embedding_model;
    }
    await memories.insertOne(doc);
    result.added++;
    result.kinds[item.kind] = (result.kinds[item.kind] ?? 0) + 1;
  }

  await db.collection("audit").insertOne({
    ts: now(),
    actor: { harness: ctx.harness, agent: ctx.agent, remote: ctx.remote },
    op: "import_context",
    subject_id: null,
    diff_summary: `${file}: +${result.added} memories (${result.skipped} duplicates skipped)`,
  });
  return result;
}

export async function importContextFiles(
  engine: Me0Engine,
  db: Db,
  ctx: OperationContext,
  paths: string[],
): Promise<ImportFileResult[]> {
  const results: ImportFileResult[] = [];
  for (const p of paths) {
    results.push(await importContextFile(engine, db, ctx, p));
  }
  return results;
}
