export const MEMORY_PROFILE_EXTENSION_URI = "https://me0.dev/a2a/ext/memory-profile/v1";

export interface AgentCardOptions {
  url: string;
  auth: "bearer" | "none";
}

/** A2A v1 Agent Card served at /.well-known/agent-card.json */
export function buildAgentCard(opts: AgentCardOptions) {
  return {
    protocolVersion: "1.0",
    name: "me0",
    description:
      "The zeroth memory layer: consent-scoped recall over a person's own memory substrate. Remote callers see world-visibility memories only; every call is audited.",
    url: opts.url,
    preferredTransport: "JSONRPC",
    version: "0.3.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: MEMORY_PROFILE_EXTENSION_URI,
          description:
            "Request a redacted, budgeted memory-profile pack as a DataPart — a portable memory handoff between assistants.",
          required: false,
        },
      ],
    },
    securitySchemes: opts.auth === "bearer" ? { bearer: { type: "http", scheme: "bearer" } } : {},
    security: opts.auth === "bearer" ? [{ bearer: [] }] : [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "memory.recall",
        name: "Recall memories",
        description:
          "Hybrid search over world-visible memories. Abstains explicitly ('no recorded memory') rather than guessing.",
        tags: ["memory", "recall", "search"],
        examples: ["what does the user prefer for commit style?"],
      },
      {
        id: "memory.context_pack",
        name: "Context pack",
        description:
          "Budgeted identity + standing-memory pack (world-visible tier only for remote callers).",
        tags: ["memory", "context", "profile"],
      },
      {
        id: "memory.synthesize",
        name: "Synthesize answer",
        description: "Cited answer over recalled world-visible memories; abstains when empty.",
        tags: ["memory", "synthesis"],
      },
    ],
  };
}
