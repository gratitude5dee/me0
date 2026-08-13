# me0 Memory Provider for Hermes Agent

Replaces Hermes's built-in `MEMORY.md` (2,200-char cap) with the user's
portable, MongoDB-backed context graph. One memory, every harness: what Claude
Code or Codex learned about you yesterday is in Hermes's system prompt today.

## What it does

- **Frozen-snapshot context pack** — at session start the provider computes
  one budgeted context pack (`context_pack` with scope `harness:hermes`) and
  serves those exact bytes for the whole session via `system_prompt_block()`.
  Mid-session memory writes never mutate the prompt, so Hermes's prompt-cache
  prefix stays stable. A `/reset`/`/new` session switch recomputes.
- **Episodic capture** — the session becomes a first-class me0 episode:
  `episode_start` at init, per-turn `episode_log` (daemon thread, non-blocking)
  from `sync_turn`, `episode_end` at session end/shutdown, and a compression
  marker from `on_pre_compress`.
- **Fail-open** — every call shells out to the `me0` CLI with a timeout and
  swallows failures. A memory outage never blocks the agent.

## Install

1. Set up me0 (see the repo root README): `bun install && bun link me0-cli &&
   bun link me0-mcp`, then `me0 init` and `me0 verify`.
2. Copy this directory into your hermes-agent checkout:
   `cp -r plugins/memory/me0 <hermes-agent>/plugins/memory/me0`
3. Activate it: `hermes config set memory.provider me0`

## MCP tools (recommended)

The provider itself is context-only (no tool schemas — Hermes's single-provider
slot serves the pack and captures the episode). To let Hermes call the memory
verbs directly (`recall`, `remember`, `episode_recall`, `handoff`, …), add the
me0 MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  me0:
    command: "me0-mcp"
    env:
      ME0_MONGODB_URI: "mongodb://127.0.0.1:27017"
      ME0_USER_ID: "me"
      ME0_HARNESS: "hermes"
```

`me0 init` writes this entry automatically when it detects `~/.hermes/`.

## Backfill

Import your existing Hermes history and memory files into me0:

```bash
me0 import-hermes                    # reads ~/.hermes/state.db + ~/.hermes/memories/*.md
me0 import-hermes --db /path/state.db --home /path/.hermes
```

Deterministic (no LLM) and idempotent — safe to re-run.

## Interface expectations

Built against hermes-agent's `agent/memory_provider.py` `MemoryProvider` ABC
(`register(ctx)` → `ctx.register_memory_provider(...)`; hooks: `sync_turn`,
`on_session_end`, `on_session_switch`, `on_pre_compress`). If Hermes's plugin
API drifts, the surface this plugin touches is deliberately thin — one class,
one entry point, all effects via the `me0` CLI.
