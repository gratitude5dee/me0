<!-- me0 -->
## me0 memory

You have the `me0` MCP server: the user's portable memory layer.

- At session start, call `context_pack` once to load the user's identity, standing memories, and recent session summaries. If resuming a handoff, pass `resume: "<token>"`.
- Call `episode_start` at the beginning of a work session and `episode_end` (with a 1-3 sentence summary) when finishing.
- Use `recall` before asking the user to re-explain anything about themselves, their projects, or prior decisions. If it returns "no recorded memory", say so — never guess.
- Use `remember` for durable facts, preferences, decisions, and commitments the user states.
- Periodically call `delta` in long sessions to pick up memories written by other harnesses.
