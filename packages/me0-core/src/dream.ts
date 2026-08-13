import type { Db } from "mongodb";
import type { MemoryDoc, OperationContext, UserDoc } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

export interface DreamReport {
  protocol_version: number;
  purged: number;
  deduped: number;
  promoted: number;
  demoted: number;
  identity_card_refreshed: boolean;
  packs_refreshed: number;
}

function now(): string {
  return new Date().toISOString();
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Nightly consolidation pass ("dream"):
 * 1. hard-purge soft-deletes past the 72h window
 * 2. dedupe memories by normalized text (earliest wins; later ones superseded)
 * 3. heat-based tier promotion/demotion (MemoryOS-style) with Ebbinghaus-style staleness demotion
 * 4. recompile the user's identity card from core memories
 * 5. refresh the cached global pack skeleton in `packs`
 */
export async function dream(db: Db, ctx: OperationContext): Promise<DreamReport> {
  const memories = db.collection<MemoryDoc>("memories");
  const ts = now();

  // 1. purge expired soft-deletes
  const purgeCutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  const purge = await memories.deleteMany({ deleted_at: { $ne: null, $lt: purgeCutoff } });

  // 2. dedupe by normalized text
  const live = await memories
    .find({ user_id: ctx.user_id, deleted_at: null, valid_until: null })
    .sort({ valid_from: 1 })
    .toArray();
  const seen = new Map<string, string>();
  let deduped = 0;
  for (const m of live) {
    const key = normalize(m.text);
    const keeper = seen.get(key);
    if (keeper === undefined) {
      seen.set(key, m.memory_id);
    } else {
      await memories.updateOne(
        { user_id: ctx.user_id, memory_id: m.memory_id },
        { $set: { valid_until: ts, superseded_by: keeper } },
      );
      deduped++;
    }
  }

  // 3. heat-based tier movement
  const promoteToStanding = await memories.updateMany(
    {
      user_id: ctx.user_id,
      deleted_at: null,
      valid_until: null,
      tier: "recall",
      "access.count": { $gte: 5 },
    },
    { $set: { tier: "standing" } },
  );
  const promoteToCore = await memories.updateMany(
    {
      user_id: ctx.user_id,
      deleted_at: null,
      valid_until: null,
      tier: "standing",
      "access.count": { $gte: 20 },
    },
    { $set: { tier: "core" } },
  );
  const staleCutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  const demoteStale = await memories.updateMany(
    {
      user_id: ctx.user_id,
      deleted_at: null,
      valid_until: null,
      tier: "recall",
      "access.count": 0,
      valid_from: { $lt: staleCutoff },
    },
    { $set: { tier: "archive" } },
  );
  const coldCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const demoteStanding = await memories.updateMany(
    {
      user_id: ctx.user_id,
      deleted_at: null,
      valid_until: null,
      tier: "standing",
      $or: [
        { "access.last_retrieved_at": null, valid_from: { $lt: coldCutoff } },
        { "access.last_retrieved_at": { $lt: coldCutoff } },
      ],
    },
    { $set: { tier: "recall" } },
  );

  // 4. recompile identity card (name + top core memories)
  const users = db.collection<UserDoc>("users");
  const user = await users.findOne({ user_id: ctx.user_id });
  let identityRefreshed = false;
  if (user) {
    const core = await memories
      .find({ user_id: ctx.user_id, deleted_at: null, valid_until: null, tier: "core" })
      .sort({ notability: -1 })
      .limit(8)
      .toArray();
    const lines: string[] = [];
    if (user.names.length > 0) lines.push(`Name: ${user.names[0]}`);
    for (const m of core) lines.push(`- [${m.kind}] ${m.text}`);
    const card = lines.join("\n").slice(0, 1600); // ~400 tokens
    if (card && card !== user.identity_card) {
      await users.updateOne({ user_id: ctx.user_id }, { $set: { identity_card: card } });
      identityRefreshed = true;
    }
  }

  // 5. refresh cached global pack skeleton
  const standing = await memories
    .find({
      user_id: ctx.user_id,
      deleted_at: null,
      valid_until: null,
      tier: { $in: ["core", "standing"] },
    })
    .sort({ tier: 1, notability: -1 })
    .limit(30)
    .toArray();
  const content = standing.map((m) => `- [${m.kind}] ${m.text}`).join("\n");
  await db.collection("packs").updateOne(
    { user_id: ctx.user_id, scope: "global" },
    {
      $set: {
        content,
        budget_used: Math.ceil(content.length / 4),
        dropped_count: 0,
        computed_at: ts,
      },
      $inc: { generation: 1 },
    },
    { upsert: true },
  );

  await db.collection("audit").insertOne({
    ts,
    actor: { harness: ctx.harness, agent: ctx.agent, remote: ctx.remote },
    op: "dream",
    subject_id: null,
    diff_summary: `purged=${purge.deletedCount} deduped=${deduped} promoted=${
      promoteToStanding.modifiedCount + promoteToCore.modifiedCount
    } demoted=${demoteStale.modifiedCount + demoteStanding.modifiedCount}`,
  });

  return {
    protocol_version: PROTOCOL_VERSION,
    purged: purge.deletedCount,
    deduped,
    promoted: promoteToStanding.modifiedCount + promoteToCore.modifiedCount,
    demoted: demoteStale.modifiedCount + demoteStanding.modifiedCount,
    identity_card_refreshed: identityRefreshed,
    packs_refreshed: 1,
  };
}
