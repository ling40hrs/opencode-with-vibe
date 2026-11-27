import type { UsageUpdate } from "./acp/types"

/** One call's own usage, reduced from the cumulative session totals the updates around it report. */
export interface UsageDelta {
  prompt: number
  completion: number
  cached: number
}

/** One session's usage state, as the `usage_update` notifications of its turns leave it. */
export interface SessionUsage {
  /** `usage_update.used`: the live context of the last update, not a session total. */
  used?: number
  /** The cumulative totals of the previous update, which the next one is measured against. */
  prev?: UsageDelta
  /** The last call's own usage; updates that move nothing leave it alone. */
  last?: UsageDelta
}

const LEDGER = new Map<string, SessionUsage>()

/**
 * The ledger entry of an OpenCode session, created on first use. Without a session id the state lives for one call
 * only: nothing else can be told apart, and a call's repeated updates still resolve to the last one that moved.
 */
export function usageLedger(sessionID: string | undefined): SessionUsage {
  if (sessionID === undefined) return {}
  let state = LEDGER.get(sessionID)
  if (state === undefined) {
    state = {}
    LEDGER.set(sessionID, state)
  }
  return state
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/**
 * Records one `usage_update`. `used` is the live context, copied as it comes; the `_meta` counters are session
 * cumulative (`stats.session_prompt_tokens` and friends), so only their delta since the previous update describes one
 * call. Which is the whole point: mapping them directly counted every earlier turn again and pushed the context gauge
 * past 200%.
 *
 * Vibe moves a turn's prompt and its completion in separate updates (one before the response, one after it), so each
 * field keeps the last update that moved it. Letting the later update overwrite the earlier one wholesale would report
 * every turn as a full cache miss.
 */
export function recordUsage(state: SessionUsage, update: UsageUpdate): void {
  const used = update.used
  if (isCount(used) && used >= 0) state.used = used
  const meta = update._meta
  if (!meta) return
  const { promptTokens: prompt, completionTokens: completion, cachedTokens: cached } = meta
  if (!isCount(prompt) || !isCount(completion) || !isCount(cached)) return
  const previous = state.prev ?? { prompt: 0, completion: 0, cached: 0 }
  const delta: UsageDelta = {
    prompt: Math.max(0, prompt - previous.prompt),
    completion: Math.max(0, completion - previous.completion),
    cached: Math.max(0, cached - previous.cached),
  }
  const last = state.last ?? { prompt: 0, completion: 0, cached: 0 }
  state.last = last
  if (delta.prompt > 0) {
    // A new prompt: its cache split replaces the previous call's, and its completion starts from nothing.
    last.prompt = delta.prompt
    last.cached = delta.cached
    last.completion = 0
  }
  if (delta.completion > 0) last.completion = delta.completion
  state.prev = { prompt, completion, cached }
}
