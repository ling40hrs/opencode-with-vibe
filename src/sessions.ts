import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { AcpClient } from "./acp/client"
import { contentText } from "./acp/content"
import {
  AcpRpcError,
  type ConfigOption,
  type ContentBlock,
  type PromptResult,
  type SessionSetup,
  type SessionUpdate,
  type ToolCallUpdate,
} from "./acp/types"
import { toolIdentity } from "./convert"
import { MODE_CONFIG_ID, MODEL_CONFIG_ID, THINKING_CONFIG_ID, type CatalogModel } from "./models"
import { actionOfCall, decide as decideRule, instructionText, restricts, type Policy, type Previous } from "./plan"
import { modeOf, thinkingOf } from "./probe"
import { decide, type Decision, type SessionRecord } from "./sync/decide"
import { ANY_REPLY, assistantHash, groups as fingerprint, type Group, type ToolIdentity } from "./sync/fingerprint"
import { catchUpContent, flattenContent, userContent, type Rendered } from "./sync/render"

export interface SessionStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface RunRequest {
  /** OpenCode session id. Without one (or when `primary` is false) a throwaway Vibe session is used. */
  sessionID?: string
  /** True for the main chat loop; titles, compaction and other helper requests are not primary. */
  primary: boolean
  /** Base Vibe model id, e.g. `mistral-large-4-0`. */
  modelId: string
  /** Thinking level from the selected variant, already checked against the catalog. Unset: the model's default. */
  thoughtLevel?: string
  prompt: LanguageModelV3Prompt
  signal: AbortSignal
  onUpdate: (update: SessionUpdate) => void
}

export type RunMode = "continue" | "reattached" | "fresh" | "throwaway"

export interface RunOutcome {
  result: PromptResult
  mode: RunMode
  /** Why a new Vibe conversation was needed, when one was. */
  reason?: string
  acpSessionId: string
  /** What was sent to Vibe (useful for tests and debugging). */
  sent: ContentBlock[]
  warnings: string[]
}

export interface SessionsOptions {
  cwd: string
  /** Close a Vibe conversation after this long without use. It is resumed from disk on demand. 0 disables. */
  idleMs?: number
  debug?: (message: string, data?: unknown) => void
  /** Called whenever a conversation is created for a chat session (not for helper requests). */
  onChatSession?: () => void
  /** Catalog entry of a base model; supplies the default thinking level to apply when none is selected. */
  catalog?: (modelId: string) => CatalogModel | undefined
  /**
   * The OpenCode agent governing a chat session, resolved per turn because the user can switch agents between them.
   * Undefined (no agent, or one that could not be read) leaves Vibe's own approval policy untouched.
   */
  policy?: (sessionID: string) => Promise<Policy | undefined>
}

/**
 * The earlier Vibe conversation could not be checked (resume failed for a reason other than "not found").
 * Nothing was changed, so the same request can simply be sent again.
 */
export class VibeRetryableError extends Error {
  override name = "VibeRetryableError"
}

interface Live {
  acpSessionId: string
  generation: number
  /** Model last applied on this ACP session, or undefined when unknown (after resume). */
  model?: string
  /** Thinking level last applied (or known to be current), or undefined when unknown. */
  level?: string
  /** Session mode last known to be active; used to repair it after a model switch resets it. */
  mode?: string
  /** The mode Vibe started this conversation with, restored once no OpenCode agent restricts tools. */
  base?: string
  /** Whether the previous turn ran under a restricting agent, for the one-shot "no longer in that mode" note. */
  restricted?: boolean
  /** That agent's `instructions.unselected`, kept so the note can still be sent after a restart. */
  unselected?: string
  /** Tool calls already finished in this conversation, so a replayed transcript is not emitted twice. */
  done?: Set<string>
  timer?: ReturnType<typeof setTimeout>
}

const STORAGE_PREFIX = "session:"
/** Where the last plan-mode state of a chat session is remembered; see `applyPolicy`. */
const AGENT_PREFIX = "agent:"

export class VibeSessions {
  private live = new Map<string, Live>()
  private locks = new Map<string, Promise<unknown>>()
  /** What governs each live conversation, for answering its permission requests. Keyed by ACP session id. */
  private policies = new Map<string, Policy>()

