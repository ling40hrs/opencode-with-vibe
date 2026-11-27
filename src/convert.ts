import type { JSONValue, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { contentText } from "./acp/content"
import type { PromptResult, SessionUpdate, ToolCallUpdate, UsageUpdate } from "./acp/types"
import { canonical } from "./sync/canonical"
import type { ToolIdentity } from "./sync/fingerprint"
import { recordUsage, type SessionUsage } from "./usage"

type Part = LanguageModelV3StreamPart
type Finish = Extract<Part, { type: "finish" }>

const MAX_STRING = 8_000

export interface ConverterOptions {
  /** Called with `usage_update.size`, the only place Vibe states the model's context window. */
  onContext?: (size: number) => void
  /** The usage ledger of the session this stream belongs to; `usage_update` writes into it. */
  state?: SessionUsage
}

/** Turns Vibe's `session/update` notifications into AI SDK v3 stream parts. */
export class UpdateConverter {
  private seq = 0
  private text: string | undefined
  private reasoning: string | undefined
  private tools = new Map<string, { name: string; resulted: boolean }>()

  constructor(private readonly options: ConverterOptions = {}) {}

  /** Parts produced by one update. Unknown or noisy updates produce none. */
  push(update: SessionUpdate): Part[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.chunk("text", contentText((update as { content?: unknown }).content))
      case "agent_thought_chunk":
        return this.chunk("reasoning", contentText((update as { content?: unknown }).content))
      case "tool_call":
      case "tool_call_update":
        return this.tool(update as ToolCallUpdate)
      case "usage_update": {
        const usage = update as UsageUpdate
        if (this.options.state) recordUsage(this.options.state, usage)
        const size = usage.size
        if (typeof size === "number" && Number.isFinite(size) && size > 0) this.options.onContext?.(size)
        return []
      }
      default:
        // user_message_chunk (echo), session_info_update, available_commands_update, ...
        return []
    }
  }

  /** Closes anything still open. Call before `finish`. */
  close(): Part[] {
    return [...this.endText(), ...this.endReasoning()]
  }

  private chunk(kind: "text" | "reasoning", delta: string | undefined): Part[] {
    if (!delta) return []
    const parts: Part[] = kind === "text" ? this.endReasoning() : this.endText()
    const open = kind === "text" ? this.text : this.reasoning
    if (open === undefined) {
      const id = `${kind}-${this.seq++}`
      if (kind === "text") this.text = id
      else this.reasoning = id
      parts.push({ type: `${kind}-start`, id })
      parts.push({ type: `${kind}-delta`, id, delta })
      return parts
    }
    parts.push({ type: `${kind}-delta`, id: open, delta })
    return parts
  }

  private endText(): Part[] {
    if (this.text === undefined) return []
    const id = this.text
    this.text = undefined
    return [{ type: "text-end", id }]
  }

  private endReasoning(): Part[] {
    if (this.reasoning === undefined) return []
    const id = this.reasoning
    this.reasoning = undefined
    return [{ type: "reasoning-end", id }]
  }

  private tool(update: ToolCallUpdate): Part[] {
    if (!update.toolCallId) return []
    const parts: Part[] = []
    let known = this.tools.get(update.toolCallId)
    if (!known) {
      // Text and thoughts before the call are finished; later text starts a new block.
      parts.push(...this.close())
      const name = toolName(update)
      known = { name, resulted: false }
      this.tools.set(update.toolCallId, known)
      const input = JSON.stringify(update.rawInput ?? {})
      parts.push(
        { type: "tool-input-start", id: update.toolCallId, toolName: name, providerExecuted: true, dynamic: true },
        { type: "tool-input-delta", id: update.toolCallId, delta: input },
        { type: "tool-input-end", id: update.toolCallId },
        { type: "tool-call", toolCallId: update.toolCallId, toolName: name, input, providerExecuted: true, dynamic: true },
      )
    }
    const status = update.status
    // Vibe repeats a finished call when it replays a transcript (session/load); one result per call is enough.
    if (!known.resulted && (status === "completed" || status === "failed")) {
      known.resulted = true
      parts.push({
        type: "tool-result",
        toolCallId: update.toolCallId,
        toolName: known.name,
        result: toolResult(update),
        isError: status === "failed" ? true : undefined,
        dynamic: true,
      })
    }
    return parts
  }
}

const STOP_REASONS: Record<string, Finish["finishReason"]["unified"]> = {
  end_turn: "stop",
  max_tokens: "length",
  max_turn_requests: "length",
  refusal: "content-filter",
  error: "error",
}

