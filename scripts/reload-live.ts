/**
 * Live check of the "vibe ACP client is disposed" fix against the real `vibe`: a model instance OpenCode cached during
 * one plugin generation must keep working after a hot reload replaced that generation.
 *
 * Runs three real prompts on the user's subscription (cheap models). The host below reproduces what OpenCode does
 * with AI SDK models (core/src/aisdk.ts `sdks` / `languages`): it builds the SDK once and keeps every language model
 * it ever created, across plugin reloads.
 *
 *   bun run scripts/reload-live.ts
 *   RELOAD_MODEL=claude-sonnet-4-6 bun run scripts/reload-live.ts
 */
import type { LanguageModelV3, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { createPlugin } from "../src/plugin"
import { KIND_HEADER, SESSION_HEADER } from "../src/model"
import { assistant, readAll, user } from "../test/helpers"

type Ctx = Parameters<Plugin.Plugin["setup"]>[0]

class Host {
  private sdkHooks = new Set<(event: { sdk?: any }) => void>()
  private sdk: { languageModel(id: string): LanguageModelV3 } | undefined
  private languages = new Map<string, LanguageModelV3>()
  readonly store = new Map<string, unknown>()
  private cleanups: (() => Promise<void>)[] = []

  constructor(readonly directory: string) {}

  private ctx(): Ctx {
    return {
      options: { permission: "allow" },
      location: { directory: this.directory },
      storage: {
        get: async (key: string) => this.store.get(key),
        set: async (key: string, value: unknown) => void this.store.set(key, structuredClone(value)),
      },
      provider: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
      aisdk: {
        hook: async (_name: string, callback: (event: { sdk?: any }) => void) => {
          this.sdkHooks.add(callback)
          return { dispose: async () => void this.sdkHooks.delete(callback) }
        },
      },
      session: { hook: async () => ({ dispose: async () => {} }) },
    } as unknown as Ctx
  }

  async load() {
    const cleanup = (await createPlugin().setup(this.ctx())) as () => Promise<void>
    this.cleanups.push(cleanup)
    return cleanup
  }

  /** Like `aisdk.ts`: the SDK and every language model are created once and never replaced. */
  model(id: string): LanguageModelV3 {
    if (!this.sdk) {
      const event: { sdk?: any } = {}
      for (const hook of this.sdkHooks) hook(event)
      this.sdk = event.sdk
    }
    let language = this.languages.get(id)
    if (!language) {
      language = this.sdk!.languageModel(id)
      this.languages.set(id, language)
    }
    return language
  }

  async teardown() {
    await Promise.all(this.cleanups.splice(0).map((cleanup) => cleanup().catch(() => {})))
  }
}

/** One turn as OpenCode issues it: full prompt, session headers, and a model instance from the cache. */
async function ask(host: Host, id: string, prompt: LanguageModelV3Prompt, sessionID: string) {
  const { stream } = await host.model(id).doStream({
    prompt,
    headers: { [KIND_HEADER]: "primary", [SESSION_HEADER]: sessionID },
  })
  const parts: LanguageModelV3StreamPart[] = await readAll(stream)
  const failure = parts.find((part) => part.type === "error") as { error?: Error } | undefined
  if (failure?.error) throw failure.error
  if (!parts.some((part) => part.type === "finish")) throw new Error(`${id}: stream ended without a finish part`)
  return parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
}

const directory = mkdtempSync(join(tmpdir(), "vibe-reload-live-"))
const host = new Host(directory)
const gemini = "gemini-3.8-flash"
const other = process.env.RELOAD_MODEL ?? "gpt-oss-120b-medium"

try {
  console.log(`workspace: ${directory}\nswitching to: ${other}\n`)
  const cleanup1 = await host.load()
  host.model(gemini) // cached by generation 1, exactly as OpenCode would

  const first = await ask(host, gemini, [user("Reply with exactly: pong")], "ses_live_reload")
  console.log(`1. ${gemini} before the reload: ${JSON.stringify(first)}`)

  // hot reload: generation 1 is torn down, generation 2 is set up; OpenCode's caches stay as they are
  await cleanup1()
  await host.load()

  const continued = await ask(
    host,
    gemini,
    [user("Reply with exactly: pong"), assistant(first), user("What did I ask you first?")],
    "ses_live_reload",
  )
  console.log(`2. ${gemini} after the reload, same session: ${JSON.stringify(continued)}`)

  const switched = await ask(host, other, [user("Reply with exactly: ok")], "ses_live_switch")
  console.log(`3. ${other} in a new session: ${JSON.stringify(switched)}`)
  console.log("\nno disposed-client error")
} finally {
  await host.teardown()
}
