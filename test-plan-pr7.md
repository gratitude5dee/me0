# Test Plan — PR #7 OpenClaw adapter + backfill importer (shell-only, no recording)

Setup done: bun install, mongo docker up, me0 linked. Static checks already green (typecheck=0, lint=0, 30 tests pass).

## T1: `me0 init` wires OpenClaw + `me0 doctor` reports it
- Create temp OPENCLAW_HOME dir (no openclaw.json inside).
- Run `OPENCLAW_HOME=$TMP me0 init --uri mongodb://127.0.0.1:27017 --user octest --name "OC Test"`.
- PASS: stdout contains "openclaw wired: $TMP/openclaw.json (plugins.entries.me0)"; file exists with `plugins.entries.me0.enabled=true` and `config.mongodb_uri`/`user_id=octest`.
- Re-run init → prints "openclaw already wired", file unchanged.
- `OPENCLAW_HOME=$TMP me0 doctor` → exit 0 and mentions OpenClaw wiring.
- Negative: with OPENCLAW_HOME pointing to a nonexistent dir, init prints "openclaw not detected".

## T2: import-openclaw against real Mongo, idempotent
- `me0 import-openclaw --dir packages/me0-cli/test/fixtures/openclaw-workspace`
- PASS: summary JSON shows memories_added > 0 (from MEMORY/USER/SOUL, excluding code fence + "Short" item), episodes_added = 2 (2026-08-10, 2026-08-11-auth-fix), skipped=0.
- `me0 op recall '{"query":"merge strategy"}'` returns the squash-merge fact; `me0 op episode_recall '{"query":"daily log"}'` returns episodes titled "OpenClaw daily log 2026-08-10/11".
- Adversarial: recall must NOT contain the `rm -rf /` fenced line or "Short".
- Rerun import → memories_added=0, episodes_added=0, skips equal to first-run adds.

## T3: OpenClaw plugin smoke via mock api
- Small bun script constructing the mock OpenClaw api, load plugin from packages/me0-openclaw/src/plugin.ts with config {mongodb_uri, user_id: octest, agent}, invoke registered memory_search tool for "squash-merge" and a lifecycle hook (agent:bootstrap / command:new).
- PASS: memory_search returns imported content; hooks run without throwing; with Mongo stopped a hook still fails open (no throw). Restart mongo after.