export function finishPart(
  result: PromptResult,
  metadata?: Record<string, string>,
  state?: SessionUsage,
): Finish {
  return {
    type: "finish",
    usage: mapUsage(state),
    finishReason: { unified: STOP_REASONS[result.stopReason] ?? "other", raw: result.stopReason },
    ...(metadata ? { providerMetadata: { vibe: metadata } } : {}),
  }
}

const UNMEASURED: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

/**
 * One call's usage, from the session ledger rather than from `result.usage`.
 *
 * Vibe answers `session/prompt` with the session's cumulative totals (`_meta.promptTokens` and friends), so mapping
 * them as the usage of the call that just finished counted every earlier turn again; the gauge grew past 200% and
 * auto-compaction fired on a small context. The ledger reduces those totals to this call's delta instead, and `used`
 * — the live context — is the anchor: `noCache + cacheRead + output` equals it.
 *
 * Without a ledger entry nothing is reported: a missing measurement is better than a cumulative total.
 * Vibe has no cache-write and no separate thought counter.
 */
export function mapUsage(state: SessionUsage | undefined): LanguageModelV3Usage {
  const last = state?.last
  if (last === undefined) return UNMEASURED
  const used = state?.used
  // A completion can never exceed the context it ran in; what is left of the context is the prompt.
  const output = used === undefined ? Math.max(0, last.completion) : Math.min(Math.max(0, last.completion), used)
  const input = used === undefined ? Math.max(0, last.prompt) : Math.max(0, used - output)
  const cacheRead = Math.min(Math.max(0, last.cached), input)
  return {
    inputTokens: { total: input, noCache: Math.max(0, input - cacheRead), cacheRead, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  }
}

/** Identity of a tool call as it is streamed to OpenCode, for matching OpenCode's echo of it later. */
export function toolIdentity(update: ToolCallUpdate): ToolIdentity {
  return { id: update.toolCallId, name: toolName(update), input: canonical(update.rawInput ?? {}) }
}

/**
 * Vibe names its tools only in `_meta.tool_name` (`bash`, `write_file`, ...) and otherwise describes the tool
 * through `kind` (`execute`, `edit`, ...). Without the `_meta` fallback every call would collapse into one name.
 */
export function toolName(update: ToolCallUpdate) {
  const base = update._meta?.tool_name ?? update.kind ?? "tool"
  return `vibe_${base.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

/** `/C:/Users/me/x` (URI-style path) becomes `C:\Users\me\x`. */
export function normalizePath(path: string) {
  const match = /^\/([A-Za-z]:)[\\/](.*)$/.exec(path)
  return match ? `${match[1]}\\${match[2]!.replace(/\//g, "\\")}` : path
}

function toolResult(update: ToolCallUpdate) {
  const text: string[] = []
  const diffs: { path?: string; newText?: string; oldText?: string }[] = []
  for (const item of update.content ?? []) {
    if (item.type === "diff") {
      const diff = item as { path?: string; newText?: string; oldText?: string | null }
      diffs.push({
        ...(diff.path ? { path: normalizePath(diff.path) } : {}),
        ...(diff.newText !== undefined ? { newText: diff.newText } : {}),
        ...(diff.oldText ? { oldText: diff.oldText } : {}),
      })
    } else if (item.type === "content") {
      const inner = (item as { content?: { text?: string } }).content
      if (inner?.text) text.push(inner.text)
    }
  }
  const locations = (update.locations ?? []).flatMap((location) => (location.path ? [normalizePath(location.path)] : []))
  return truncate({
    title: update.title?.replace(/(^|\s)\/([A-Za-z]:[\\/])/g, "$1$2"),
    status: update.status,
    ...(text.length ? { text: text.join("\n") } : {}),
    ...(diffs.length ? { diffs } : {}),
    ...(locations.length ? { locations } : {}),
    ...(update.rawOutput !== undefined && !isEmptyObject(update.rawOutput) ? { output: dedupe(update.rawOutput, text) } : {}),
  }) as NonNullable<JSONValue>
}

/** Vibe repeats a command's stdout in both `content` and `rawOutput.stdout`/`output`; keep only the structured extras. */
function dedupe(raw: unknown, text: readonly string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const { stdout, stderr, output, ...rest } = raw as Record<string, unknown>
  const duplicated = (value: unknown) => typeof value === "string" && (value === "" || text.includes(value))
  const extras: Record<string, unknown> = {}
  if (!duplicated(stdout)) extras.stdout = stdout
  if (!duplicated(stderr)) extras.stderr = stderr
  if (!duplicated(output)) extras.output = output
  return { ...extras, ...rest }
}

const isEmptyObject = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0

function truncate(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [truncated ${value.length - MAX_STRING} chars]` : value
  if (Array.isArray(value)) return value.map(truncate)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, truncate(item)]),
    )
  return value
}
