// Regression tests for the "vibe ACP client is disposed" bug: OpenCode keeps SDKs and language models across plugin
// reloads (core/src/aisdk.ts `sdks`/`languages` maps are never cleared), so a model created by an older plugin
// generation must still reach the live runtime, and reloads must never leave two vibe processes behind.
import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { createPlugin } from "../src/plugin"
import { install, peek, resolve, runtimeKey, type Runtime } from "../src/runtime"
import { VibeRetryableError } from "../src/sessions"
import { assistant, fakeClient, fakeEnv, methods, primaryHeaders, received, run, user, type FakeEnv } from "./helpers"
import type { AcpClient } from "../src/acp/client"

type Ctx = Parameters<Plugin.Plugin["setup"]>[0]

/** Just enough of OpenCode: plugin hooks, and the never-invalidated SDK / language-model caches of core/src/aisdk.ts. */
class FakeOpenCode {
  private sdkHooks = new Set<(event: { sdk?: any }) => void>()
  private sdk: { languageModel(id: string): LanguageModelV3 } | undefined
  private languages = new Map<string, LanguageModelV3>()
  readonly store = new Map<string, unknown>()
  readonly clients: AcpClient[] = []
  private cleanups: (() => Promise<void>)[] = []

  constructor(
    readonly env: FakeEnv,
    readonly directory: string,
  ) {}

  private ctx(): Ctx {
    return {
      options: {},
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

  /** Runs one plugin generation's setup. Returns its cleanup, which is also remembered for test teardown. */
  async load(): Promise<() => Promise<void>> {
    const plugin = createPlugin({
      createClient: (options) => {
        const client = fakeClient(this.env, { cwd: options.cwd, backoffMs: 1 })
        this.clients.push(client)
        return client
      },
    })
    const cleanup = (await plugin.setup(this.ctx())) as () => Promise<void>
    this.cleanups.push(cleanup)
    return cleanup
  }

  /** Like core/src/aisdk.ts `language()`: the SDK and each language model are created once and kept forever. */
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
    await Promise.all(this.clients.map((client) => client.dispose()))
  }
}

const hosts: FakeOpenCode[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.teardown()))
})
function host(env = fakeEnv()) {
  const created = new FakeOpenCode(env, env.dir)
  hosts.push(created)
  return created
}
const ask = (opencode: FakeOpenCode, modelID: string, prompt: Parameters<typeof run>[1]) =>
  run(opencode.model(modelID) as never, prompt, primaryHeaders("ses_reload"))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const livePids = (env: FakeEnv) => received(env).filter((entry) => entry.event === "started").map((entry) => entry.pid as number).filter(alive)
async function settle(env: FakeEnv, expected: number) {
  for (let i = 0; i < 60 && livePids(env).length !== expected; i++) await Bun.sleep(50)
  return livePids(env).length
}
const errorOf = (parts: Awaited<ReturnType<typeof run>>["parts"]) => (parts.find((part) => part.type === "error") as any)?.error as Error

