import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { AcpRpcError } from "./acp/types"
import { finishPart, UpdateConverter } from "./convert"
import { usageLedger } from "./usage"
import { PROVIDER_ID as CATALOG_PROVIDER_ID, requestedLevel, THOUGHT_LEVEL_KEY, type CatalogModel } from "./models"
import type { RunOutcome, RunRequest } from "./sessions"

export const PROVIDER_ID = CATALOG_PROVIDER_ID
/** Set by the `model.request` hook in plugin.ts. */
export const KIND_HEADER = "x-opencode-with-vibe-kind"
/** Set by OpenCode itself on every request. */
export const SESSION_HEADER = "x-opencode-session-id"

export interface ModelDependencies {
  run: (request: RunRequest) => Promise<RunOutcome>
  /** The catalog entry of a base model, used to check the requested thinking level. */
  model?: (modelId: string) => CatalogModel | undefined
  /** Records the context window Vibe reported in `usage_update.size`, so the catalog can show it. */
  learn?: (modelId: string, context: number) => void
}

/**
 * The thinking level a request asks for (from the selected variant's settings, which OpenCode delivers under
 * `providerOptions.vibe`), checked against what Vibe offers for the model. A bad level is dropped with a warning,
 * so the model's default applies instead of the request failing.
 */
export function resolveLevel(
  modelId: string,
  options: LanguageModelV3CallOptions["providerOptions"],
  lookup?: ModelDependencies["model"],
): { level?: string; warning?: SharedV3Warning } {
  const requested = requestedLevel(options?.[PROVIDER_ID])
  if (requested === undefined || requested === null || requested === "") return {}
  const level = String(requested)
  if (!lookup) return { level }
  const thinking = lookup(modelId)?.thinking
  if (!thinking) {
    return {
      warning: {
        type: "unsupported",
        feature: THOUGHT_LEVEL_KEY,
        details: `Model "${modelId}" has no thinking levels in Vibe; "${level}" was ignored.`,
      },
    }
  }
  if (!thinking.levels.includes(level)) {
    return {
      warning: {
        type: "unsupported",
        feature: THOUGHT_LEVEL_KEY,
        details: `Thinking level "${level}" is not offered for "${modelId}" (available: ${thinking.levels.join(", ")}); using the default "${thinking.default}".`,
      },
    }
  }
  return { level }
}

export class VibeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = PROVIDER_ID
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    private readonly dependencies: ModelDependencies,
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options)
    const content: LanguageModelV3Content[] = []
    const text = new Map<string, string>()
    const reasoning = new Map<string, string>()
    const warnings: SharedV3Warning[] = []
    let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined
    const reader = stream.getReader()
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      const part = next.value
      switch (part.type) {
        case "stream-start":
          warnings.push(...part.warnings)
          break
        case "text-start":
          text.set(part.id, "")
          break
        case "text-delta":
          text.set(part.id, (text.get(part.id) ?? "") + part.delta)
          break
        case "text-end":
          content.push({ type: "text", text: text.get(part.id) ?? "" })
          break
        case "reasoning-start":
          reasoning.set(part.id, "")
          break
        case "reasoning-delta":
          reasoning.set(part.id, (reasoning.get(part.id) ?? "") + part.delta)
          break
        case "reasoning-end":
          content.push({ type: "reasoning", text: reasoning.get(part.id) ?? "" })
          break
        case "tool-call":
        case "tool-result":
          content.push(part)
          break
        case "finish":
          finish = part
          break
        case "error":
          throw part.error
      }
    }
    if (!finish) throw new Error("vibe stream ended without a finish part")
    return { content, finishReason: finish.finishReason, usage: finish.usage, warnings }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController()
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    const headers = options.headers ?? {}
    const primary = headers[KIND_HEADER] === "primary"
    // Usage is cumulative per session, so the ledger is looked up per session, not per stream.
    const state = usageLedger(headers[SESSION_HEADER])
    const converter = new UpdateConverter({
      state,
      onContext: (size) => this.dependencies.learn?.(this.modelId, size),
    })
    let cancelled = false
    let task: Promise<void> = Promise.resolve()

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        const emit = (parts: LanguageModelV3StreamPart[]) => {
          if (cancelled) return
          for (const part of parts) controller.enqueue(part)
        }
        const warnings: SharedV3Warning[] = []
        if (primary && (options.tools?.length ?? 0) > 0) {
          warnings.push({
            type: "unsupported",
            feature: "tools",
            details: "Vibe runs its own tools; OpenCode's tools, MCP servers and agents are not offered to it.",
          })
        }
        const thinking = resolveLevel(this.modelId, options.providerOptions, this.dependencies.model)
        if (thinking.warning) warnings.push(thinking.warning)
        emit([{ type: "stream-start", warnings }, { type: "response-metadata", modelId: this.modelId }])

        // `Promise.resolve().then` so that a dependency that throws instead of rejecting still ends the stream cleanly.
        task = Promise.resolve()
          .then(() =>
            this.dependencies.run({
              sessionID: headers[SESSION_HEADER],
              primary,
              modelId: this.modelId,
              thoughtLevel: thinking.level,
              prompt: options.prompt,
              signal,
              onUpdate: (update) => emit(converter.push(update)),
            }),
          )
          .then(
            (outcome) => {
              emit([
                ...converter.close(),
                finishPart(outcome.result, { conversationId: outcome.acpSessionId, mode: outcome.mode }, state),
              ])
              if (!cancelled) controller.close()
            },
            (error: unknown) => {
              if (cancelled) return
              emit(converter.close())
              if (signal.aborted) {
                // Stopped before Vibe took the prompt: end the step cleanly, like a cancelled prompt.
                emit([finishPart({ stopReason: "cancelled" })])
              } else {
                emit([{ type: "error", error: friendlyError(error) }, finishPart({ stopReason: "error" })])
              }
              controller.close()
            },
          )
      },
      cancel: () => {
        cancelled = true
        abort.abort()
        return task
      },
    })
    return { stream }
  }
}

/** Short, actionable messages for the failures users actually hit. */
export function friendlyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof AcpRpcError && /auth|log ?in|sign ?in|credential|unauthenticated|token|expired/i.test(message)) {
    return new Error(`vibe is not signed in: run \`vibe\` once in a terminal to sign in. (${message})`)
  }
  if (error instanceof Error && error.name !== "Error") return error
  return new Error(message.startsWith("vibe") ? message : `vibe: ${message}`)
}
