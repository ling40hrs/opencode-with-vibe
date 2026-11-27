import { spawn, type ChildProcess } from "node:child_process"
import {
  AcpRpcError,
  type ContentBlock,
  type JsonObject,
  type PermissionOption,
  type PermissionRequest,
  type PromptResult,
  type SessionUpdate,
  type ToolCallUpdate,
} from "./types"

export interface AcpClientOptions {
  /** Executable to run. Default: `vibe-acp`. */
  command?: string
  /** How to answer `session/request_permission`. Default: allow. */
  permission?: "allow" | "deny"
  cwd?: string
  /** Replaces the whole argument list (tests run a fake agent through this). */
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  /** Debug sink; only called when the plugin's `debug` option is on. */
  debug?: (message: string, data?: unknown) => void
  /** Smallest wait before respawning after a crash. */
  backoffMs?: number
  /** How long spawn + `initialize` may take before the child is killed. Default 60000. */
  startTimeoutMs?: number
  /** Judges a permission request when the plugin knows the session's agent; see `decide`. */
  decide?: PermissionDecider
}

/**
 * Answers one permission request. `undefined` means "no opinion": the static `permission` option decides instead.
 *
 * The agent's request carries only a `toolCallId` (see `PermissionRequest`), so the judgement is made from the
 * `tool_call` update that preceded it — which is why the client keeps one.
 */
export type PermissionDecider = (
  sessionId: string,
  call: ToolCallUpdate | undefined,
) => "allow" | "deny" | "ask"

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }
type UpdateListener = (update: SessionUpdate) => void
type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" }

const MAX_BACKOFF_MS = 10_000
const STABLE_RUN_MS = 30_000

/**
 * One long-lived `vibe-acp` child process speaking newline-delimited JSON-RPC 2.0 on stdio.
 * It starts lazily, answers the agent's own requests (permissions) and routes `session/update`
 * notifications to the listener registered for the session.
 */
export class AcpClient {
  /** Bumped on every spawn. Sessions created on an earlier generation no longer exist in the current process. */
  generation = 0

  private child: ChildProcess | undefined
  private starting: Promise<void> | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<UpdateListener>>()
  private disposed = false
  private failures = 0
  private lastExit = 0
  private startedAt = 0
  private stderrTail = ""
  private closed = true
  /** Assignable after construction: the sessions layer owns the policy and knows the agent per session. */
  decide?: PermissionDecider
  /** The `tool_call` update behind each id, per session. A permission request names only the id. */
  private calls = new Map<string, Map<string, ToolCallUpdate>>()

  constructor(private readonly options: AcpClientOptions = {}) {
    this.decide = options.decide
  }

  get running() {
    return this.child !== undefined && !this.closed
  }

