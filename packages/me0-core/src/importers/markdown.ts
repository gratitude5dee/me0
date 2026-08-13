import type { MemoryKind } from "../types.js";

export interface MarkdownItem {
  text: string;
  kind: MemoryKind;
  heading_path: string[];
}

const PREFERENCE_RE = /\b(prefer|prefers|preferred|always|never)\b/i;
const DECISION_RE = /\b(decided|decision|we chose|chose to|agreed to)\b/i;
const IMPERATIVE_RE =
  /^(run|use|install|set|add|create|update|check|ensure|configure|build|test|deploy|start|stop|open|write|call|invoke|make|keep|follow|avoid)\b/i;

export function classifyKind(text: string): MemoryKind {
  if (PREFERENCE_RE.test(text)) return "preference";
  if (DECISION_RE.test(text)) return "decision";
  if (IMPERATIVE_RE.test(text)) return "procedure";
  return "fact";
}

export function normalizeText(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic markdown → items. Headings become topic hints (heading_path);
 * bullets and paragraphs become individual items with kind heuristics.
 * Code fences are skipped.
 */
export function parseMarkdown(source: string): MarkdownItem[] {
  const items: MarkdownItem[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let inFence = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = normalizeText(paragraph.join(" "));
    paragraph = [];
    if (text.length < 3) return;
    items.push({ text, kind: classifyKind(text), heading_path: headingStack.map((h) => h.title) });
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading?.[1] && heading[2] !== undefined) {
      flushParagraph();
      const level = heading[1].length;
      while (headingStack.length > 0) {
        const top = headingStack[headingStack.length - 1];
        if (top && top.level >= level) headingStack.pop();
        else break;
      }
      const title = heading[2].trim();
      if (title) headingStack.push({ level, title });
      continue;
    }

    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (bullet?.[1] !== undefined) {
      flushParagraph();
      const text = normalizeText(bullet[1]);
      if (text.length >= 3) {
        items.push({
          text,
          kind: classifyKind(text),
          heading_path: headingStack.map((h) => h.title),
        });
      }
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    if (/^(---|===|\||>)/.test(line.trim())) continue;
    paragraph.push(line.trim());
  }
  flushParagraph();
  return items;
}
