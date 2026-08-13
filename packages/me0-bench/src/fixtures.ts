import type { MemoryKind } from "me0-core";

// Synthetic persona ("Riley Kestrel") — never a real person's graph.
export interface FixtureMemory {
  text: string;
  kind: MemoryKind;
  notability?: number;
  confidence?: number;
  entity_slug?: string;
}

export interface FixtureEntity {
  slug: string;
  type: "person" | "org" | "project" | "repo" | "tool" | "concept" | "event" | "place";
  names: string[];
  card: string;
}

export const FIXTURE_ENTITIES: FixtureEntity[] = [
  {
    slug: "aviary",
    type: "project",
    names: ["aviary", "Aviary"],
    card: "Aviary: Riley's bird-photo tagging side project (TypeScript + MongoDB).",
  },
  {
    slug: "kestrel-labs",
    type: "org",
    names: ["kestrel-labs", "Kestrel Labs"],
    card: "Kestrel Labs: Riley's two-person consultancy.",
  },
  {
    slug: "bun",
    type: "tool",
    names: ["bun", "Bun"],
    card: "Bun: Riley's preferred JS runtime.",
  },
];

export const FIXTURE_MEMORIES: FixtureMemory[] = [
  {
    text: "Riley prefers conventional commits with squash-merge",
    kind: "preference",
    notability: 0.9,
    confidence: 0.95,
  },
  {
    text: "Riley uses Bun as the default JavaScript runtime",
    kind: "preference",
    notability: 0.8,
    confidence: 0.9,
    entity_slug: "bun",
  },
  {
    text: "Decided to use MongoDB time-series collections for Aviary event logs",
    kind: "decision",
    notability: 0.8,
    confidence: 0.9,
    entity_slug: "aviary",
  },
  {
    text: "Riley committed to shipping the Aviary tagging MVP by end of quarter",
    kind: "commitment",
    notability: 0.9,
    confidence: 0.9,
    entity_slug: "aviary",
  },
  {
    text: "Kestrel Labs invoices net-30 and bills in USD",
    kind: "fact",
    notability: 0.6,
    confidence: 0.85,
    entity_slug: "kestrel-labs",
  },
  {
    text: "To deploy Aviary: bun run build, then fly deploy --remote-only",
    kind: "procedure",
    notability: 0.7,
    confidence: 0.9,
    entity_slug: "aviary",
  },
  {
    text: "Riley believes local-first storage is non-negotiable for personal data",
    kind: "belief",
    notability: 0.7,
    confidence: 0.8,
  },
  { text: "Riley's timezone is US Eastern", kind: "fact", notability: 0.8, confidence: 0.95 },
  {
    text: "Prefer TypeScript strict mode in all new projects",
    kind: "preference",
    notability: 0.7,
    confidence: 0.9,
  },
  {
    text: "Decided against GraphQL for the Aviary API; plain JSON over HTTP",
    kind: "decision",
    notability: 0.6,
    confidence: 0.85,
    entity_slug: "aviary",
  },
];

// query → substring expected in the top-1 result text
export const RECALL_PROBES: Array<{ query: string; expect: string }> = [
  { query: "commit style preference", expect: "conventional commits" },
  { query: "how to deploy aviary", expect: "fly deploy" },
  { query: "which runtime does the user prefer", expect: "Bun" },
  { query: "timezone", expect: "US Eastern" },
  { query: "aviary api decision graphql", expect: "GraphQL" },
];

// adversarial: nothing recorded about these — recall must abstain
export const ABSTENTION_PROBES: string[] = [
  "favorite opera singer of the user",
  "user's blood type and allergies",
  "the wifi password at the cabin",
  "kubernetes cluster naming convention",
];

// prompts unrelated to any memory — push must fire nothing
export const PUSH_NEGATIVE_PROMPTS: string[] = [
  "please summarize this pdf",
  "translate hello world to japanese",
];

// prompts related to seeded memories — push should fire at least one
export const PUSH_POSITIVE_PROMPTS: string[] = [
  "let's set up commits for the new repo",
  "time to deploy aviary to production",
];
