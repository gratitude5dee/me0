export const PROTOCOL_VERSION = 1;

export type Harness = "claude-code" | "codex" | "pi" | "hermes" | "openclaw" | "devin" | "other";
export type Visibility = "private" | "shared" | "world";
export type MemoryKind = "fact" | "preference" | "decision" | "commitment" | "belief" | "procedure";
export type MemoryTier = "core" | "standing" | "recall" | "archive";
export type EntityType =
  | "person"
  | "org"
  | "project"
  | "repo"
  | "tool"
  | "concept"
  | "event"
  | "place";

export interface Provenance {
  episode_id: string | null;
  harness: Harness;
  agent: string;
  method: "deterministic" | "llm" | "user";
  confidence: number;
  extracted_at: string;
}

export interface UserDoc {
  user_id: string;
  names: string[];
  handles: Record<string, string>;
  identity_card: string;
  settings: {
    default_visibility: Visibility;
    pack_budget_tokens: number;
    push: { min_confidence: number; max_per_turn: number };
  };
  consent: Array<{ scope: string; grantee: string; granted_at: string; expires_at: string | null }>;
  created_at: string;
}

export interface EntityDoc {
  user_id: string;
  entity_id: string;
  slug: string;
  type: EntityType;
  names: string[];
  card: string;
  attrs: Record<string, unknown>;
  status: "verified" | "auto";
  salience: number;
  last_retrieved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EdgeDoc {
  user_id: string;
  edge_id: string;
  src: string;
  dst: string;
  rel: string;
  weight: number;
  valid_from: string;
  valid_until: string | null;
  superseded_by: string | null;
  prov: Provenance;
}

export interface MemoryDoc {
  user_id: string;
  memory_id: string;
  text: string;
  kind: MemoryKind;
  tier: MemoryTier;
  entity_refs: string[];
  visibility: Visibility;
  valid_from: string;
  valid_until: string | null;
  superseded_by: string | null;
  confidence: number;
  notability: number;
  access: { count: number; last_retrieved_at: string | null };
  deleted_at: string | null;
  prov: Provenance;
  embedding?: number[];
  embedding_model?: string;
}

export interface EpisodeDoc {
  user_id: string;
  episode_id: string;
  harness: Harness;
  agent: { name: string; model: string | null };
  project: string | null;
  repo: { remote: string | null; branch: string | null; cwd: string | null };
  started_at: string;
  ended_at: string | null;
  status: "active" | "ended" | "handed_off";
  title: string | null;
  summary: string | null;
  outcome: { success: boolean | null; artifacts: string[]; commits: string[] };
  handoff: { token: string; banked_state: string; minted_at: string } | null;
  tags: string[];
}

export interface EventDoc {
  ts: string;
  episode_id: string;
  type: "prompt" | "response" | "tool_call" | "file_edit" | "command" | "error";
  tool: string | null;
  ok: boolean | null;
  payload: Record<string, unknown>;
}

export interface RetrievalDoc {
  ts: string;
  user_id: string;
  episode_id: string | null;
  memory_id: string;
  surface: "pack" | "recall" | "push" | "delta";
  rank: number;
  score: number;
  used: boolean | null;
}

export interface SessionStateDoc {
  episode_id: string;
  standing_entities: string[];
  surfaced: string[];
  delta_cursor: string;
  updated_at: string;
}

export interface AuditDoc {
  ts: string;
  actor: { harness: Harness; agent: string; remote: boolean };
  op: string;
  subject_id: string | null;
  diff_summary: string;
}

export type Evidence =
  | "alias_hit"
  | "exact_title"
  | "graph_hit"
  | "high_vector"
  | "keyword"
  | "weak_semantic";
export type CreateSafety = "exists" | "probable" | "unknown";

export interface OperationContext {
  user_id: string;
  harness: Harness;
  agent: string;
  episode_id: string | null;
  remote: boolean;
}

export interface RecallResult {
  memory_id: string;
  text: string;
  kind: MemoryKind;
  tier: MemoryTier;
  score: number;
  evidence: Evidence;
  valid_from: string;
  entity_refs: string[];
}
