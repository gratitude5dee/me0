import type { Document } from "mongodb";

const prov: Document = {
  bsonType: "object",
  required: ["harness", "agent", "method", "confidence", "extracted_at"],
  properties: {
    episode_id: { bsonType: ["string", "null"] },
    harness: { enum: ["claude-code", "codex", "pi", "hermes", "openclaw", "other"] },
    agent: { bsonType: "string" },
    method: { enum: ["deterministic", "llm", "user"] },
    confidence: { bsonType: ["double", "int"], minimum: 0, maximum: 1 },
    extracted_at: { bsonType: "string" },
  },
};

export const validators: Record<string, Document> = {
  users: {
    $jsonSchema: {
      bsonType: "object",
      required: ["user_id", "names", "identity_card", "settings", "created_at"],
      properties: {
        user_id: { bsonType: "string" },
        names: { bsonType: "array", items: { bsonType: "string" } },
        handles: { bsonType: "object" },
        identity_card: { bsonType: "string" },
        settings: { bsonType: "object" },
        consent: { bsonType: "array" },
        created_at: { bsonType: "string" },
      },
    },
  },
  entities: {
    $jsonSchema: {
      bsonType: "object",
      required: ["user_id", "entity_id", "slug", "type", "names", "status", "created_at"],
      properties: {
        user_id: { bsonType: "string" },
        entity_id: { bsonType: "string" },
        slug: { bsonType: "string" },
        type: {
          enum: ["person", "org", "project", "repo", "tool", "concept", "event", "place"],
        },
        names: { bsonType: "array", items: { bsonType: "string" } },
        card: { bsonType: "string" },
        attrs: { bsonType: "object" },
        status: { enum: ["verified", "auto"] },
        salience: { bsonType: ["double", "int"], minimum: 0, maximum: 1 },
      },
    },
  },
  edges: {
    $jsonSchema: {
      bsonType: "object",
      required: ["user_id", "edge_id", "src", "dst", "rel", "valid_from", "prov"],
      properties: {
        user_id: { bsonType: "string" },
        edge_id: { bsonType: "string" },
        src: { bsonType: "string" },
        dst: { bsonType: "string" },
        rel: { bsonType: "string" },
        weight: { bsonType: ["double", "int"], minimum: 0, maximum: 1 },
        valid_from: { bsonType: "string" },
        valid_until: { bsonType: ["string", "null"] },
        superseded_by: { bsonType: ["string", "null"] },
        prov,
      },
    },
  },
  memories: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "user_id",
        "memory_id",
        "text",
        "kind",
        "tier",
        "visibility",
        "valid_from",
        "prov",
      ],
      properties: {
        user_id: { bsonType: "string" },
        memory_id: { bsonType: "string" },
        text: { bsonType: "string" },
        kind: { enum: ["fact", "preference", "decision", "commitment", "belief", "procedure"] },
        tier: { enum: ["core", "standing", "recall", "archive"] },
        entity_refs: { bsonType: "array", items: { bsonType: "string" } },
        visibility: { enum: ["private", "shared", "world"] },
        valid_from: { bsonType: "string" },
        valid_until: { bsonType: ["string", "null"] },
        superseded_by: { bsonType: ["string", "null"] },
        confidence: { bsonType: ["double", "int"], minimum: 0, maximum: 1 },
        notability: { bsonType: ["double", "int"], minimum: 0, maximum: 1 },
        deleted_at: { bsonType: ["string", "null"] },
        prov,
      },
    },
  },
  episodes: {
    $jsonSchema: {
      bsonType: "object",
      required: ["user_id", "episode_id", "harness", "started_at", "status"],
      properties: {
        user_id: { bsonType: "string" },
        episode_id: { bsonType: "string" },
        harness: { enum: ["claude-code", "codex", "pi", "hermes", "openclaw", "other"] },
        started_at: { bsonType: "string" },
        ended_at: { bsonType: ["string", "null"] },
        status: { enum: ["active", "ended", "handed_off"] },
      },
    },
  },
  events: {
    $jsonSchema: {
      bsonType: "object",
      required: ["ts", "episode_id", "type"],
      properties: {
        ts: { bsonType: "string" },
        episode_id: { bsonType: "string" },
        type: { enum: ["prompt", "response", "tool_call", "file_edit", "command", "error"] },
      },
    },
  },
  retrievals: {
    $jsonSchema: {
      bsonType: "object",
      required: ["ts", "user_id", "memory_id", "surface"],
      properties: {
        surface: { enum: ["pack", "recall", "push", "delta"] },
      },
    },
  },
  session_state: {
    $jsonSchema: {
      bsonType: "object",
      required: ["episode_id", "delta_cursor", "updated_at"],
      properties: {
        episode_id: { bsonType: "string" },
        delta_cursor: { bsonType: "string" },
      },
    },
  },
  audit: {
    $jsonSchema: {
      bsonType: "object",
      required: ["ts", "actor", "op"],
      properties: {
        ts: { bsonType: "string" },
        op: { bsonType: "string" },
      },
    },
  },
};