  constructor(
    private readonly client: AcpClient,
    private readonly store: SessionStore,
    private readonly options: SessionsOptions,
  ) {
    // Vibe only asks when its own approval policy is `ask`, which a restricting agent turns on. Its request names a
    // tool call id and nothing else, so the answer comes from the rules of the agent that session belongs to.
    this.client.decide ??= (sessionId, call) => this.judge(sessionId, call)
  }

  /**
   * Answers one `session/request_permission` from the rules of the governing agent.
   *
   * `ask` never reaches Vibe: OpenCode would have prompted the user, and the ACP client has no way to, so a rule that
   * asks is treated as a refusal. That is the only fail-closed answer available, and it keeps a plan turn from
   * quietly approving the one call the rules wanted a human for.
   */
  private judge(sessionId: string, call: ToolCallUpdate | undefined): "allow" | "deny" | "ask" {
    const policy = this.policies.get(sessionId)
    if (!policy) return "ask"
    if (!call) {
      // A request for a call that was never described cannot be judged; the agent restricts, so refuse.
      this.options.debug?.("permission denied without a tool call", { sessionId })
      return "deny"
    }
    const { action, resource } = actionOfCall(call)
    const effect = decideRule(policy.rules, action, resource, this.options.cwd)
    this.options.debug?.("permission judged", { agent: policy.agent, action, resource, effect })
    return effect === "ask" ? "deny" : effect
  }

  run(request: RunRequest): Promise<RunOutcome> {
    if (!request.primary || !request.sessionID) return this.throwaway(request)
    return this.serialized(request.sessionID, () => this.primary(request.sessionID!, request))
  }

  /** Cancels the idle timers. The child process itself is owned by the client. */
  dispose() {
    for (const live of this.live.values()) clearTimeout(live.timer)
    this.live.clear()
  }

