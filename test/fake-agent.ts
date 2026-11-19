// A scripted stand-in for `vibe-acp` 3.1.3: NDJSON JSON-RPC on stdio.
// The behaviour of a prompt is chosen by a `script:<name>` marker in the prompt text (last one wins).
// FAKE_VIBE_LOG   - file that receives one JSON line per request/notification/response seen from the client
// FAKE_VIBE_STATE - file standing in for vibe's on-disk conversations (survives process restarts)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const LOG = process.env.FAKE_VIBE_LOG
const STATE = process.env.FAKE_VIBE_STATE
const CONTROL = process.env.FAKE_VIBE_CONTROL

/** The working directory reported by `session/list` unless the test overrides it (`FAKE_VIBE_CWD`). */
const CWD = process.env.FAKE_VIBE_CWD ?? "C:\\work"
/** `usage_update.size`: the context window Vibe reports for the model a conversation runs on. */
const CONTEXT_WINDOW = 202_144

type Conversation = { prompts: number; model: string; level?: string; mode?: string }
const disk: Record<string, Conversation> = STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}
const live = new Map<string, Conversation>()
const cancels = new Map<string, () => void>()
const waiters = new Map<number, (message: any) => void>()
let nextRequest = 1000

/** Fault injection, re-read on every use so tests can flip it between requests. */
const control = (): Record<string, any> => (CONTROL && existsSync(CONTROL) ? JSON.parse(readFileSync(CONTROL, "utf8")) : {})
const log = (entry: unknown) => LOG && appendFileSync(LOG, JSON.stringify(entry) + "\n")
const save = () => STATE && writeFileSync(STATE, JSON.stringify(disk))
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n")
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result })
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message, data: null } })
const update = (sessionId: string, body: Record<string, unknown>) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The real vibe-acp 3.1.3 catalog. The model list is the same for every session; the thinking levels (and their
// defaults) depend on the selected model. `mistral-medium-latest` offers only `off`/`high`; the rest offer three.
type Base = { name: string; levels: string[]; fallback: string }
const BASE: Record<string, Base> = {
  "mistral-large-4-0": { name: "Mistral Large 4", levels: ["low", "medium", "high"], fallback: "high" },
  "mistral-medium-latest": { name: "Mistral Medium 3.5", levels: ["off", "high"], fallback: "high" },
  "zai-glm-5-3": { name: "GLM 5.3 (Mistral Hosted)", levels: ["low", "high", "max"], fallback: "max" },
  "zai-glm-5-3-flash": { name: "GLM 5.3 Flash (Mistral Hosted)", levels: ["low", "high", "max"], fallback: "high" },
}
const MODELS = Object.entries(BASE).map(([value, model]) => ({ value, name: model.name, description: value }))
const MODES = [
  { id: "ask", name: "Ask", description: "Requires approval for tool executions" },
  { id: "accept-edits", name: "Accept Edits", description: "Auto-approves file edits only" },
  {
    id: "smart-approve",
    name: "Smart Approve",
    description: "Classifies each tool call and auto-runs the safe ones, prompting only for risky ones",
  },
  { id: "auto-approve", name: "Auto Approve", description: "Auto-approves all tool executions" },
]
const FRESH = (): Conversation => ({ prompts: 0, model: "zai-glm-5-3", level: "max", mode: "accept-edits" })

const select = (id: string, name: string, category: string, currentValue: string, options: { value: string; name?: string }[]) => ({
  currentValue,
  options,
  id,
  name,
  category,
  type: "select",
})

function configOptions(c: Conversation) {
  const levels = control().noThinking ? [] : BASE[c.model]!.levels
  return [
    select("mode", "Session Mode", "mode", c.mode ?? "accept-edits", MODES.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description }))),
    select("model", "Model", "model", c.model, MODELS),
    ...(levels.length
      ? [
          select(
            "thinking",
            "Thinking",
            "thinking",
            c.level ?? BASE[c.model]!.fallback,
            levels.map((value) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) })),
          ),
        ]
      : []),
  ]
}

async function newSession(sessionId: string, conversation: Conversation) {
  update(sessionId, {
    used: 0,
    size: CONTEXT_WINDOW,
    _meta: { steps: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, tokensPerSecond: 0, lastTurnDuration: 0, lastTurnTotalTokens: 0 },
    sessionUpdate: "usage_update",
  })
  return {
    sessionId,
    modes: { currentModeId: conversation.mode ?? "accept-edits", availableModes: MODES },
    configOptions: configOptions(conversation),
    _meta: { workspace_trust: { status: "untrusted", details: null } },
  }
}