  /** Spawns and initializes the agent if it is not running. Safe to call concurrently. */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("vibe ACP client is disposed"))
    if (this.running && !this.starting) return Promise.resolve()
    this.starting ??= this.spawnAndInitialize().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async request<T = unknown>(method: string, params: JsonObject, signal?: AbortSignal): Promise<T> {
    await this.start()
    return this.send<T>(method, params, signal)
  }

  /**
   * `session/cancel` is a notification in the Vibe dialect: as a request the agent answers `-32601`.
   * `notify` already writes without an id, so `prompt` can use it while every other call stays a request.
   */
  notify(method: string, params: JsonObject) {
    this.write({ jsonrpc: "2.0", method, params })
  }

  /**
   * Sends `session/prompt` and streams the session's updates to `onUpdate` until the result arrives.
   * Aborting the signal sends `session/cancel` and still resolves with the agent's `cancelled` result.
   * `onSent` runs once the request has been written to vibe, so callers can tell "never sent" from "sent, then failed".
   */
  async prompt(
    sessionId: string,
    prompt: readonly ContentBlock[],
    onUpdate: UpdateListener,
    signal?: AbortSignal,
    onSent?: () => void,
  ): Promise<PromptResult> {
    await this.start()
    // A cancel sent before the prompt would outrun the prompt itself and the prompt would run in full.
    if (signal?.aborted) throw abortError()
    const release = this.listen(sessionId, onUpdate)
    const cancel = () => this.notify("session/cancel", { sessionId })
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      return await this.send<PromptResult>("session/prompt", { sessionId, prompt }, undefined, onSent)
    } finally {
      signal?.removeEventListener("abort", cancel)
      release()
    }
  }

  listen(sessionId: string, listener: UpdateListener) {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0 && this.listeners.get(sessionId) === set) this.listeners.delete(sessionId)
    }
  }

  /** Closes stdin so vibe-acp exits cleanly, then kills it if it lingers. */
  async dispose() {
    this.disposed = true
    const child = this.child
    this.rejectAll(new Error("vibe ACP client disposed"))
    if (!child || this.closed) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.stdin?.end()
    const timer = setTimeout(() => this.killProcessTree(child), 3000)
    timer.unref?.()
    await exited
    clearTimeout(timer)
  }

  private async spawnAndInitialize() {
    // Back off after repeated crashes so a broken install does not spin.
    if (this.failures > 0) {
      const delay = Math.min((this.options.backoffMs ?? 500) * 2 ** (this.failures - 1), MAX_BACKOFF_MS)
      const wait = this.lastExit + delay - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      // dispose() may have run while we slept; spawning now would orphan a vibe-acp process nobody will stop.
      if (this.disposed) throw new Error("vibe ACP client is disposed")
    }
    const command = this.options.command ?? "vibe-acp"
    // `vibe-acp` takes no arguments: it is the ACP entry point itself and reads its settings from the cwd.
    const argv = this.options.argv ?? []
    this.options.debug?.("spawn", { command, argv })
    this.stderrTail = ""
    const child = spawn(command, argv, {
      cwd: this.options.cwd,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.closed = false
    this.child = child
    this.generation++
    this.startedAt = Date.now()

    const failed = new Promise<never>((_, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          new Error(
            error.code === "ENOENT"
              ? `vibe executable not found (${command}). Install Mistral Vibe (\`uv tool install mistral-vibe\`) and make sure \`vibe-acp\` is on PATH.`
              : `failed to start ${command}: ${error.message}`,
          ),
        )
      })
    })
    failed.catch(() => {})

    let buffer = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (line) this.handleLine(line)
      }
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    child.stdin?.on("error", () => {})
    child.once("exit", (code, signal) => {
      this.options.debug?.("exit", { code, signal })
      if (this.child !== child) return
      this.closed = true
      this.child = undefined
      this.lastExit = Date.now()
      // A run that stayed up long enough is healthy: the next start gets the base delay instead of a doubled one.
      this.failures = Date.now() - this.startedAt > STABLE_RUN_MS ? 1 : this.failures + 1
      // Only the first line, clamped: this text reaches the user's screen.
      const detail = (this.stderrTail.trim().split(/\r?\n/)[0] ?? "").slice(0, 300)
      this.rejectAll(new Error(`vibe exited unexpectedly (code ${code ?? signal})${detail ? `: ${detail}` : ""}`))
    })

    const timeoutMs = this.options.startTimeoutMs ?? 60_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`vibe did not finish initializing within ${timeoutMs / 1000}s`)), timeoutMs)
    })
    timeout.catch(() => {})

    try {
      // Writing before the OS confirmed the spawn would mask "executable not found" as "not running".
      await Promise.race([new Promise<void>((resolve) => child.once("spawn", () => resolve())), failed, timeout])
      if (this.disposed) throw new Error("vibe ACP client is disposed")
      await Promise.race([
        this.send("initialize", {
          protocolVersion: 1,
          // No fs or terminal capabilities: vibe runs its own tools and never calls back for them.
          clientCapabilities: {},
          clientInfo: { name: "opencode-with-vibe", version: "0.1.1" },
        }),
        failed,
        timeout,
      ])
    } catch (error) {
      // Detach first so the exit handler does not count this failure twice.
      if (this.child === child) this.child = undefined
      this.failures++
      this.lastExit = Date.now()
      this.rejectAll(error instanceof Error ? error : new Error(String(error)))
      this.killProcessTree(child)
      throw error
    } finally {
      clearTimeout(timer)
    }
    this.failures = 0
  }

  private send<T>(method: string, params: JsonObject, signal?: AbortSignal, onSent?: () => void): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const onAbort = () => {
        this.pending.delete(id)
        reject(abortError())
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id)
        signal?.removeEventListener("abort", onAbort)
        reject(new Error(`vibe is not running (${method})`))
        return
      }
      onSent?.()
    })
  }

  private write(message: JsonObject) {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) return false
    this.options.debug?.("out", message)
    stdin.write(JSON.stringify(message) + "\n")
    return true
  }

  private handleLine(line: string) {
    let message: JsonObject
    try {
      message = JSON.parse(line) as JsonObject
    } catch {
      this.options.debug?.("stdout-nonjson", line.slice(0, 200))
      return
    }
    this.options.debug?.("in", message)
    const { id, method } = message as { id?: number | string; method?: string }
    if (method !== undefined && id !== undefined) return this.handleRequest(id, method, message.params)
    if (method !== undefined) {
      if (method === "session/update") this.route(message.params as { sessionId?: string; update?: SessionUpdate })
      return
    }
    if (typeof id !== "number") return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = message.error as { code?: number; message?: string; data?: unknown } | undefined
    if (error) pending.reject(new AcpRpcError(error.code ?? -32000, error.message ?? "unknown error", error.data))
    else pending.resolve(message.result)
  }

  private route(params: { sessionId?: string; update?: SessionUpdate } | undefined) {
    if (!params?.sessionId || !params.update) return
    const update = params.update
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.remember(params.sessionId, update as ToolCallUpdate)
    }
    for (const listener of this.listeners.get(params.sessionId) ?? []) {
      try {
        listener(params.update)
      } catch (error) {
        this.options.debug?.("listener-error", String(error))
      }
    }
  }

  /**
   * Keeps the latest `tool_call` update per id so a permission request can be judged. Vibe describes the call
   * (`_meta.tool_name`, `rawInput`, `locations`) on the update, not on the request, and a request for an id that was
   * never seen is judged as unknown — which the policy answers with "ask", never with a silent allow.
   *
   * Bounded: a long session makes thousands of calls, and only the pending one is ever asked about.
   */
  private remember(sessionId: string, update: ToolCallUpdate) {
    if (!update.toolCallId) return
    const calls = this.calls.get(sessionId) ?? new Map<string, ToolCallUpdate>()
    calls.set(update.toolCallId, { ...calls.get(update.toolCallId), ...update })
    if (calls.size > 500) {
      const oldest = calls.keys().next()
      if (!oldest.done) calls.delete(oldest.value)
    }
    this.calls.set(sessionId, calls)
  }

  private handleRequest(id: number | string, method: string, params: unknown) {
    if (method === "session/request_permission") {
      const request = params as PermissionRequest
      const effect = this.decide?.(request.sessionId, this.calls.get(request.sessionId)?.get(request.toolCall?.toolCallId ?? ""))
      // No opinion, or a policy that wants the session default: the option from the config decides.
      const mode = effect === "allow" || effect === "deny" ? effect : (this.options.permission ?? "allow")
      const outcome = choosePermission(request, mode)
      this.options.debug?.("permission", {
        tool: request.toolCall?.toolCallId,
        asked: effect,
        answered: mode,
        outcome,
      })
      // Vibe reads a nested `outcome` object; a flat `{outcome, optionId}` is ignored and the call hangs.
      this.write({ jsonrpc: "2.0", id, result: { outcome } })
      return
    }
    // vibe-acp never needs client-side fs/terminal when those capabilities are not advertised.
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
  }

  private rejectAll(error: Error) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const item of pending) item.reject(error)
  }

  private killProcessTree(child: ChildProcess) {
    if (this.closed) return
    child.kill()
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    }
  }
}

