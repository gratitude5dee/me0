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

## Context ingestion (v0.2+)
- `me0 import-context [paths...]` — no paths = walk-up discovery of CLAUDE.md/AGENTS.md/MEMORY.md/USER.md/SOUL.md from cwd plus ~, ~/.claude, ~/.codex. Kind heuristics: "prefer/always/never" → preference, "decided/we chose" → decision, leading imperative verb → procedure, else fact. Idempotent (dedupe on normalized text). Imported memories get confidence 0.6 — below the 0.7 push gate, so they never surface via `me0 hook prompt`.
- `me0 import-claude --dir <dir>` — expects `<dir>/projects/<proj>/` with `*.md` (→ memories) and `*.jsonl` transcripts (→ episode `ep_claude_<sha256(sessionId)[:12]>` + prompt/response/tool_call events). Re-import is NOOP.

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
- `me0 hook prompt '{"prompt":"...","episode_id":"ep_..."}'` emits UserPromptSubmit `<me0-push>` JSON only when a matching memory clears the 0.7 confidence gate (seed one via `me0 op remember` first); `me0 hook session-end '{"episode_id":...,"summary":...,"success":true}'` ends the episode.
- `me0 op episode_log` requires `episode_id` in the JSON args — the `ME0_EPISODE_ID` env var is NOT used as an arg default.

## A2A OAuth (PR #16+)
- Serve with OAuth: `bun packages/me0-cli/src/main.ts serve --a2a --a2a-port 4160 --oauth-issuer <iss> --oauth-audience <aud> --oauth-jwks <jwks-url> [--a2a-token <tok>] [--auth-mode token|oauth|either]` (env: ME0_A2A_OAUTH_ISSUER/AUDIENCE/JWKS, ME0_A2A_AUTH_MODE). Mode defaults: both set → either.
- No real IdP needed: with jose, `generateKeyPair("RS256", { extractable: true })` (extractable is required in Bun or exportPKCS8 throws), export the public JWK with a `kid`, serve `{keys:[...]}` from a tiny Bun.serve, mint tokens with SignJWT (set iss/aud/sub/exp, `scope` claim as space-separated string, protected header `kid` matching the JWKS). Mirror `packages/me0-a2a/test/oauth.test.ts`.
- Expected wire behavior: no token → 401 `WWW-Authenticate: Bearer realm="me0"`; expired/bad token → 401 with `error="invalid_token"`; valid JWT missing `me0.recall` → HTTP 403 + JSON-RPC error -32003 "insufficient scope" + `error="insufficient_scope", scope="me0.recall"`; memory-profile extension needs `me0.profile`. Audit docs get `actor.sub` from the JWT.
- Agent card (`/.well-known/agent-card.json`) advertises `securitySchemes.oauth2` (clientCredentials flow, scopes me0.recall/me0.profile) alongside `bearer` when a static token is set.
- Cosmetic: the serve startup log prints "static bearer token or OAuth 2.1 JWT" whenever both are configured, even with `--auth-mode token` — enforcement still follows authMode.

## Gotchas
- README quickstart's root-level `bun link @wzrdtech/me0 && bun link @wzrdtech/me0-mcp` fails on a fresh clone ("Package is not linked") — you must run bare `bun link` inside each package dir first. Also, root-level `bun link <name>` mutates the root package.json (adds `link:` deps) — restore with git checkout if dirtied.
- Since the npm-publish rename (package `me0-cli` → `@wzrdtech/me0`, bin → `dist/main.js`), run `bun run build` inside each package before linking — the bins point at `dist/`. Stale bun links from older checkouts can hang silently: `rm ~/.bun/bin/me0*` and re-link.
- Node-path testing (no Bun at runtime): `bun run build` + `npm pack` in packages/me0-cli and packages/me0-mcp, `npm install` the tarballs in a clean dir, then drive `./node_modules/.bin/me0` / `me0-mcp`. `me0 serve --a2a` and `me0 import-hermes` are Bun-only and must exit 1 with a clear error under node.

## RFM prediction backends (PR #18+)
- Default heuristic: `me0 rfm predict` (or `--backend heuristic`) writes `predictions` with model `heuristic`.
- Kumo without a real API key: use the hermetic fake MCP server — `ME0_KUMO_API_KEY=test ME0_KUMO_MCP_COMMAND="bun packages/me0-rfm/test/fake-kumo-server.ts" me0 rfm predict --backend kumo` writes model `kumo-rfm-2` rows (retrieval_utility True_PROB 0.8, forget 0.3, prefetch 0.9/0.8/0.7). Each backend run replaces ALL prior predictions for the user's memories (any model) — latest run wins.
- Failure paths: unset ME0_KUMO_API_KEY (or set `ME0_KUMO_API_KEY=bad-key` — the fake server treats it as unauthorized; shell `FAKE_KUMO_MODE` no longer reaches the spawned server since it gets a minimal env) → explicit `me0 rfm predict --backend kumo` exits 1 with setup guidance; `ME0_RFM_BACKEND=kumo me0 dream --rfm` instead falls back silently, printing `rfm (heuristic, kumo fell back): ...` and exiting 0.
- Inspect results: `docker exec me0-mongo mongosh --quiet me0 --eval 'db.predictions.aggregate([{$group:{_id:{model:"$model",task:"$task"},n:{$sum:1}}}]).toArray()'`.