function request(method: string, params: unknown) {
  const id = nextRequest++
  send({ jsonrpc: "2.0", id, method, params })
  return new Promise<any>((resolve) => waiters.set(id, resolve))
}

/** A Vibe tool call: identity lives in `toolCallId`, the internal name in `_meta.tool_name`; there is no top-level `name`. */
const toolCall = (status: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: status === "pending" || status === "in_progress" ? "tool_call" : "tool_call_update",
  toolCallId: "call_1",
  title: "bash: cat a.txt",
  kind: "execute",
  status,
  rawInput: { command: "cat a.txt" },
  _meta: { tool_name: "bash", effect_kind: "shell" },
  ...extra,
})

/** Vibe's usage: `inputTokens` already counts `cachedReadTokens`, and `totalTokens == inputTokens + outputTokens`. */
const usage = () => ({ totalTokens: 105, inputTokens: 100, outputTokens: 5, cachedReadTokens: 50 })

async function prompt(id: unknown, params: any) {
  const sessionId: string = params.sessionId
  const conversation = live.get(sessionId)
  if (!conversation) return fail(id, -32602, `Session not found: ${sessionId}`)
  if ((conversation as { running?: boolean }).running) return fail(id, -32603, "A turn is already running")
  const text: string = (params.prompt ?? []).map((block: any) => block.text ?? "").join("\n")
  const script = [...text.matchAll(/script:([a-z-]+)/g)].at(-1)?.[1] ?? "echo"
  // A refusal that arrives before vibe has taken the message (no echo, nothing recorded).
  if (script === "reject") return fail(id, -32000, "not authenticated: please log in")
  conversation.prompts++
  disk[sessionId] = conversation
  save()
  update(sessionId, { sessionUpdate: "session_info_update", title: text.split("\n")[0]?.slice(0, 60) ?? "", updatedAt: new Date().toISOString() })
  update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, messageId: crypto.randomUUID() })
  update(sessionId, {
    used: 100,
    size: CONTEXT_WINDOW,
    sessionUpdate: "usage_update",
    _meta: { steps: 0, promptTokens: 100, completionTokens: 0, cachedTokens: 50, totalTokens: 100, tokensPerSecond: 0, lastTurnDuration: 0, lastTurnTotalTokens: 0 },
  })
  const chunk = (value: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } })

  switch (script) {
    case "config":
      chunk(`cfg:${conversation.model}/${conversation.level}`)
      return reply(id, { stopReason: "end_turn", usage: usage() })
    case "mixed":
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } })
      chunk("before ")
      update(sessionId, toolCall("in_progress"))
      update(sessionId, toolCall("pending"))
      update(sessionId, toolCall("in_progress"))
      update(sessionId, {
        ...toolCall("completed", {
          rawOutput: { stdout: "", stderr: "", output: "", truncated: false },
          content: [
            { type: "content", content: { type: "text", text: "hi\n" } },
            { type: "diff", path: "/C:/work/a.txt", newText: "hi\n" },
          ],
        }),
      })
      update(sessionId, toolCall("completed", { rawOutput: { stdout: "", stderr: "", output: "", truncated: false } }))
      chunk("after")
      return reply(id, { stopReason: "end_turn", usage: usage() })
    case "fail-tool":
      update(sessionId, toolCall("in_progress"))
      update(
        sessionId,
        toolCall("failed", {
          content: [{ type: "content", content: { type: "text", text: "boom" } }],
          rawOutput: { stdout: "", stderr: "boom\n", output: "", truncated: false },
        }),
      )
      chunk("failed")
      return reply(id, { stopReason: "end_turn", usage: usage() })
    case "permission": {
      const response = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call_1" },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_always", name: "Allow for remainder of this session", kind: "allow_always" },
          { optionId: "allow_always_permanent", name: "Always allow", kind: "allow_always" },
          { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ],
      })
      chunk(`permission:${JSON.stringify(response.result?.outcome ?? response.error)}`)
      return reply(id, { stopReason: "end_turn", usage: usage() })
    }
    case "unknown-request": {
      const response = await request("fs/read_text_file", { sessionId, path: "x" })
      chunk(`unknown:${response.error?.code}`)
      return reply(id, { stopReason: "end_turn", usage: usage() })
    }
    case "slow": {
      chunk("partial")
      const cancelled = new Promise<void>((resolve) => cancels.set(sessionId, resolve))
      await Promise.race([cancelled, sleep(10_000)])
      cancels.delete(sessionId)
      // Like vibe: a cancelled turn still reports the usage it had reached.
      return reply(id, { stopReason: "cancelled", usage: usage() })
    }
    case "hold":
      log({ event: "hold-start", sessionId, at: Date.now() })
      ;(conversation as { running?: boolean }).running = true
      await sleep(250)
      delete (conversation as { running?: boolean }).running
      log({ event: "hold-end", sessionId, at: Date.now() })
      chunk("held")
      return reply(id, { stopReason: "end_turn", usage: usage() })
    case "rpc-error":
      return fail(id, -32000, "not authenticated: please log in")
    case "error-after-chunk":
      chunk("started")
      return fail(id, -32000, "quota exceeded halfway")
    case "array-content":
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "ab" }, { type: "text", text: "cd" }] })
      return reply(id, { stopReason: "end_turn", usage: usage() })
    case "crash-noisy":
      process.stderr.write("E".repeat(1000) + "\nsecond line that must not be shown\n")
      await sleep(20)
      process.exit(3)
    // eslint-disable-next-line no-fallthrough
    case "crash":
      chunk("dying")
      await sleep(20)
      process.exit(1)
    // eslint-disable-next-line no-fallthrough
    case "max-tokens":
      chunk("cut")
      return reply(id, { stopReason: "max_tokens", usage: usage() })
    default:
      chunk(`ok-${conversation.prompts}`)
      return reply(id, { stopReason: "end_turn", usage: usage() })
  }
}