  private async primary(sessionID: string, request: RunRequest): Promise<RunOutcome> {
    const groups = fingerprint(request.prompt)
    const record = await this.load(sessionID)
    let decision = decide(groups, record)
    // The recorded conversation, when verified not to exist in Vibe any more (nothing to retire then).
    let recordGone = false
    let reattached = false
    this.stopIdle(sessionID)
    try {

    if (decision.kind === "continue" && record) {
      const live = this.live.get(sessionID)
      // After a crash the generation only changes on the next spawn, so a dead process must not look usable.
      const usable =
        this.client.running && live?.acpSessionId === record.acpSessionId && live.generation === this.client.generation
      if (!usable) {
        // The old conversation keeps working in its own directory, so a changed cwd just starts a new one.
        if (record.cwd !== this.options.cwd) decision = { kind: "fresh", reason: "diverged" }
        else if ((await this.reattach(sessionID, record)) === "ok") reattached = true
        else {
          decision = { kind: "fresh", reason: "diverged" }
          recordGone = true
        }
      }
    }

    const continuing = decision.kind === "continue"
    const rendered = decision.kind === "continue" ? continued(request.prompt, groups, decision) : replayed(request.prompt, groups)
    const previous = this.live.get(sessionID)
    const live = continuing ? previous! : await this.create(true)
    if (!continuing) this.live.set(sessionID, live)
    if (live.restricted === undefined) {
      const previous = await this.storedAgent(sessionID)
      live.restricted = previous?.restricted ?? false
      live.unselected = previous?.unselected
    }
    const mode: RunMode = continuing ? (reattached ? "reattached" : "continue") : "fresh"
    const reason = decision.kind === "fresh" ? describeReason(record ? decision.reason : "no-record") : undefined

    let text = ""
    let sent = false
    let engaged = false
    const tools = new Map<string, ToolIdentity>()
    const onUpdate = (update: SessionUpdate) => {
      engaged = true
      if (update.sessionUpdate === "agent_message_chunk") text += contentText((update as { content?: unknown }).content)
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const call = update as ToolCallUpdate
        if (call.toolCallId) {
          const done = (live.done ??= new Set())
          // Vibe replays the transcript on `session/load`; a call it already finished must not be streamed again.
          if (done.has(call.toolCallId)) return
          if (call.status === "completed" || call.status === "failed") done.add(call.toolCallId)
          if (!tools.has(call.toolCallId)) tools.set(call.toolCallId, toolIdentity(call))
        }
      }
      request.onUpdate(update)
    }

    // A new conversation replaces the recorded one only once the turn reached Vibe; until then the old one stays.
    const abandon = async () => {
      if (!continuing) {
        if (previous) this.live.set(sessionID, previous)
        else this.live.delete(sessionID)
        await this.close(live.acpSessionId)
      }
      this.schedule(sessionID)
    }
    const commit = async (reply: string) => {
      await this.save(sessionID, {
        v: 1,
        acpSessionId: live.acpSessionId,
        model: request.modelId,
        cwd: this.options.cwd,
        history: [...groups.map((group) => group.hash), reply],
      })
      if (!continuing) {
        // Close what this turn replaced, but never the conversation that just answered.
        const retired = new Set([recordGone ? undefined : record?.acpSessionId, previous?.acpSessionId])
        retired.delete(live.acpSessionId)
        for (const id of retired) if (id) await this.close(id)
      }
      this.schedule(sessionID)
    }

    let result: PromptResult
    let blocks = rendered.blocks
    try {
      await this.applyConfig(live, request)
      blocks = await this.applyPolicy(live, sessionID, blocks)
      result = await this.client.prompt(live.acpSessionId, blocks, onUpdate, request.signal, () => {
        sent = true
      })
    } catch (error) {
      // An RPC error before Vibe produced anything is a refusal: it did not take the message. Anything else after the
      // request was written (crash, exit, error mid-stream) may have, and replaying it would show Vibe the message twice.
      const delivered = sent && (engaged || !(error instanceof AcpRpcError))
      if (!delivered) {
        await abandon()
        throw error
      }
      await commit(ANY_REPLY)
      throw error
    }

    const finished = result.stopReason === "end_turn" && (text.trim() !== "" || tools.size > 0)
    await commit(finished ? assistantHash(text, [...tools.values()]) : ANY_REPLY)
    return { result, mode, reason, acpSessionId: live.acpSessionId, sent: blocks, warnings: rendered.warnings }
    } finally {
      this.schedule(sessionID)
    }
  }

  private async throwaway(request: RunRequest): Promise<RunOutcome> {
    const live = await this.create(false)
    const rendered = flattenContent(request.prompt)
    try {
      await this.applyConfig(live, request)
      const result = await this.client.prompt(live.acpSessionId, rendered.blocks, request.onUpdate, request.signal)
      return { result, mode: "throwaway", acpSessionId: live.acpSessionId, sent: rendered.blocks, warnings: rendered.warnings }
    } finally {
      await this.close(live.acpSessionId)
    }
  }

  private async create(primary: boolean): Promise<Live> {
    const setup = await this.client.request<SessionSetup>("session/new", { cwd: this.options.cwd, mcpServers: [] })
    // Never let catalog bookkeeping break a request, and skip helper sessions.
    if (primary) {
      try {
        this.options.onChatSession?.()
      } catch (error) {
        this.options.debug?.("onChatSession failed", String(error))
      }
    }
    const mode = modeOf(setup.configOptions) ?? setup.modes?.currentModeId
    return {
      acpSessionId: setup.sessionId,
      generation: this.client.generation,
      // What a new conversation starts with, so an unchanged choice costs no round trip.
      model: setup.configOptions?.find((option) => option.id === MODEL_CONFIG_ID)?.currentValue,
      level: thinkingOf(setup.configOptions)?.default,
      mode,
      // The user's own approval policy, restored after a turn that had to switch to `ask`.
      base: mode,
    }
  }

  /**
   * After a restart (or idle close) the conversation still lives on disk in Vibe; resume it.
   * Vibe answers `-32602 Session not found` for an id it no longer has, so no listing has to be searched;
   * any other failure throws a retryable error and changes nothing.
   */
  private async reattach(sessionID: string, record: SessionRecord): Promise<"ok" | "missing"> {
    try {
      // Vibe answers `{}` (no setup): model, level and mode are unknown until the next turn applies them.
      await this.client.request("session/resume", { sessionId: record.acpSessionId, cwd: this.options.cwd, mcpServers: [] })
    } catch (error) {
      if (sessionNotFound(error)) return "missing"
      throw this.unverified("resume failed", error)
    }
    // Vibe resets model, level and mode on resume, so leave them unknown here and let the next turn re-apply them.
    this.live.set(sessionID, {
      acpSessionId: record.acpSessionId,
      generation: this.client.generation,
    })
    return "ok"
  }

  private unverified(what: string, cause: unknown) {
    this.options.debug?.("reattach unverified", { what, cause: cause === undefined ? undefined : String(cause) })
    const detail = cause instanceof Error ? `: ${cause.message.slice(0, 200)}` : ""
    return new VibeRetryableError(`vibe could not confirm the earlier conversation (${what}${detail}). Nothing was changed; try again.`)
  }

  /**
   * Vibe forgets the chosen model and thinking level after resume, so both are applied whenever they may
   * differ from what the live conversation has. With no level selected the model's own default is applied
   * explicitly: a conversation that ran on "low" must not stay on "low".
   */
  private async applyConfig(live: Live, request: Pick<RunRequest, "modelId" | "thoughtLevel">) {
    if (live.model !== request.modelId) {
      const configured = await this.setConfig(live, MODEL_CONFIG_ID, request.modelId)
      live.model = request.modelId
      // The new model brings its own level.
      live.level = undefined
      // Switching model can reset the session mode (`mistral-medium-latest` does), so repair it when it moved.
      const now = modeOf(configured)
      if (now) live.mode = now
      if (live.mode && now && now !== live.mode) await this.setConfig(live, MODE_CONFIG_ID, live.mode)
    }
    const thinking = this.options.catalog?.(request.modelId)?.thinking
    if (!thinking) return
    const wanted = request.thoughtLevel ?? thinking.default
    if (live.level === wanted) return
    try {
      await this.setConfig(live, THINKING_CONFIG_ID, wanted)
      live.level = wanted
    } catch (error) {
      // Vibe refused this level (the catalog may be stale). The turn is still worth running on whatever level is active.
      if (!(error instanceof AcpRpcError)) throw error
      this.options.debug?.("thinking level rejected", { level: wanted, error: String(error) })
      live.level = undefined
    }
  }

  /**
   * Applies the OpenCode agent governing this session to the Vibe conversation, and returns the blocks to send.
   *
   * Two of OpenCode's three plan-mode pieces cross the ACP boundary here.
   *
   *   - **Permissions** become Vibe's own approval policy. Under `auto-approve` Vibe never emits
   *     `session/request_permission`, so the agent's rules would have nothing to decide; a restricting agent
   *     therefore switches the conversation to `ask`, which is where Vibe's state-changing tools (edit, write_file,
   *     bash, web_fetch) start asking, and `judge` answers each request from the agent's rules.
   *   - **Instructions** become a leading text block. ACP has no channel for a client to set Vibe's system prompt —
   *     Vibe runs its own — so this is the only place the agent's text can reach the model.
   *
   * The third piece, the switch itself, stays the user's: OpenCode does the same, and `instructions.unselected` is
   * sent once on the first turn that runs under a different agent so a conversation that was in plan mode learns it
   * is not any more. That state is persisted, because losing it would leave a resumed conversation believing the old
   * restrictions still hold.
   */
  private async applyPolicy(live: Live, sessionID: string, blocks: ContentBlock[]): Promise<ContentBlock[]> {
    let policy: Policy | undefined
    try {
      policy = await this.options.policy?.(sessionID)
    } catch (error) {
      // A policy that cannot be read must not fail the turn; the conversation keeps the mode it already has.
      this.options.debug?.("policy lookup failed", String(error))
    }

    const restricted = policy !== undefined && restricts(policy.rules)
    if (policy) this.policies.set(live.acpSessionId, policy)
    else this.policies.delete(live.acpSessionId)

    // `base` is the mode Vibe started on (the user's own approval policy), restored once nothing restricts the session.
    const wanted = restricted ? "ask" : live.base
    if (wanted && wanted !== live.mode) {
      try {
        live.mode = modeOf(await this.setConfig(live, MODE_CONFIG_ID, wanted)) ?? wanted
      } catch (error) {
        if (!(error instanceof AcpRpcError)) throw error
        // The turn still runs; the gate is just not in place, which the debug log has to record.
        this.options.debug?.("mode rejected", { mode: wanted, error: String(error) })
        live.mode = undefined
      }
    }

    const previous: Previous = { restricted: live.restricted === true, unselected: live.unselected }
    const text = instructionText(policy, previous)
    live.restricted = restricted
    live.unselected = restricted ? policy?.instructions.unselected : undefined
    if (policy && previous.restricted !== restricted) await this.rememberAgent(sessionID, policy.agent, live)

    return text ? [{ type: "text", text }, ...blocks] : blocks
  }

  /**
   * The agent the previous turn ran under, read back so a restart does not lose the note that plan mode ended. Losing
   * it is not cosmetic: a resumed conversation still carries the old instructions, and without the note Vibe would
   * keep refusing the edits the user has just asked for.
   */
  private async storedAgent(sessionID: string) {
    try {
      const value = await this.store.get(AGENT_PREFIX + sessionID)
      if (!value || typeof value !== "object") return undefined
      const record = value as { v?: unknown; restricted?: unknown; unselected?: unknown }
      if (record.v !== 1 || typeof record.restricted !== "boolean") return undefined
      return {
        restricted: record.restricted,
        unselected: typeof record.unselected === "string" ? record.unselected : undefined,
      }
    } catch (error) {
      this.options.debug?.("agent state read failed", String(error))
      return undefined
    }
  }

  private async rememberAgent(sessionID: string, agent: string, live: Live) {
    try {
      await this.store.set(AGENT_PREFIX + sessionID, {
        v: 1,
        agent,
        restricted: live.restricted === true,
        unselected: live.unselected,
      })
    } catch (error) {
      this.options.debug?.("agent state write failed", String(error))
    }
  }

  /** `session/set_config_option` echoes the whole option list, which is where a mode change becomes visible. */
  private async setConfig(live: Live, configId: string, value: string) {
    const configured = await this.client.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
      sessionId: live.acpSessionId,
      configId,
      value,
    })
    return configured?.configOptions
  }

  private async close(acpSessionId: string) {
    try {
      if (this.client.running) await this.client.request("session/close", { sessionId: acpSessionId })
    } catch (error) {
      this.options.debug?.("close failed", String(error))
    }
  }

  private schedule(sessionID: string) {
    const idle = this.options.idleMs ?? 15 * 60_000
    const live = this.live.get(sessionID)
    if (!live || idle <= 0) return
    clearTimeout(live.timer)
    live.timer = setTimeout(() => {
      this.live.delete(sessionID)
      void this.serialized(sessionID, () => this.close(live.acpSessionId))
    }, idle)
    live.timer.unref?.()
  }

  private stopIdle(sessionID: string) {
    const live = this.live.get(sessionID)
    if (live) clearTimeout(live.timer)
  }

  private async load(sessionID: string): Promise<SessionRecord | undefined> {
    const value = await this.store.get(STORAGE_PREFIX + sessionID)
    return isRecord(value) ? value : undefined
  }

  private save(sessionID: string, record: SessionRecord) {
    return this.store.set(STORAGE_PREFIX + sessionID, record)
  }

  private serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const tail = next.catch(() => {})
    this.locks.set(key, tail)
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
    return next
  }
}

