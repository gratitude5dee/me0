---
name: me0
description: Use the me0 memory verbs (recall, remember, entity, context_pack, delta, forget, synthesize) whenever the user references themselves, their projects, prior sessions, or decisions — or states something worth remembering.
---

# me0 — personal memory

me0 is the user's portable, user-owned memory layer, shared across every agent harness.

## When to recall
- The user references a person, project, repo, tool, or prior decision you don't have context on → `recall` (or `entity` for a cheap card lookup) BEFORE asking them to explain.
- "What did we decide/try...?" → `recall` or `episode_recall`.
- **If recall returns "no recorded memory", say so — do not guess.** Fabricated memories are worse than none.

## When to remember
- The user states a durable fact, preference, decision, or commitment → `remember` with the right `kind`. One memory per atomic fact. Do not store secrets or credentials.

## Session lifecycle
- Start: `context_pack` (≤700 tokens by default) + `episode_start`.
- During long sessions: `delta` to pick up changes from other harnesses.
- End: `episode_end` with a 1-3 sentence summary and outcome.

## Switching harness mid-task
Use the `handoff` tool (see me0-handoff skill).