describe("a plugin reload", () => {
  test("a language model cached before the reload keeps working after it (the reported bug)", async () => {
    const opencode = host()
    const cleanup1 = await opencode.load()
    const first = await ask(opencode, "mistral-medium-latest", [user("hello")])
    expect(first.text).toBe("ok-1")

    // hot reload: the old generation is torn down, a new one is set up; OpenCode's caches stay as they are
    await cleanup1()
    await opencode.load()

    const second = await ask(opencode, "mistral-medium-latest", [user("hello"), assistant(first.text), user("again")])
    expect(errorOf(second.parts)?.message).toBeUndefined()
    expect(second.text).toBe("ok-2")
  })

  test("the same conversation continues on the new generation: resumed, not recreated", async () => {
    const opencode = host()
    const cleanup1 = await opencode.load()
    const first = await ask(opencode, "mistral-medium-latest", [user("hello")])
    await cleanup1()
    await opencode.load()
    await ask(opencode, "mistral-medium-latest", [user("hello"), assistant(first.text), user("again")])
    // (one more `session/new` is the prompt-free model discovery probe, which sends no prompt)
    const prompted = methods(opencode.env, "session/prompt")
    expect(prompted.map((entry) => entry.params.prompt[0].text)).toEqual(["hello", "again"])
    expect(new Set(prompted.map((entry) => entry.params.sessionId)).size).toBe(1)
    expect(methods(opencode.env, "session/resume").map((entry) => entry.params.sessionId)).toEqual([prompted[0].params.sessionId])
  })

  test("a model that was never used before the reload works too, including when switching model in a session", async () => {
    const opencode = host()
    const cleanup1 = await opencode.load()
    const first = await ask(opencode, "mistral-large-4-0", [user("hello")])
    await cleanup1()
    await opencode.load()
    const second = await ask(opencode, "mistral-medium-latest", [user("hello"), assistant(first.text), user("script:config")])
    // after a model switch, the plugin intentionally reapplies the model's default thinking level
    expect(second.text).toBe("cfg:mistral-medium-latest/high")
  })

  test("only one vibe process is alive afterwards, whichever order cleanup and setup run in", async () => {
    for (const order of ["cleanup-first", "setup-first"] as const) {
      const opencode = host()
      const cleanup1 = await opencode.load()
      const first = await ask(opencode, "mistral-medium-latest", [user("hello")])
      if (order === "cleanup-first") {
        await cleanup1()
        await opencode.load()
      } else {
        await opencode.load()
        await cleanup1()
      }
      const second = await ask(opencode, "mistral-medium-latest", [user("hello"), assistant(first.text), user("again")])
      expect(second.text).toBe("ok-2")
      expect(await settle(opencode.env, 1)).toBe(1)
    }
  })

  test("a generation whose cleanup never ran is retired by its successor, so no process is orphaned", async () => {
    const opencode = host()
    await opencode.load()
    const first = await ask(opencode, "mistral-medium-latest", [user("hello")])
    expect(livePids(opencode.env)).toHaveLength(1)
    await opencode.load() // no cleanup for generation 1
    const second = await ask(opencode, "mistral-medium-latest", [user("hello"), assistant(first.text), user("again")])
    expect(second.text).toBe("ok-2")
    expect(opencode.clients[0]!.running).toBe(false)
    expect(await settle(opencode.env, 1)).toBe(1)
  })

  test("a request that arrives while the plugin is unloaded fails with an actionable, retryable message", async () => {
    const opencode = host()
    const cleanup1 = await opencode.load()
    await ask(opencode, "mistral-medium-latest", [user("hello")])
    await cleanup1()
    const failed = await ask(opencode, "mistral-medium-latest", [user("hello again")])
    const error = errorOf(failed.parts)
    expect(error.name).toBe("VibeRetryableError")
    expect(error.message).toMatch(/not active.*Reload the OpenCode configuration or restart OpenCode/)
    expect(failed.parts.at(-1)?.type).toBe("finish")
    expect(await settle(opencode.env, 0)).toBe(0)
  })

  test("a setup that fails leaves no runtime and no process behind", async () => {
    const opencode = host()
    const plugin = createPlugin({
      createClient: (options) => {
        const client = fakeClient(opencode.env, { cwd: options.cwd })
        opencode.clients.push(client)
        return client
      },
    })
    const ctx = (opencode as any).ctx() as Ctx
    ;(ctx as any).session.hook = async () => {
      throw new Error("host refused the hook")
    }
    await expect(plugin.setup(ctx)).rejects.toThrow(/host refused the hook/)
    expect(peek(runtimeKey("opencode-with-vibe", opencode.directory))).toBeUndefined()
    expect(opencode.clients[0]!.running).toBe(false)
  })

  test("two projects have separate runtimes: reloading one does not touch the other", async () => {
    const a = host()
    const b = host()
    const cleanupA = await a.load()
    await b.load()
    const first = await ask(b, "mistral-medium-latest", [user("hello")])
    await cleanupA()
    await a.load()
    const second = await ask(b, "mistral-medium-latest", [user("hello"), assistant(first.text), user("again")])
    expect(second.text).toBe("ok-2")
    expect(methods(b.env, "session/resume")).toHaveLength(0)
    expect(b.clients[0]!.running).toBe(true)
  })
})

describe("runtime registry", () => {
  const fake = (): Runtime & { disposals: number } => {
    let disposed = false
    const runtime = {
      disposals: 0,
      run: async () => {
        throw new Error("not used")
      },
      model: () => undefined,
      learn: () => {},
      disposed: () => disposed,
      dispose: async () => {
        disposed = true
        runtime.disposals++
      },
    }
    return runtime
  }

  test("installing a second runtime retires the first; the first one's late cleanup does not evict the second", async () => {
    const key = runtimeKey("t", `registry-${Math.random()}`)
    const one = fake()
    const two = fake()
    const releaseOne = install(key, one)
    const releaseTwo = install(key, two)
    await Bun.sleep(10)
    expect(one.disposals).toBe(1)
    expect(resolve(key)).toBe(two)
    await releaseOne()
    expect(resolve(key)).toBe(two)
    await releaseTwo()
    expect(peek(key)).toBeUndefined()
  })

  test("resolve explains itself when nothing is installed or the runtime is already disposed", async () => {
    const key = runtimeKey("t", `registry-${Math.random()}`)
    expect(() => resolve(key)).toThrow(VibeRetryableError)
    expect(() => resolve(key)).toThrow(/not active/)
    const gone = fake()
    install(key, gone)
    await gone.dispose()
    expect(() => resolve(key)).toThrow(/reloading/)
    expect(peek(key)).toBeUndefined()
  })
})
