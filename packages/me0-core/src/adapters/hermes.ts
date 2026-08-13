import type { Me0Engine } from "../engine.js";
import type { OperationContext } from "../types.js";

export const HERMES_PACK_SCOPE = "harness:hermes";

export interface HermesPack {
  content: string;
  scope: string;
  _meta: { budget_used: number; dropped_count: number; budget_tokens: number };
}

/**
 * Build the context pack served to Hermes's memory-provider slot.
 * Always scoped `harness:hermes` and stamped with hermes provenance so
 * retrieval telemetry attributes correctly.
 */
export async function buildHermesPack(
  engine: Me0Engine,
  ctx: OperationContext,
  opts: { resume?: string; budget_tokens?: number } = {},
): Promise<HermesPack> {
  const hermesCtx: OperationContext = { ...ctx, harness: "hermes" };
  const pack = await engine.contextPack(hermesCtx, {
    scope: HERMES_PACK_SCOPE,
    resume: opts.resume,
    budget_tokens: opts.budget_tokens,
  });
  return { content: pack.content, scope: pack.scope, _meta: pack._meta };
}

/**
 * Frozen-snapshot pack provider for Hermes.
 *
 * Hermes assembles its system prompt once per session and relies on a stable
 * prefix for prompt caching. This provider computes the pack exactly once per
 * session id and serves the identical bytes on every subsequent call — new
 * memories written mid-session do NOT mutate the snapshot. A session switch
 * (new session id, or an explicit reset) recomputes.
 *
 * Fail-open: if the pack cannot be computed (storage down), `pack()` returns
 * an empty string rather than throwing. Failures are not cached, so a later
 * call in the same session can recover once storage is back.
 */
export class HermesSnapshotProvider {
  private snapshots = new Map<string, string>();

  constructor(
    private engine: Me0Engine,
    private ctx: OperationContext,
  ) {}

  async pack(sessionId: string, opts: { resume?: string; budget_tokens?: number } = {}) {
    const cached = this.snapshots.get(sessionId);
    if (cached !== undefined) return cached;
    let content = "";
    let ok = true;
    try {
      content = (await buildHermesPack(this.engine, this.ctx, opts)).content;
    } catch {
      content = "";
      ok = false;
    }
    if (ok) this.snapshots.set(sessionId, content);
    return content;
  }

  /** Drop the snapshot for a session (or all sessions) so the next pack() recomputes. */
  reset(sessionId?: string) {
    if (sessionId === undefined) this.snapshots.clear();
    else this.snapshots.delete(sessionId);
  }
}
