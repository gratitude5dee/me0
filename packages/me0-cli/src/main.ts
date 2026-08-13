#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  Me0Engine,
  type OperationContext,
  type Store,
  connect,
  ensureCollections,
  invoke,
  operations,
} from "me0-core";
import { configDir, loadConfig, saveConfig } from "./config.js";
import { DEFAULT_OPENCLAW_WORKSPACE, importOpenClawWorkspace } from "./import-openclaw.js";
import { openclawDir, wireOpenClaw } from "./openclaw.js";

const HELP = `me0 — the zeroth memory layer

usage: me0 <command> [flags]

commands:
  init      provision storage, wire harnesses (Claude Code, Codex, OpenClaw), seed identity
  doctor    diagnose config, storage, and harness wiring
  verify    end-to-end write → recall → pack round-trip (exit 0 = healthy)
  export    dump all memory as JSONL to stdout or --out <dir>
  import    load a me0 export (JSONL) from --in <file>
  import-openclaw  backfill an OpenClaw workspace (MEMORY.md, memory/*.md, USER.md, SOUL.md) [--dir <workspace>]
  dream     consolidation pass: purge expired soft-deletes, decay tiers
  op        invoke any verb directly: me0 op <name> '<json-args>'
  hook      harness hook entrypoint: me0 hook <session-start|session-end> [json]

flags:
  --uri <mongodb-uri>   override MongoDB URI
  --user <user_id>      override user id
  --name <display name> (init) seed the identity card
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function ctxFor(userId: string): OperationContext {
  return {
    user_id: userId,
    harness: "other",
    agent: "me0-cli",
    episode_id: process.env.ME0_EPISODE_ID ?? null,
    remote: false,
  };
}

async function withEngine<T>(
  uri: string,
  fn: (engine: Me0Engine, db: Store["db"]) => Promise<T>,
): Promise<T> {
  const store = await connect(uri);
  try {
    await ensureCollections(store.db);
    return await fn(new Me0Engine(store.db), store.db);
  } finally {
    await store.close();
  }
}

async function cmdInit(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  const userId = flag(args, "--user") ?? cfg.user_id;
  const name = flag(args, "--name");
  saveConfig({ mongodb_uri: uri, user_id: userId });
  console.log(`config written to ${configDir()}/config.json`);

  await withEngine(uri, async (engine, db) => {
    console.log(
      `storage ok: ${uri} (db: me0, ${(await db.listCollections().toArray()).length} collections)`,
    );
    const ctx = ctxFor(userId);
    await engine.ensureUser(ctx, name ? [name] : []);
    if (name) {
      await db
        .collection("users")
        .updateOne({ user_id: userId }, { $set: { identity_card: `Name: ${name}` } });
      console.log(`identity seeded for ${name}`);
    }
  });

  // Codex wiring
  const codexDir = join(homedir(), ".codex");
  if (existsSync(codexDir)) {
    const configToml = join(codexDir, "config.toml");
    const block = `\n[mcp_servers.me0]\ncommand = "me0-mcp"\nenv = { ME0_MONGODB_URI = "${uri}", ME0_USER_ID = "${userId}", ME0_HARNESS = "codex" }\n`;
    const current = existsSync(configToml) ? readFileSync(configToml, "utf-8") : "";
    if (!current.includes("[mcp_servers.me0]")) {
      appendFileSync(configToml, block);
      console.log(`codex wired: ${configToml}`);
    } else {
      console.log("codex already wired");
    }
    const agentsMd = join(codexDir, "AGENTS.md");
    const preamble = readFileSync(
      join(
        dirname(new URL(import.meta.url).pathname),
        "../../../adapters/codex/AGENTS-preamble.md",
      ),
      "utf-8",
    );
    const currentAgents = existsSync(agentsMd) ? readFileSync(agentsMd, "utf-8") : "";
    if (!currentAgents.includes("<!-- me0 -->")) {
      appendFileSync(agentsMd, `\n${preamble}`);
      console.log(`codex AGENTS.md preamble added: ${agentsMd}`);
    }
  } else {
    console.log("codex not detected (~/.codex missing) — skipped");
  }

  // OpenClaw wiring
  wireOpenClaw(uri, userId);

  console.log(
    "claude code: install the me0 plugin (this repo) via the plugin marketplace, or add mcp.json + hooks/hooks.json to your project.",
  );
  console.log("run `me0 verify` to confirm the round-trip.");
}

async function cmdDoctor(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  let ok = true;
  console.log(`config dir: ${configDir()}`);
  console.log(`user_id: ${cfg.user_id}`);
  try {
    await withEngine(uri, async (_engine, db) => {
      const cols = await db.listCollections().toArray();
      console.log(`mongodb ok: ${uri} (${cols.length} collections)`);
    });
  } catch (err) {
    ok = false;
    console.log(`mongodb FAIL: ${uri} — ${err instanceof Error ? err.message : err}`);
  }
  const codexToml = join(homedir(), ".codex", "config.toml");
  console.log(
    existsSync(codexToml) && readFileSync(codexToml, "utf-8").includes("[mcp_servers.me0]")
      ? "codex: wired"
      : "codex: not wired",
  );
  const openclawConfig = join(openclawDir(), "openclaw.json");
  console.log(
    existsSync(openclawConfig) && readFileSync(openclawConfig, "utf-8").includes('"me0"')
      ? "openclaw: wired"
      : "openclaw: not wired",
  );
  process.exit(ok ? 0 : 1);
}

async function cmdVerify(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  const userId = flag(args, "--user") ?? cfg.user_id;
  const marker = `me0 verify probe ${Date.now()}`;
  try {
    await withEngine(uri, async (engine) => {
      const ctx = ctxFor(userId);
      const w = (await engine.remember(ctx, { text: marker, kind: "fact" })) as {
        memory_id: string;
      };
      const r = await engine.recall(ctx, { query: "verify probe" });
      if (!r.results.some((x) => x.memory_id === w.memory_id)) {
        throw new Error("recall did not return the probe memory");
      }
      const pack = await engine.contextPack(ctx, {});
      if (pack._meta.budget_used > pack._meta.budget_tokens) {
        throw new Error("pack exceeded budget");
      }
      await engine.forget(ctx, { memory_id: w.memory_id });
      console.log("verify ok: write → recall → pack round-trip succeeded");
    });
    process.exit(0);
  } catch (err) {
    console.error(`verify FAIL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const EXPORT_COLLECTIONS = ["users", "entities", "edges", "memories", "episodes", "events"];

