/**
 * PQL queries for the KumoRFM bridge (goal.md §12). Run over the LocalGraph
 * built from the exported flat tables (see export.ts) via the `kumoai` SDK or
 * the official `kumo-rfm-mcp` server. Each maps to a heuristic fallback in
 * heuristics.ts — RFM is an enhancement tier, never a dependency.
 */
export const PQL_QUERIES = {
  prefetch: "PREDICT LIST_DISTINCT(retrievals.memory_id, 0, 24, hours) FOR EACH users.user_id",
  forget: "PREDICT COUNT(retrievals.*, 0, 90, days)=0 FOR EACH memories.memory_id",
  next_tool:
    "PREDICT LIST_DISTINCT(tool_calls.tool_name, 0, 1, hours) FOR EACH sessions.session_id",
  success_risk: "PREDICT COUNT(outcomes.success=0, 0, 2, hours)>0 FOR EACH sessions.session_id",
  link: "PREDICT LIST_DISTINCT(edges.dst, 0, 30, days) FOR EACH entities.entity_id",
  retrieval_utility: "PREDICT COUNT(retrievals.used=1, 0, 7, days)>0 FOR EACH memories.memory_id",
} as const;
