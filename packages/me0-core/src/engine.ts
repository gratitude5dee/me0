import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { type DreamReport, dream } from "./dream.js";
import { type PushResult, push } from "./push.js";
import { hybridRecall } from "./retrieval.js";
import type {
  CreateSafety,
  EntityDoc,
  EpisodeDoc,
  EventDoc,
  Harness,
  MemoryDoc,
  MemoryKind,
  MemoryTier,
  OperationContext,
  Provenance,
  RecallResult,
  UserDoc,
  Visibility,
} from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

const NO_MEMORY = "no recorded memory";

function now(): string {
  return new Date().toISOString();
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

export interface RecallResponse {
  protocol_version: number;
  results: RecallResult[];
  abstained: boolean;
  message?: string;
  _meta: { budget_used: number; dropped_count: number };
}

export class Me0Engine {
  constructor(private db: Db) {}

  private prov(ctx: OperationContext, method: Provenance["method"], confidence = 1): Provenance {
    return {
      episode_id: ctx.episode_id,
      harness: ctx.harness,
      agent: ctx.agent,
      method,
      confidence,
      extracted_at: now(),
    };
  }

  private async audit(ctx: OperationContext, op: string, subject_id: string | null, diff: string) {
    await this.db.collection("audit").insertOne({
      ts: now(),
      actor: { harness: ctx.harness, agent: ctx.agent, remote: ctx.remote },
      op,
      subject_id,
      diff_summary: diff,
    });
  }

  private visibilityFilter(ctx: OperationContext): Record<string, unknown> {
    return ctx.remote ? { visibility: "world" } : {};
  }

  async ensureUser(ctx: OperationContext, names: string[] = []): Promise<UserDoc> {
    const users = this.db.collection<UserDoc>("users");
    const existing = await users.findOne({ user_id: ctx.user_id });
    if (existing) return existing;
    const doc: UserDoc = {
      user_id: ctx.user_id,
      names,
      handles: {},
      identity_card: "",
      settings: {
        default_visibility: "private",
        pack_budget_tokens: 700,
        push: { min_confidence: 0.7, max_per_turn: 3 },
      },
      consent: [],
      created_at: now(),
    };
    await users.insertOne(doc);
    return doc;
  }

  // ---- verbs ----

  async recall(
    ctx: OperationContext,
    args: { query: string; kind?: MemoryKind; tier?: MemoryTier; limit?: number },
  ): Promise<RecallResponse> {
    const memories = this.db.collection<MemoryDoc>("memories");
    const { scored, poolSize } = await hybridRecall(this.db, ctx, args, this.visibilityFilter(ctx));

    if (scored.length === 0) {
      return {
        protocol_version: PROTOCOL_VERSION,
        results: [],
        abstained: true,
        message: NO_MEMORY,
        _meta: { budget_used: 0, dropped_count: 0 },
      };
    }

    const ts = now();
    await this.db.collection("retrievals").insertMany(
      scored.map((s, i) => ({
        ts,
        user_id: ctx.user_id,
        episode_id: ctx.episode_id,
        memory_id: s.doc.memory_id,
        surface: "recall",
        rank: i,
        score: s.score,
        used: null,
      })),
    );
    await memories.updateMany(
      { user_id: ctx.user_id, memory_id: { $in: scored.map((s) => s.doc.memory_id) } },
      { $inc: { "access.count": 1 }, $set: { "access.last_retrieved_at": ts } },
    );

    const results: RecallResult[] = scored.map((s) => ({
      memory_id: s.doc.memory_id,
      text: s.doc.text,
      kind: s.doc.kind,
      tier: s.doc.tier,
      score: Math.round(s.score * 1000) / 1000,
      evidence: s.evidence,
      valid_from: s.doc.valid_from,
      entity_refs: s.doc.entity_refs,
    }));
    return {
      protocol_version: PROTOCOL_VERSION,
      results,
      abstained: false,
      _meta: {
        budget_used: results.reduce((n, r) => n + estimateTokens(r.text), 0),
        dropped_count: Math.max(0, poolSize - results.length),
      },
    };
  }

  async remember(
    ctx: OperationContext,
    args: {
      text: string;
      kind: MemoryKind;
      tier?: MemoryTier;
      entity_refs?: string[];
      visibility?: Visibility;
      confidence?: number;
      notability?: number;
    },
  ) {
    if (ctx.remote) throw new Error("remember is not permitted for remote callers");
    await this.ensureUser(ctx);
    const memories = this.db.collection<MemoryDoc>("memories");

    const existing = await memories.findOne({
      user_id: ctx.user_id,
      text: args.text,
      deleted_at: null,
      valid_until: null,
    });
    let create_safety: CreateSafety = "unknown";
    if (existing) create_safety = "exists";

    if (create_safety === "exists" && existing) {
      return {
        protocol_version: PROTOCOL_VERSION,
        memory_id: existing.memory_id,
        action: "NOOP",
        create_safety,
      };
    }

    const doc: MemoryDoc = {
      user_id: ctx.user_id,
      memory_id: id("mem"),
      text: args.text,
      kind: args.kind,
      tier: args.tier ?? "recall",
      entity_refs: args.entity_refs ?? [],
      visibility: args.visibility ?? "private",
      valid_from: now(),
      valid_until: null,
      superseded_by: null,
      confidence: args.confidence ?? 1,
      notability: args.notability ?? 0.5,
      access: { count: 0, last_retrieved_at: null },
      deleted_at: null,
      prov: this.prov(ctx, ctx.agent === "user" ? "user" : "deterministic", args.confidence ?? 1),
    };
    await memories.insertOne(doc);
    await this.audit(ctx, "remember", doc.memory_id, `+${args.kind}: ${args.text.slice(0, 80)}`);
    return {
      protocol_version: PROTOCOL_VERSION,
      memory_id: doc.memory_id,
      action: "ADD",
      create_safety,
    };
  }

  async entity(ctx: OperationContext, args: { slug: string }) {
    const entities = this.db.collection<EntityDoc>("entities");
    const ent = await entities.findOne({
      user_id: ctx.user_id,
      $or: [{ slug: args.slug }, { names: args.slug }],
    });
    if (!ent) {
      return { protocol_version: PROTOCOL_VERSION, found: false, message: NO_MEMORY };
    }
    const edges = await this.db
      .collection("edges")
      .find({
        user_id: ctx.user_id,
        valid_until: null,
        $or: [{ src: ent.entity_id }, { dst: ent.entity_id }],
      })
      .limit(25)
      .toArray();
    const neighborIds = new Set<string>();
    for (const e of edges) {
      neighborIds.add(e.src === ent.entity_id ? (e.dst as string) : (e.src as string));
    }
    const neighbors = await entities
      .find({ user_id: ctx.user_id, entity_id: { $in: [...neighborIds] } })
      .project({ entity_id: 1, slug: 1, type: 1, card: 1, _id: 0 })
      .toArray();
    await entities.updateOne(
      { user_id: ctx.user_id, entity_id: ent.entity_id },
      { $set: { last_retrieved_at: now() } },
    );
    return {
      protocol_version: PROTOCOL_VERSION,
      found: true,
      entity: {
        entity_id: ent.entity_id,
        slug: ent.slug,
        type: ent.type,
        names: ent.names,
        card: ent.card,
        status: ent.status,
      },
      edges: edges.map((e) => ({ src: e.src, rel: e.rel, dst: e.dst, weight: e.weight })),
      neighbors,
    };
  }

  async upsertEntity(
    ctx: OperationContext,
    args: {
      slug: string;
      type: EntityDoc["type"];
      names?: string[];
      card?: string;
      status?: "verified" | "auto";
    },
  ): Promise<EntityDoc> {
    const entities = this.db.collection<EntityDoc>("entities");
    const existing = await entities.findOne({ user_id: ctx.user_id, slug: args.slug });
    if (existing) {
      await entities.updateOne(
        { user_id: ctx.user_id, slug: args.slug },
        {
          $set: {
            updated_at: now(),
            ...(args.card !== undefined ? { card: args.card } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
          },
          ...(args.names ? { $addToSet: { names: { $each: args.names } } } : {}),
        },
      );
      const updated = await entities.findOne({ user_id: ctx.user_id, slug: args.slug });
      if (!updated) throw new Error("entity update failed");
      return updated;
    }
    const doc: EntityDoc = {
      user_id: ctx.user_id,
      entity_id: id("ent"),
      slug: args.slug,
      type: args.type,
      names: args.names ?? [args.slug],
      card: args.card ?? "",
      attrs: {},
      status: args.status ?? "auto",
      salience: 0.5,
      last_retrieved_at: null,
      created_at: now(),
      updated_at: now(),
    };
    await entities.insertOne(doc);
    await this.audit(ctx, "entity.create", doc.entity_id, `+${doc.type}:${doc.slug}`);
    return doc;
  }

  async contextPack(
    ctx: OperationContext,
    args: { scope?: string; resume?: string; budget_tokens?: number },
  ) {
    const user = await this.ensureUser(ctx);
    const budget = args.budget_tokens ?? user.settings.pack_budget_tokens;
    const sections: string[] = [];
    let used = 0;
    let dropped = 0;
    const push = (line: string) => {
      const cost = estimateTokens(line);
      if (used + cost > budget) {
        dropped++;
        return false;
      }
      sections.push(line);
      used += cost;
      return true;
    };

    if (user.identity_card) push(`# Identity\n${user.identity_card}`);

    if (args.resume) {
      const ep = await this.db
        .collection<EpisodeDoc>("episodes")
        .findOne({ user_id: ctx.user_id, "handoff.token": args.resume });
      if (ep?.handoff) {
        push(
          `# Resume (handoff from ${ep.harness})\nTitle: ${ep.title ?? "untitled"}\n${ep.handoff.banked_state}`,
        );
      }
    }

    const memFilter: Record<string, unknown> = {
      user_id: ctx.user_id,
      deleted_at: null,
      valid_until: null,
      tier: { $in: ["core", "standing"] },
      ...this.visibilityFilter(ctx),
    };
    const standing = await this.db
      .collection<MemoryDoc>("memories")
      .find(memFilter)
      .sort({ tier: 1, notability: -1 })
      .limit(30)
      .toArray();
    if (standing.length > 0) {
      push("# Standing memories");
      for (const m of standing) push(`- [${m.kind}] ${m.text}`);
    }

    const recentEpisodes = await this.db
      .collection<EpisodeDoc>("episodes")
      .find({ user_id: ctx.user_id, status: { $ne: "active" }, summary: { $ne: null } })
      .sort({ started_at: -1 })
      .limit(5)
      .toArray();
    if (recentEpisodes.length > 0) {
      push("# Recent sessions");
      for (const ep of recentEpisodes) {
        push(`- [${ep.harness}] ${ep.title ?? ep.episode_id}: ${ep.summary}`);
      }
    }

    const content = sections.join("\n");
    const surfacedIds = standing.map((m) => m.memory_id);
    if (surfacedIds.length > 0) {
      const ts = now();
      await this.db.collection("retrievals").insertMany(
        surfacedIds.map((memory_id, i) => ({
          ts,
          user_id: ctx.user_id,
          episode_id: ctx.episode_id,
          memory_id,
          surface: "pack",
          rank: i,
          score: 1,
          used: null,
        })),
      );
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      content,
      scope: args.scope ?? "global",
      _meta: { budget_used: used, dropped_count: dropped, budget_tokens: budget },
    };
  }

  async delta(ctx: OperationContext, args: { cursor?: string }) {
    const episodeId = ctx.episode_id ?? "anonymous";
    const stateCol = this.db.collection("session_state");
    const state = await stateCol.findOne({ user_id: ctx.user_id, episode_id: episodeId });
    const since =
      args.cursor ?? (state?.delta_cursor as string | undefined) ?? "1970-01-01T00:00:00.000Z";

    const changes = await this.db
      .collection<MemoryDoc>("memories")
      .find({
        user_id: ctx.user_id,
        deleted_at: null,
        valid_from: { $gt: since },
        ...this.visibilityFilter(ctx),
      })
      .sort({ valid_from: 1 })
      .limit(50)
      .toArray();

    const cursor = changes.length > 0 ? (changes[changes.length - 1]?.valid_from ?? since) : since;
    await stateCol.updateOne(
      { user_id: ctx.user_id, episode_id: episodeId },
      {
        $set: { delta_cursor: cursor, updated_at: now() },
        $setOnInsert: { standing_entities: [], surfaced: [] },
      },
      { upsert: true },
    );
    return {
      protocol_version: PROTOCOL_VERSION,
      cursor,
      changes: changes.map((m) => ({
        memory_id: m.memory_id,
        kind: m.kind,
        text: m.text,
        valid_from: m.valid_from,
      })),
    };
  }

  async forget(ctx: OperationContext, args: { memory_id?: string; entity_slug?: string }) {
    if (ctx.remote) throw new Error("forget is not permitted for remote callers");
    const memories = this.db.collection<MemoryDoc>("memories");
    const ts = now();
    let count = 0;
    if (args.memory_id) {
      const r = await memories.updateOne(
        { user_id: ctx.user_id, memory_id: args.memory_id },
        { $set: { deleted_at: ts } },
      );
      count = r.modifiedCount;
      await this.audit(ctx, "forget", args.memory_id, "soft-delete (72h purge window)");
    } else if (args.entity_slug) {
      const ent = await this.db
        .collection<EntityDoc>("entities")
        .findOne({ user_id: ctx.user_id, slug: args.entity_slug });
      if (ent) {
        const r = await memories.updateMany(
          { user_id: ctx.user_id, entity_refs: ent.entity_id },
          { $set: { deleted_at: ts } },
        );
        count = r.modifiedCount;
        await this.audit(
          ctx,
          "forget",
          ent.entity_id,
          `scope-wide soft-delete (${count} memories)`,
        );
      }
    } else {
      throw new Error("forget requires memory_id or entity_slug");
    }
    return { protocol_version: PROTOCOL_VERSION, forgotten: count, purge_after_hours: 72 };
  }

  async synthesize(ctx: OperationContext, args: { question: string }) {
    const recall = await this.recall(ctx, { query: args.question, limit: 10 });
    if (recall.abstained) {
      return {
        protocol_version: PROTOCOL_VERSION,
        answer: null,
        abstained: true,
        message: NO_MEMORY,
        citations: [],
      };
    }
    const answer = recall.results.map((r, i) => `[${i + 1}] ${r.text}`).join("\n");
    return {
      protocol_version: PROTOCOL_VERSION,
      answer,
      abstained: false,
      degraded: true,
      note: "keyless mode: returning cited recall results without LLM synthesis",
      citations: recall.results.map((r) => r.memory_id),
    };
  }

  // ---- episodic extension ----

  async episodeStart(
    ctx: OperationContext,
    args: {
      harness?: Harness;
      agent_name?: string;
      model?: string;
      project?: string;
      cwd?: string;
      repo_remote?: string;
      branch?: string;
      title?: string;
    },
  ) {
    await this.ensureUser(ctx);
    const doc: EpisodeDoc = {
      user_id: ctx.user_id,
      episode_id: id("ep"),
      harness: args.harness ?? ctx.harness,
      agent: { name: args.agent_name ?? ctx.agent, model: args.model ?? null },
      project: args.project ?? null,
      repo: {
        remote: args.repo_remote ?? null,
        branch: args.branch ?? null,
        cwd: args.cwd ?? null,
      },
      started_at: now(),
      ended_at: null,
      status: "active",
      title: args.title ?? null,
      summary: null,
      outcome: { success: null, artifacts: [], commits: [] },
      handoff: null,
      tags: [],
    };
    await this.db.collection<EpisodeDoc>("episodes").insertOne(doc);
    await this.audit(ctx, "episode_start", doc.episode_id, `harness=${doc.harness}`);
    return { protocol_version: PROTOCOL_VERSION, episode_id: doc.episode_id };
  }

  async episodeLog(
    ctx: OperationContext,
    args: {
      episode_id: string;
      type: EventDoc["type"];
      tool?: string;
      ok?: boolean;
      payload?: Record<string, unknown>;
    },
  ) {
    await this.db.collection<EventDoc>("events").insertOne({
      ts: now(),
      episode_id: args.episode_id,
      type: args.type,
      tool: args.tool ?? null,
      ok: args.ok ?? null,
      payload: args.payload ?? {},
    });
    return { protocol_version: PROTOCOL_VERSION, logged: true };
  }

  async episodeEnd(
    ctx: OperationContext,
    args: { episode_id: string; summary?: string; success?: boolean; commits?: string[] },
  ) {
    const r = await this.db.collection<EpisodeDoc>("episodes").updateOne(
      { user_id: ctx.user_id, episode_id: args.episode_id, status: "active" },
      {
        $set: {
          ended_at: now(),
          status: "ended",
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          ...(args.success !== undefined ? { "outcome.success": args.success } : {}),
          ...(args.commits !== undefined ? { "outcome.commits": args.commits } : {}),
        },
      },
    );
    await this.audit(ctx, "episode_end", args.episode_id, `ended=${r.modifiedCount === 1}`);
    return { protocol_version: PROTOCOL_VERSION, ended: r.modifiedCount === 1 };
  }

  async episodeRecall(ctx: OperationContext, args: { query: string; limit?: number }) {
    const limit = Math.min(args.limit ?? 5, 20);
    const words = args.query
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const filter: Record<string, unknown> = { user_id: ctx.user_id };
    if (words.length > 0) {
      filter.$or = [
        { summary: { $regex: words.join("|"), $options: "i" } },
        { title: { $regex: words.join("|"), $options: "i" } },
      ];
    }
    const episodes = await this.db
      .collection<EpisodeDoc>("episodes")
      .find(filter)
      .sort({ started_at: -1 })
      .limit(limit)
      .toArray();
    if (episodes.length === 0) {
      return {
        protocol_version: PROTOCOL_VERSION,
        episodes: [],
        abstained: true,
        message: NO_MEMORY,
      };
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      abstained: false,
      episodes: episodes.map((e) => ({
        episode_id: e.episode_id,
        harness: e.harness,
        title: e.title,
        summary: e.summary,
        started_at: e.started_at,
        status: e.status,
        outcome: e.outcome,
      })),
    };
  }

  async handoff(ctx: OperationContext, args: { episode_id: string; banked_state: string }) {
    if (ctx.remote) throw new Error("handoff is not permitted for remote callers");
    const token = id("hd");
    const r = await this.db.collection<EpisodeDoc>("episodes").updateOne(
      { user_id: ctx.user_id, episode_id: args.episode_id },
      {
        $set: {
          status: "handed_off",
          ended_at: now(),
          handoff: { token, banked_state: args.banked_state, minted_at: now() },
        },
      },
    );
    if (r.matchedCount === 0) throw new Error(`episode not found: ${args.episode_id}`);
    await this.audit(ctx, "handoff", args.episode_id, `token=${token}`);
    return { protocol_version: PROTOCOL_VERSION, token };
  }

  async whoami(ctx: OperationContext) {
    const user = await this.ensureUser(ctx);
    return {
      protocol_version: PROTOCOL_VERSION,
      user_id: user.user_id,
      names: user.names,
      identity_card: user.identity_card,
      consent: ctx.remote ? user.consent : user.consent,
      remote: ctx.remote,
    };
  }

  async stats(ctx: OperationContext) {
    const [memories, entities, edges, episodes, retrievals] = await Promise.all([
      this.db.collection("memories").countDocuments({ user_id: ctx.user_id, deleted_at: null }),
      this.db.collection("entities").countDocuments({ user_id: ctx.user_id }),
      this.db.collection("edges").countDocuments({ user_id: ctx.user_id }),
      this.db.collection("episodes").countDocuments({ user_id: ctx.user_id }),
      this.db.collection("retrievals").countDocuments({ user_id: ctx.user_id }),
    ]);
    return {
      protocol_version: PROTOCOL_VERSION,
      counts: { memories, entities, edges, episodes, retrievals },
      health: "ok",
    };
  }

  async push(
    ctx: OperationContext,
    args: { prompt: string; episode_id?: string },
  ): Promise<PushResult> {
    if (ctx.remote) throw new Error("push is not permitted for remote callers");
    return push(this.db, ctx, args);
  }

  async dream(ctx: OperationContext): Promise<DreamReport> {
    if (ctx.remote) throw new Error("dream is not permitted for remote callers");
    return dream(this.db, ctx);
  }

  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const r = await this.db
      .collection("memories")
      .deleteMany({ deleted_at: { $ne: null, $lt: cutoff } });
    return r.deletedCount;
  }
}