async function cmdExport(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  const out = flag(args, "--out");
  await withEngine(uri, async (_engine, db) => {
    if (out) mkdirSync(out, { recursive: true });
    for (const col of EXPORT_COLLECTIONS) {
      const docs = await db.collection(col).find({}).toArray();
      const lines = docs
        .map((d: Record<string, unknown>) => {
          const { _id, ...rest } = d;
          return JSON.stringify({ _collection: col, ...rest });
        })
        .join("\n");
      if (out) {
        writeFileSync(join(out, `${col}.jsonl`), lines ? `${lines}\n` : "");
        console.log(`${col}: ${docs.length} docs → ${join(out, `${col}.jsonl`)}`);
      } else if (lines) {
        console.log(lines);
      }
    }
  });
}

async function cmdImport(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  const input = flag(args, "--in");
  if (!input) {
    console.error("import requires --in <file.jsonl>");
    process.exit(1);
  }
  const lines = readFileSync(input, "utf-8").split("\n").filter(Boolean);
  await withEngine(uri, async (_engine, db) => {
    let n = 0;
    for (const line of lines) {
      const { _collection, ...doc } = JSON.parse(line);
      if (!EXPORT_COLLECTIONS.includes(_collection)) continue;
      await db.collection(_collection).insertOne(doc);
      n++;
    }
    console.log(`imported ${n} docs`);
  });
}

