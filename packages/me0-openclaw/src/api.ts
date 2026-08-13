/**
 * The thin slice of the OpenClaw plugin API that the me0 plugin depends on.
 *
 * Modeled on the documented OpenClaw plugin SDK (docs.openclaw.ai/plugins):
 * - a plugin entry exports `{ id, name, description, register(api) }`
 *   (what `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry` produces);
 * - `api.registerTool(tool)` registers agent-callable tools declared in the
 *   manifest's `contracts.tools`;
 * - `api.registerHook(events, handler)` registers internal lifecycle hooks
 *   (`command:new`, `command:stop`, `session:auto-reset`,
 *   `session:compact:before`, `agent:bootstrap`, ...);
 * - `api.on(name, handler, opts?)` registers typed hooks such as
 *   `heartbeat_prompt_contribution` (gateway heartbeat context).
 *
 * Keeping this an explicit structural interface (instead of importing the SDK)
 * keeps the wiring testable with a mocked api and adjustable if OpenClaw's
 * exact surface shifts; the host's real `api` object satisfies it.
 */

export interface OpenClawToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface OpenClawTool {
  name: string;
  description: string;
  /** JSON-schema parameters (OpenClaw accepts TypeBox or plain JSON schema). */
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>): Promise<OpenClawToolResult>;
}

/** Internal hook event, per docs.openclaw.ai/automation/hooks. */
export interface OpenClawHookEvent {
  type: string;
  action: string;
  sessionKey?: string;
  timestamp?: string;
  messages?: string[];
  context?: Record<string, unknown>;
}

export type OpenClawHookHandler = (event: OpenClawHookEvent) => void | Promise<void>;

export interface OpenClawPluginApi {
  /** Resolved plugin config from `plugins.entries.me0.config` in openclaw.json. */
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  registerTool(tool: OpenClawTool, opts?: { optional?: boolean }): void;
  registerHook(events: string | string[], handler: OpenClawHookHandler): void;
  /** Typed hook surface; optional because older gateways may not expose it. */
  on?(
    name: string,
    handler: (event: Record<string, unknown>) => unknown | Promise<unknown>,
    opts?: Record<string, unknown>,
  ): void;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface OpenClawPluginEntry {
  id: string;
  name: string;
  description: string;
  register(api: OpenClawPluginApi): void | Promise<void>;
}