/** `-32602 Session not found` is Vibe's way of saying the recorded conversation is gone. */
function sessionNotFound(error: unknown) {
  if (!(error instanceof AcpRpcError)) return false
  return error.code === -32602 && /session.*not found|not found.*session/i.test(error.message)
}

function continued(prompt: LanguageModelV3Prompt, groups: readonly Group[], decision: Extract<Decision, { kind: "continue" }>): Rendered {
  return userContent(prompt.slice(groups[decision.from]!.start))
}

/** Replay: everything before the trailing run of user messages becomes history. */
function replayed(prompt: LanguageModelV3Prompt, groups: readonly Group[]): Rendered {
  let latest = groups.length
  while (latest > 0 && groups[latest - 1]!.role === "user") latest--
  const start = latest === groups.length ? prompt.length : groups[latest]!.start
  return catchUpContent(prompt, start)
}

function describeReason(reason: string) {
  switch (reason) {
    case "no-record":
      return "no earlier Vibe conversation for this session"
    case "diverged":
      return "history changed (revert, edit, compaction or another model replied) or the earlier conversation is gone"
    case "no-new-input":
      return "prompt has no new user input"
    default:
      return "unexpected message sequence"
  }
}

function isRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<SessionRecord>
  return (
    record.v === 1 &&
    typeof record.acpSessionId === "string" &&
    typeof record.cwd === "string" &&
    typeof record.model === "string" &&
    Array.isArray(record.history) &&
    record.history.every((hash) => typeof hash === "string")
  )
}
