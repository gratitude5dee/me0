# me0

> **The zeroth layer under every agent: you.**

me0 is an open-source Agent Plugin that gives any agent harness — Claude Code, Codex, pi, Hermes, OpenClaw — one portable, MongoDB-backed personal context graph and agent session memory. Switch harnesses freely; your context comes with you.

**Status:** v0.1 (the spine) · **License:** MIT · Full north-star spec: [`docs/goal.md`](docs/goal.md)

## The one-line test

Start a task in Claude Code, hit your rate limit, open Codex — and the second agent already knows who you are, what the task is, and what the first agent tried. Zero re-explanation.

## What's in v0.1

- **me0-core** — contract-first operation registry, MongoDB schemas (`$jsonSchema` validators + indexes), provenance-stamped writes, bi-temporal memories, visibility scoping, audit log.
- **The 7 memory verbs** (gbrain MEMORY_VERBS v1-shaped, `protocol_version: 1` on every response): `recall` · `remember` · `entity` · `context_pack` · `delta` · `forget` · `synthesize` — plus the episodic extension: `episode_start/log/end`, `episode_recall`, `handoff`, `whoami`, `me0_stats`.
- **me0-mcp** — stdio MCP server exposing the verbs with structured output.
- **me0-cli** — `init` · `doctor` · `verify` · `export` · `import` · `dream` · `op` · `hook`.
- **Adapters** — Claude Code plugin (SessionStart/SessionEnd hooks inject the context pack and close episodes) and Codex (`config.toml` MCP entry + `AGENTS.md` preamble), wired automatically by `me0 init`.
- **Skills** — `me0`, `me0-handoff`, `me0-setup`.

## Quickstart

```bash
git clone https://github.com/gratitude5dee/me0 && cd me0
bun install
bun link me0-cli && bun link me0-mcp

# storage: any MongoDB (local docker is the free floor)
docker run -d --name me0-mongo -p 27017:27017 mongo:8

me0 init --uri mongodb://127.0.0.1:27017 --user me --name "Your Name"
me0 verify        # exit 0 = write → recall → pack round-trip healthy
```

Then use any harness. Try the verbs directly:

```bash
me0 op remember '{"text":"prefers conventional commits, squash-merge","kind":"preference","tier":"standing"}'
me0 op recall '{"query":"commit style"}'
me0 op context_pack '{}'
```

### Cross-harness handoff

```bash
# harness A (about to die):
me0 op handoff '{"episode_id":"ep_...","banked_state":"Fixing auth bug in api/login.ts; JWT refresh path fails on expiry; next: add clock-skew tolerance"}'
# → {"token":"hd_..."}

# harness B (first action):
me0 op context_pack '{"resume":"hd_..."}'
```

### pi adapter (v0.2)

pi has no built-in MCP, so me0 ships a native pi extension (`extensions/pi/me0.ts`) that registers `memory_*` tools (recall, remember, entity, context_pack, delta, episode_recall, handoff, whoami, me0_stats) by delegating to the me0-core operation registry with `harness: "pi"`. It injects the context pack at session start, logs tool calls into the active episode, and closes the episode on shutdown — all fire-and-forget and fail-open. `me0 init` detects `~/.pi/agent/` and installs the extension into `~/.pi/agent/extensions/`.

Backfill past pi sessions (deterministic, no LLM, idempotent — re-running never duplicates):

```bash
me0 import-pi                 # walks ~/.pi/agent/sessions/**/*.jsonl
me0 import-pi --dir /path/to/sessions
```

## Design principles (short form)

User-centric, not brain-centric · verbs-first, additive-forever · deterministic before LLM · provenance + bi-temporality on every memory · honest abstention ("no recorded memory", never a guess) · token cost is a first-class metric · fail-open hooks · consent-scoped sharing (remote callers are world-visibility only; `remember`/`forget`/`handoff` are local-only) · one tree, many harnesses.

See [`docs/goal.md`](docs/goal.md) for the full specification, data model, roadmap (v0.2: pi/Hermes/OpenClaw adapters, push, importers; v0.3: KumoRFM predictive layer, A2A), and references.

## Development

```bash
bun install
bun run typecheck
bun test          # hermetic: mongodb-memory-server, no API keys
bun run lint
```

## License

MIT
