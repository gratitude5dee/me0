---
name: testing-me0
description: How to run and end-to-end test the me0 memory layer (CLI, MCP server, hooks) against a local MongoDB.
---

# Testing me0

## Setup
- Bun monorepo: `bun install` at repo root; `bun link` inside `packages/me0-cli` and `packages/me0-mcp` to get `me0` / `me0-mcp` on PATH.
- MongoDB: `docker run -d --name me0-mongo -p 127.0.0.1:27017:27017 mongo:8`.
- Static checks: `bun run typecheck`, `bun run lint` (biome), `bun test`.

## CLI golden path
- `me0 init --uri mongodb://127.0.0.1:27017 --user <id> --name "<Name>"` writes `~/.me0/config.json` and seeds identity.
- `me0 verify` (exit 0 = write→recall→pack round-trip ok), `me0 doctor` (exit 0 = mongo reachable).
- Any verb: `me0 op <name> '<json>'` — ops: recall, remember, entity, context_pack, delta, forget, synthesize, episode_start/log/end/recall, handoff, whoami, me0_stats.
- Handoff flow: `episode_start` → `handoff {"episode_id","banked_state"}` returns `token` → `context_pack {"resume":"<token>"}` includes the banked state.
- Export/import: `me0 export --out <dir>` writes one JSONL per collection; `me0 import --in <file.jsonl>` (lines carry `_collection`).

## MCP server (stdio JSON-RPC)
- Launch: `ME0_MONGODB_URI=... ME0_USER_ID=... bun packages/me0-mcp/src/server.ts`.
- Pipe newline-delimited JSON-RPC: initialize → notifications/initialized → tools/list → tools/call. Note: the server does NOT exit when stdin closes — run it backgrounded/kill it, don't wait for the pipeline to finish.

## OpenClaw adapter (PR #7+)
- `me0 init` wires OpenClaw when `$OPENCLAW_HOME` (or `~/.openclaw`) exists: point `OPENCLAW_HOME` at a temp dir to test; it writes `plugins.entries.me0` into `<dir>/openclaw.json`; `me0 doctor` then prints "openclaw: wired".
- Backfill: `me0 import-openclaw --dir packages/me0-cli/test/fixtures/openclaw-workspace` — deterministic and idempotent (rerun should report 0 added). Fixture yields 6 memories + 2 episodes; code fences and <8-char items are excluded.
- Plugin smoke test without a real OpenClaw host: import `packages/me0-openclaw/src/plugin.ts` in a bun script with a mock api implementing `registerTool`/`registerHook`/`on` (see `src/api.ts` for the structural interface); call `plugin.register(api)`, then invoke tools/hooks directly. Fail-open check: use `mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1500` with mongo stopped so hooks fail fast instead of hanging ~30s.

## pi adapter
- Backfill: `me0 import-pi --dir <sessions-dir> --uri mongodb://127.0.0.1:27017 --user <id>` — deterministic + idempotent (key `ep_pi_<session id>`); rerun should report all files as "already present". Fixtures: `packages/me0-cli/test/fixtures/pi-sessions` (2 sessions → 2 episodes, 6 events).
- Verify imports with `me0 op episode_recall '{"query":"pi"}'` (note: episode_recall requires a `query` arg).
- Extension wiring: `mkdir -p ~/.pi/agent` then `me0 init` writes a wrapper to `~/.pi/agent/extensions/me0.ts` re-exporting `extensions/pi/me0.ts`; second init prints "pi already wired". Extension unit tests live in `extensions/pi/me0.test.ts` and run under `bun test`.

## Hooks
- `me0 hook session-start` prints Claude Code `hookSpecificOutput` JSON; with Mongo down it must still exit 0 (fail-open, error on stderr). Restart mongo (`docker start me0-mongo`) afterwards.
