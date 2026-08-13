import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Me0Engine, MemoryKind, MemoryTier, OperationContext, Store } from "me0-core";

export const DEFAULT_OPENCLAW_WORKSPACE = join(homedir(), ".openclaw", "workspace");

const DAILY_LOG = /^(\d{4}-\d{2}-\d{2})(-[\w-]+)?\.md$/;

export interface OpenClawImportSummary {
  memories_added: number;
  memories_skipped: number;
  episodes_added: number;
  episodes_skipped: number;
  files: string[];
}

/**
 * Extract memory-sized items from an OpenClaw markdown file: list items and
 * plain paragraphs, skipping headings, code fences, and blockquotes.
 * Deterministic — no LLM.
 */
export function parseMarkdownItems(content: string): string[] {
  const items: string[] = [];
  let inFence = false;
  let paragraph: string[] = [];
  const flush = () => {
    const textContent = paragraph.join(" ").trim();
    if (textContent.length >= 8) items.push(textContent);
    paragraph = [];
  };
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (line === "" || line.startsWith("#") || line.startsWith(">")) {
      flush();
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/) ?? line.match(/^\d+\.\s+(.*)$/);
    if (bullet?.[1]) {
      flush();
      const item = bullet[1].trim();
      if (item.length >= 8) items.push(item);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return items;
}

interface FileSpec {
  kind: MemoryKind;
  tier: MemoryTier;
}

const MEMORY_FILES: Record<string, FileSpec> = {
  "MEMORY.md": { kind: "fact", tier: "standing" },
  "USER.md": { kind: "preference", tier: "standing" },
  "SOUL.md": { kind: "belief", tier: "standing" },
};

/**
 * Deterministic, idempotent backfill of an OpenClaw workspace:
 * - `MEMORY.md` / `USER.md` / `SOUL.md` items become typed memories
 *   (dedupe on exact text makes re-runs NOOPs);
 * - `memory/YYYY-MM-DD.md` daily logs become ended episodes tagged
 *   `openclaw-import:<file>` (the tag makes re-runs skip).
 */
export async function importOpenClawWorkspace(
  engine: Me0Engine,
  db: Store["db"],
  ctx: OperationContext,
  dir: string,
): Promise<OpenClawImportSummary> {
  const summary: OpenClawImportSummary = {
    memories_added: 0,
    memories_skipped: 0,
    episodes_added: 0,
    episodes_skipped: 0,
    files: [],
  };

  for (const [file, spec] of Object.entries(MEMORY_FILES)) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    summary.files.push(file);
    for (const item of parseMarkdownItems(readFileSync(path, "utf-8"))) {
      const r = (await engine.remember(ctx, {
        text: item,
        kind: spec.kind,
        tier: spec.tier,
        confidence: 0.9,
      })) as { action: string };
      if (r.action === "ADD") summary.memories_added++;
      else summary.memories_skipped++;
    }
  }

  const memoryDir = join(dir, "memory");
  if (existsSync(memoryDir)) {
    const episodes = db.collection("episodes");
    const logs = readdirSync(memoryDir)
      .filter((f) => DAILY_LOG.test(f))
      .sort();
    for (const file of logs) {
      const tag = `openclaw-import:${file}`;
      if (await episodes.findOne({ user_id: ctx.user_id, tags: tag })) {
        summary.episodes_skipped++;
        continue;
      }
      summary.files.push(join("memory", file));
      const content = readFileSync(join(memoryDir, file), "utf-8");
      const date = basename(file).match(DAILY_LOG)?.[1] ?? "1970-01-01";
      const items = parseMarkdownItems(content);
      const started = (await engine.episodeStart(ctx, {
        harness: "openclaw",
        agent_name: ctx.agent,
        title: `OpenClaw daily log ${date}`,
      })) as { episode_id: string };
      for (const item of items) {
        await engine.episodeLog(ctx, {
          episode_id: started.episode_id,
          type: "response",
          payload: { note: item.slice(0, 2000) },
        });
      }
      await engine.episodeEnd(ctx, {
        episode_id: started.episode_id,
        summary: items.slice(0, 5).join(" · ").slice(0, 1000) || `daily log ${date}`,
      });
      await episodes.updateOne(
        { user_id: ctx.user_id, episode_id: started.episode_id },
        {
          $set: {
            started_at: `${date}T00:00:00.000Z`,
            tags: ["openclaw-import", tag],
          },
        },
      );
      summary.episodes_added++;
    }
  }

  return summary;
}