async function cmdImportOpenClaw(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  const userId = flag(args, "--user") ?? cfg.user_id;
  const dir = flag(args, "--dir") ?? DEFAULT_OPENCLAW_WORKSPACE;
  if (!existsSync(dir)) {
    console.error(`import-openclaw: workspace not found: ${dir} (pass --dir <workspace>)`);
    process.exit(1);
  }
  await withEngine(uri, async (engine, db) => {
    const ctx = ctxFor(userId);
    ctx.harness = "openclaw";
    ctx.agent = "openclaw-import";
    const s = await importOpenClawWorkspace(engine, db, ctx, dir);
    console.log(
      `import-openclaw: ${s.memories_added} memories added (${s.memories_skipped} deduped), ${s.episodes_added} episodes added (${s.episodes_skipped} already imported) from ${dir}`,
    );
  });
}

async function cmdDream(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  await withEngine(uri, async (engine, db) => {
    const purged = await engine.purgeExpired();
    const staleCutoff = new Date(Date.now() - 60 * 86400000).toISOString();
    const demoted = await db.collection("memories").updateMany(
      {
        tier: "recall",
        deleted_at: null,
        "access.count": 0,
        valid_from: { $lt: staleCutoff },
      },
      { $set: { tier: "archive" } },
    );
    console.log(
      `dream: purged ${purged} expired, demoted ${demoted.modifiedCount} stale to archive`,
    );
  });
}

async function cmdOp(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  const userId = flag(args, "--user") ?? cfg.user_id;
  const name = args[0];
  if (!name) {
    console.error(`ops: ${operations.map((o) => o.name).join(", ")}`);
    process.exit(1);
  }
  const jsonArg = args[1] && !args[1].startsWith("--") ? args[1] : "{}";
  await withEngine(uri, async (engine) => {
    const result = await invoke(engine, ctxFor(userId), name, JSON.parse(jsonArg));
    console.log(JSON.stringify(result, null, 2));
  });
}

async function cmdHook(args: string[]) {
  const cfg = loadConfig();
  const uri = flag(args, "--uri") ?? cfg.mongodb_uri;
  const userId = flag(args, "--user") ?? cfg.user_id;
  const event = args[0];
  try {
    await withEngine(uri, async (engine) => {
      const ctx = ctxFor(userId);
      ctx.harness = "claude-code";
      ctx.agent = "claude-code";
      if (event === "session-start") {
        const started = (await engine.episodeStart(ctx, {
          harness: "claude-code",
          cwd: process.cwd(),
        })) as { episode_id: string };
        ctx.episode_id = started.episode_id;
        const pack = await engine.contextPack(ctx, {});
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: `<me0 episode_id="${started.episode_id}">\n${pack.content}\n</me0>`,
            },
          }),
        );
      } else if (event === "session-end") {
        const payload = args[1] && !args[1].startsWith("--") ? JSON.parse(args[1]) : {};
        if (payload.episode_id) {
          await engine.episodeEnd(ctx, {
            episode_id: payload.episode_id,
            summary: payload.summary,
            success: payload.success,
          });
        }
      } else {
        throw new Error(`unknown hook event: ${event}`);
      }
    });
  } catch (err) {
    // hooks must fail open: never block the agent on a memory outage
    console.error(`me0 hook (fail-open): ${err instanceof Error ? err.message : err}`);
    process.exit(0);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return cmdInit(args);
    case "doctor":
      return cmdDoctor(args);
    case "verify":
      return cmdVerify(args);
    case "export":
      return cmdExport(args);
    case "import":
      return cmdImport(args);
    case "import-openclaw":
      return cmdImportOpenClaw(args);
    case "dream":
      return cmdDream(args);
    case "op":
      return cmdOp(args);
    case "hook":
      return cmdHook(args);
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
