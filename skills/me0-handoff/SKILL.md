---
name: me0-handoff
description: Hand a live task off to another agent harness mid-task (rate limits, tool gaps) so the next agent resumes with full context and zero re-explanation.
---

# me0-handoff — switching harness mid-task

When the user needs to switch harness (rate-limited, missing tool, preference):

1. Call `handoff` with the current `episode_id` and a `banked_state` string containing: the task goal, current repo/branch state, what has been tried, what failed and why, and the exact next step.
2. Give the user the returned token: "Resume in the next agent with `context_pack(resume=\"<token>\")`."
3. In the NEW harness: call `context_pack` with `resume: "<token>"` as the very first memory action. The pack includes the banked state. Do not ask the user to re-explain the task.
