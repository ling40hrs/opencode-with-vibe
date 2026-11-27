// Minimal subset of the Agent Client Protocol (https://agentclientprotocol.com) as spoken by `vibe-acp` 3.1.3.
// Only fields this plugin reads are typed; everything else stays `unknown` and is ignored.

export type JsonObject = Record<string, unknown>

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | (string & {})

/**
 * `session/prompt` usage. `inputTokens` already counts `cachedReadTokens` (they are a subset, not an extra), and
 * `totalTokens` is `inputTokens + outputTokens`. Vibe has no cache-write and no separate thought counter; those
 * fields are only tolerated for compatibility with content produced by the agy dialect and are ignored.
 */
export interface PromptUsage {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  totalTokens?: number
}

export interface PromptResult {
  stopReason: StopReason
  usage?: PromptUsage
}

export interface ModelInfo {
  modelId: string
  name: string
}

/** One entry of `configOptions` (`model`, `thinking`, `mode`). Only flat select lists are understood. */
export interface ConfigOption {
  id: string
  name?: string
  category?: string
  currentValue?: string
  options?: { value: string; name?: string }[]
}

/** What `session/new` answers. Vibe also adds `_meta.workspace_trust`, which this plugin does not read. */
export interface SessionSetup {
  sessionId: string
  modes?: { currentModeId?: string; availableModes?: { id: string; name?: string }[] }
  configOptions?: ConfigOption[]
}

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | (string & {})

export type ToolContent =
  | { type: "diff"; path?: string; newText?: string; oldText?: string | null }
  | { type: "content"; content?: { type?: string; text?: string } }
  | { type: string }

/** Vibe extension on a tool call: the internal tool name and what kind of effect it has. */
export interface ToolMeta {
  tool_name?: string
  effect_kind?: string
}

/** `rawOutput` of an `execute` tool call. `output` is the untruncated form Vibe keeps alongside the clamped streams. */
export interface ToolRawOutput {
  stdout?: string
  stderr?: string
  output?: string
  truncated?: boolean
}

/**
 * `tool_call` and `tool_call_update` share a shape. Vibe only sends `toolCallId`, `title`, `kind`, `status`,
 * `rawInput`, `rawOutput`, `content`, `_meta` — there is no top-level name, args or locations on every update.
 */
export interface ToolCallUpdate {
  sessionUpdate: "tool_call" | "tool_call_update"
  toolCallId: string
  status?: ToolStatus
  kind?: string
  title?: string
  locations?: { path?: string }[]
  rawInput?: unknown
  rawOutput?: unknown
  content?: ToolContent[]
  _meta?: ToolMeta
}

export interface TextChunkUpdate {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"
  content?: { type?: string; text?: string }
}

/** The only place Vibe states the model's context window: `usage_update.size`. */
export interface UsageUpdate {
  sessionUpdate: "usage_update"
  /** The live context of this update: what the model currently holds, not a session total. */
  used?: number
  size?: number
  /** Session cumulative counters (`stats.session_*`), which are only per-call as deltas between two updates. */
  _meta?: {
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
    lastTurnTotal?: number
    steps?: number
  }
}

/** Any other `session/update` (commands, session info, mode...). Ignored by this plugin. */
export interface OtherUpdate {
  sessionUpdate: string
}

export type SessionUpdate = ToolCallUpdate | TextChunkUpdate | UsageUpdate | OtherUpdate

export interface PermissionOption {
  optionId: string
  name?: string
  /** `allow_once`, `allow_always`, `reject_once`. Vibe has no `reject_always`. */
  kind: "allow_once" | "allow_always" | "reject_once" | (string & {})
}

export interface PermissionRequest {
  sessionId: string
  /** Vibe sends only the id here, not the full tool call. */
  toolCall?: { toolCallId?: string }
  options?: PermissionOption[]
}

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "AcpRpcError"
  }
}