const sessions = () =>
  Object.entries(disk)
    .filter(([, conversation]) => conversation.prompts > 0)
    .map(([sessionId]) => ({ sessionId, cwd: CWD, title: "t", updatedAt: new Date().toISOString() }))

log({ event: "started", pid: process.pid })

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  log({ direction: "in", ...message })
  if (message.method === undefined) {
    waiters.get(message.id)?.(message)
    waiters.delete(message.id)
    return
  }
  const { id, method, params } = message
  switch (method) {
    case "initialize":
      if (control().hangInit) return
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, fork: {}, close: {} },
        },
        authMethods: [{ id: "browser-auth", name: "Sign in through Mistral AI Studio" }],
        agentInfo: { name: "@mistralai/mistral-vibe", title: "Mistral Vibe", version: "3.1.3" },
      })
    case "session/new": {
      const sessionId = crypto.randomUUID()
      const fresh = FRESH()
      live.set(sessionId, fresh)
      return newSession(sessionId, fresh).then((setup) => reply(id, setup))
    }
    case "session/resume": {
      if (control().failResume) return fail(id, -32000, "resume exploded")
      // A resumed conversation keeps its history but starts from the default model and thinking level.
      const previous = disk[params.sessionId]
      // Vibe knows only the conversations it still has on disk; anything else is `Session not found`.
      if (!previous) return fail(id, -32602, `Session not found: ${params.sessionId}`)
      const resumed = { ...FRESH(), prompts: previous.prompts }
      live.set(params.sessionId, resumed)
      // Like vibe, a resume answers only the mode and config options; the usage update goes out right after.
      return newSession(params.sessionId, resumed).then(({ modes, configOptions, _meta }) => reply(id, { modes, configOptions, _meta }))
    }
    case "session/list": {
      const c = control()
      if (c.failList) return fail(id, -32000, "list exploded")
      if (c.endlessPages) return reply(id, { sessions: [], nextCursor: String(Number(params.cursor ?? 0) + 1) })
      // Vibe filters by `cwd` and has no cursor: one call answers everything.
      const filtered = sessions().filter((session) => !params.cwd || session.cwd === params.cwd)
      return reply(id, { sessions: filtered })
    }
    case "session/set_config_option": {
      const c = live.get(params.sessionId)
      if (!c) return fail(id, -32602, "Session not found")
      if (params.configId === "model") {
        if (!BASE[params.value]) return fail(id, -32602, `Unknown model: ${params.value}. Available: ${Object.keys(BASE).join(", ")}`)
        c.model = params.value
        c.level = BASE[params.value]!.fallback
      } else if (params.configId === "thinking") {
        if (!BASE[c.model]!.levels.includes(params.value))
          return fail(id, -32602, `Thinking level "${params.value}" is not offered for model "${BASE[c.model]!.name}"`)
        c.level = params.value      } else if (params.configId === "mode") {
        if (!MODES.some((mode) => mode.id === params.value)) return fail(id, -32602, `Invalid mode: ${params.value}`)
        c.mode = params.value
      } else return fail(id, -32602, `Unsupported config option ${params.configId}='${params.value}'`)
      return reply(id, { configOptions: configOptions(c) })
    }
    case "session/close":
      live.delete(params.sessionId)
      return reply(id, {})
    case "session/cancel":
      // A notification, not a request: no reply (real vibe answers -32601 when asked as a request).
      cancels.get(params.sessionId)?.()
      return
    case "session/prompt":
      void prompt(id, params)
      return
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
})