/**
 * Picks the permission outcome. Exported for tests.
 * Vibe offers `allow_once`, `allow_always` (twice: session and permanent) and `reject_once` — no `reject_always`,
 * so a denial falls back to `cancelled` only when the agent offers no reject option at all.
 *
 * Approval is deliberately one-time: `allow_always_permanent` writes standing approval into the user's Vibe
 * config, which a plugin that auto-answers every request must not do. So `allow_once` wins over any `allow_always`,
 * and the permanent variant is only ever picked when no other allow option exists at all.
 */
export function choosePermission(request: PermissionRequest, mode: "allow" | "deny"): PermissionOutcome {
  const options = request.options ?? []
  const find = (...kinds: string[]): PermissionOption | undefined => {
    for (const kind of kinds) {
      const match = options.find((option) => option.kind === kind)
      if (match) return match
    }
    return undefined
  }
  const findAllow = () =>
    // An exact `allow_once` id first; anything reject-related with that id is not reachable here.
    options.find((option) => option.optionId === "allow_once") ??
    find("allow_once") ??
    // Last resort: any allow option, but never the one that persists approval in the user's config.
    options.find((option) => option.kind === "allow_always" && option.optionId !== "allow_always_permanent")
  const choice = mode === "allow" ? findAllow() : find("reject_once")
  if (!choice) return { outcome: "cancelled" }
  return { outcome: "selected", optionId: choice.optionId }
}

function abortError() {
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}
