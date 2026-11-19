import { afterEach, describe, expect, test } from "bun:test"
import { createCatalog, discoverOnce, readCatalog, serializeCatalog } from "../src/catalog"
import { resolveLevel } from "../src/model"
import { DEFAULT_CATALOG, THOUGHT_LEVEL_KEY, toModel, type CatalogModel } from "../src/models"
import { probeCatalog, thinkingOf } from "../src/probe"
import {
  FAKE_CATALOG,
  assistant,
  fakeClient,
  fakeEnv,
  harness,
  memoryStore,
  methods,
  primaryHeaders,
  run,
  setControl,
  user,
  variant,
} from "./helpers"

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})
function setup(env = fakeEnv(), store = memoryStore(), options: Parameters<typeof harness>[2] = {}) {
  const h = harness(env, store, options)
  open.push(h)
  return { env, ...h }
}
/** Config calls the plugin sent, as `configId=value`. */
const configCalls = (env: ReturnType<typeof fakeEnv>) =>
  methods(env, "session/set_config_option").map((entry) => `${entry.params.configId}=${entry.params.value}`)
const warningsOf = (parts: Awaited<ReturnType<typeof run>>["parts"]) => {
  const start = parts.find((part) => part.type === "stream-start")
  return start && start.type === "stream-start" ? start.warnings : []
}

describe("catalog: thinking levels are variants of one base model", () => {
  test("each base model is one OpenCode model; levels become variants carrying thoughtLevel", () => {
    const large = toModel(FAKE_CATALOG[0]!)
    expect(String(large.id)).toBe("mistral-large-4-0")
    expect(JSON.parse(JSON.stringify(large.variants))).toEqual([
      { id: "low", settings: { thoughtLevel: "low" } },
      { id: "medium", settings: { thoughtLevel: "medium" } },
      { id: "high", settings: { thoughtLevel: "high" } },
    ])
    expect(THOUGHT_LEVEL_KEY).toBe("thoughtLevel")
  })

  test("models without a thinking option get no variants", () => {
    const bare: CatalogModel = { id: "some-model", name: "Some Model" }
    expect(toModel(bare).variants.length).toBe(0)
    expect(toModel({ ...bare, thinking: { levels: [], default: "" } }).variants.length).toBe(0)
  })

  test("the static fallback lists the real base models only, never per-level ids", () => {
    expect(DEFAULT_CATALOG.map((model) => model.id)).toEqual([
      "mistral-large-4-0",
      "mistral-medium-latest",
      "zai-glm-5-3",
      "zai-glm-5-3-flash",
    ])
    expect(toModel(DEFAULT_CATALOG[0]!).variants.map((v) => String(v.id))).toEqual(["low", "medium", "high"])
  })

  test("levels differ per model", () => {
    expect(toModel(FAKE_CATALOG[1]!).variants.map((v) => String(v.id))).toEqual(["off", "high"])
    expect(toModel(FAKE_CATALOG[2]!).variants.map((v) => String(v.id))).toEqual(["low", "high", "max"])
  })
})

describe("resolveLevel: variant settings arrive as providerOptions.vibe", () => {
  const lookup = (id: string) => FAKE_CATALOG.find((model) => model.id === id)

  test("nothing selected -> nothing to apply", () => {
    expect(resolveLevel("mistral-large-4-0", undefined, lookup)).toEqual({})
    expect(resolveLevel("mistral-large-4-0", { vibe: {} }, lookup)).toEqual({})
  })

  test("a level the model offers passes through; thinking, thinkingLevel and thought_level are aliases", () => {
    expect(resolveLevel("mistral-large-4-0", variant("medium"), lookup)).toEqual({ level: "medium" })
    // `thinking` is the ACP config id; as a providerOptions key it is only an alias for thoughtLevel
    expect(resolveLevel("mistral-large-4-0", { vibe: { thinking: "low" } }, lookup)).toEqual({ level: "low" })
    expect(resolveLevel("mistral-large-4-0", { vibe: { thinkingLevel: "low" } }, lookup)).toEqual({ level: "low" })
    expect(resolveLevel("mistral-large-4-0", { vibe: { thought_level: "low" } }, lookup)).toEqual({ level: "low" })
    expect(resolveLevel("mistral-large-4-0", { vibe: { thoughtLevel: "low", thinking: "high" } }, lookup)).toEqual({ level: "low" })
  })

  test("an unknown level is dropped with a warning that names the valid ones and the default", () => {
    const result = resolveLevel("mistral-large-4-0", variant("xhigh"), lookup)
    expect(result.level).toBeUndefined()
    expect(result.warning).toMatchObject({ type: "unsupported", feature: "thoughtLevel" })
    expect((result.warning as any).details).toMatch(/"xhigh".*low, medium, high.*default "high"/)
  })

  test("a model without thinking levels, or an unknown model, ignores the level with a warning", () => {
    expect(resolveLevel("some-model", variant("low"), lookup).warning).toBeDefined()
    expect(resolveLevel("brand-new-model", variant("low"), lookup).warning).toBeDefined()
  })

  test("options for other providers are not ours", () => {
    expect(resolveLevel("mistral-large-4-0", { other: { thoughtLevel: "low" } }, lookup)).toEqual({})
  })
})

describe("applying the level to the vibe conversation", () => {
  test("a new conversation applies the model once, then re-applies the model default level", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    const one = await run(model("mistral-large-4-0"), [user("script:config")])
    expect(one.text).toBe("cfg:mistral-large-4-0/high")
    // on model apply, the plugin intentionally re-applies the model default level for deterministic state
    expect(configCalls(env)).toEqual(["model=mistral-large-4-0", "thinking=high"])
  })

  test("switching between variants applies each change once", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    const large = () => model("mistral-large-4-0")
    const a = await run(large(), [user("script:config")], primaryHeaders(), undefined, variant("medium"))
    expect(a.text).toBe("cfg:mistral-large-4-0/medium")
    const b = await run(large(), [user("script:config"), assistant(a.text), user("script:config")], primaryHeaders(), undefined, variant("low"))
    expect(b.text).toBe("cfg:mistral-large-4-0/low")
    const c = await run(
      large(),
      [user("script:config"), assistant(a.text), user("script:config"), assistant(b.text), user("script:config")],
      primaryHeaders(),
      undefined,
      variant("medium"),
    )
    expect(c.text).toBe("cfg:mistral-large-4-0/medium")
    // the model is applied once (the first turn); each level change after that is sent exactly once
    expect(configCalls(env)).toEqual(["model=mistral-large-4-0", "thinking=medium", "thinking=low", "thinking=medium"])
  })

  test("another base model brings its own default level, which is applied explicitly", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    const one = await run(model("mistral-medium-latest"), [user("script:config")])
    expect(one.text).toBe("cfg:mistral-medium-latest/high")
    expect(configCalls(env)).toEqual(["model=mistral-medium-latest", "thinking=high"])
  })

  test("switching model forgets the old level: the same level name must still be applied on the new model", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    const one = await run(model("mistral-large-4-0"), [user("script:config")], primaryHeaders(), undefined, variant("high"))
    expect(one.text).toBe("cfg:mistral-large-4-0/high")
    // zai-glm-5-3 resets to its own default ("max"), so asking for "high" has to reach vibe even though "high" was the level before
    const two = await run(
      model("zai-glm-5-3"),
      [user("script:config"), assistant(one.text), user("script:config")],
      primaryHeaders(),
      undefined,
      variant("high"),
    )
    expect(two.text).toBe("cfg:zai-glm-5-3/high")
    // changing the model drops whatever level was current, so "high" is applied again on the new model
    expect(configCalls(env)).toEqual(["model=mistral-large-4-0", "thinking=high", "model=zai-glm-5-3", "thinking=high"])
  })

  test("when the cached catalog offers a level but live controls don't, the level attempt is tolerated without warning", async () => {
    const env = fakeEnv()
    // a real model whose thinking option the agent does not offer
    setControl(env, { noThinking: true })
    const { model } = setup(env)
    const result = await run(model("mistral-large-4-0"), [user("script:config")], primaryHeaders(), undefined, variant("low"))
    expect(configCalls(env)).toEqual(["model=mistral-large-4-0", "thinking=low"])
    // the level is considered valid by catalog; a live rejection is swallowed and does not surface as an OpenCode warning
    expect(warningsOf(result.parts)).toHaveLength(0)
    expect(result.text).toBe("cfg:mistral-large-4-0/low")
  })

  test("an invalid level is ignored with a warning and the model's default is not re-sent", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    const result = await run(model("mistral-large-4-0"), [user("script:config")], primaryHeaders(), undefined, variant("xhigh"))
    expect(warningsOf(result.parts)).toMatchObject([{ type: "unsupported", feature: "thoughtLevel" }])
    expect(result.text).toBe("cfg:mistral-large-4-0/high")
    // the default is applied explicitly when the model changes, so the level is sent once (not twice)
    expect(configCalls(env)).toEqual(["model=mistral-large-4-0", "thinking=high"])
  })

  test("a level vibe itself rejects (stale catalog) does not fail the turn, and a later valid level still applies", async () => {
    const env = fakeEnv()
    const stale: CatalogModel = { id: "mistral-large-4-0", name: "x", thinking: { levels: ["low", "ultra"], default: "high" } }
    const { model } = setup(env, memoryStore(), { catalog: () => stale })
    const bad = await run(model("mistral-large-4-0"), [user("script:config")], primaryHeaders(), undefined, variant("ultra"))
    expect(bad.text).toBe("cfg:mistral-large-4-0/high")
    expect(bad.parts.some((part) => part.type === "error")).toBe(false)
    const good = await run(
      model("mistral-large-4-0"),
      [user("script:config"), assistant(bad.text), user("script:config")],
      primaryHeaders(),
      undefined,
      variant("low"),
    )
    expect(good.text).toBe("cfg:mistral-large-4-0/low")
  })

  test("after a restart the model and the selected level are applied again", async () => {
    const env = fakeEnv()
    const store = memoryStore()
    const first = setup(env, store)
    const one = await run(first.model("mistral-large-4-0"), [user("script:config")], primaryHeaders(), undefined, variant("low"))
    await first.close()
    const second = setup(env, store)
    const two = await run(
      second.model("mistral-large-4-0"),
      [user("script:config"), assistant(one.text), user("script:config")],
      primaryHeaders(),
      undefined,
      variant("low"),
    )
    expect(second.outcomes[0]!.mode).toBe("reattached")
    expect(two.text).toBe("cfg:mistral-large-4-0/low")
    expect(configCalls(env)).toEqual(["model=mistral-large-4-0", "thinking=low", "model=mistral-large-4-0", "thinking=low"])
  })

  test("after a restart without a variant the default is applied, not whatever the conversation had", async () => {
    const env = fakeEnv()
    const store = memoryStore()
    const first = setup(env, store)
    const one = await run(first.model("mistral-large-4-0"), [user("script:config")], primaryHeaders(), undefined, variant("low"))
    await first.close()
    const second = setup(env, store)
    const two = await run(second.model("mistral-large-4-0"), [user("script:config"), assistant(one.text), user("script:config")])
    expect(two.text).toBe("cfg:mistral-large-4-0/high")
    expect(configCalls(env).slice(2)).toEqual(["model=mistral-large-4-0", "thinking=high"])
  })

  test("helper requests (title, compaction) honour the variant too", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    await run(
      model("mistral-large-4-0"),
      [user("script:config")],
      { "x-opencode-with-vibe-kind": "title", "x-opencode-session-id": "ses_1" },
      undefined,
      variant("low"),
    )
    expect(outcomes[0]!.mode).toBe("throwaway")
    expect(configCalls(env)).toEqual(["model=mistral-large-4-0", "thinking=low"])
  })
})

describe("catalog discovery (no prompts)", () => {
  test("probeCatalog reads every base model's levels and default from the scratch session and closes it", async () => {
    const env = fakeEnv()
    const client = fakeClient(env)
    open.push({ close: () => client.dispose() })
    const models = await probeCatalog(client, "C:\\work")
    expect(models).toEqual(FAKE_CATALOG)
    expect(methods(env, "session/prompt")).toHaveLength(0)
    expect(methods(env, "session/new")).toHaveLength(1)
    expect(methods(env, "session/close")).toHaveLength(1)
    expect(configCalls(env)).toEqual([
      "model=mistral-large-4-0",
      "model=mistral-medium-latest",
      "model=zai-glm-5-3",
      "model=zai-glm-5-3-flash",
    ])
  })

  test("thinkingOf reads levels and the current value as the default", () => {
    expect(
      thinkingOf([{ id: "thinking", name: "Thinking", category: "thinking", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }] }]),
    ).toEqual({ levels: ["low", "medium"], default: "medium" })
    // the category alone is enough, as an id match would be
    expect(thinkingOf([{ id: "x", category: "thinking", currentValue: "max", options: [{ value: "low" }, { value: "max" }] }])).toEqual({
      levels: ["low", "max"],
      default: "max",
    })
    expect(thinkingOf([{ id: "model" }])).toBeUndefined()
    expect(thinkingOf([{ id: "thinking", options: [] }])).toBeUndefined()
    expect(thinkingOf(undefined)).toBeUndefined()
  })

  test("a refreshed catalog changes the variants OpenCode shows, and is persisted in the versioned layout", async () => {
    const saved: unknown[] = []
    const catalog = createCatalog([...DEFAULT_CATALOG], async (next) => void saved.push(serializeCatalog(next)))
    const discovered: CatalogModel[] = [
      ...DEFAULT_CATALOG.map((model) =>
        model.id === "mistral-medium-latest" ? { ...model, thinking: { levels: ["low", "high"], default: "low" } } : model,
      ),
      { id: "brand-new-model", name: "Brand New Model" },
    ]
    catalog.update(discovered)
    expect(catalog.current().map((model) => toModel(model).variants.map((v) => String(v.id)))).toEqual([
      ["low", "medium", "high"],
      ["low", "high"],
      ["low", "high", "max"],
      ["low", "high", "max"],
      [],
    ])
    await Bun.sleep(10)
    expect(saved).toHaveLength(1)
    expect(readCatalog(saved[0])).toEqual(discovered)
    catalog.update(discovered)
    await Bun.sleep(10)
    expect(saved).toHaveLength(1)
  })

  test("a refreshed catalog never drops a model the current list knows, but accepts new ones", async () => {
    const saved: unknown[] = []
    const logs: string[] = []
    const catalog = createCatalog(
      [
        { id: "a", name: "A", thinking: { levels: ["low", "high"], default: "high" } },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
        { id: "d", name: "D" },
      ],
      async (next) => void saved.push(serializeCatalog(next)),
      (message) => logs.push(message),
    )
    // A probe run against an empty/reduced home reports only a subset; that must not replace the full list.
    catalog.update([{ id: "a", name: "A" }])
    await Bun.sleep(10)
    expect(catalog.current().map((model) => model.id)).toEqual(["a", "b", "c", "d"])
    expect(saved).toHaveLength(0)
    expect(logs).toEqual(["catalog update rejected: would drop b, c, d"])

    // Dropping one id is rejected the same way.
    catalog.update([{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }])
    await Bun.sleep(10)
    expect(catalog.current().map((model) => model.id)).toEqual(["a", "b", "c", "d"])
    expect(saved).toHaveLength(0)
    expect(logs).toEqual(["catalog update rejected: would drop b, c, d", "catalog update rejected: would drop d"])

    // An equal list is a no-op: the old rule (identical lists are not persisted) still applies without a rejection.
    catalog.update([
      { id: "a", name: "A", thinking: { levels: ["low", "high"], default: "high" } },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
      { id: "d", name: "D" },
    ])
    await Bun.sleep(10)
    expect(saved).toHaveLength(0)
    expect(logs).toHaveLength(2)

    // A superset (a new Vibe release) is accepted and persisted.
    const superset: CatalogModel[] = [
      { id: "a", name: "A", thinking: { levels: ["low", "high"], default: "high" } },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
      { id: "d", name: "D" },
      { id: "e", name: "E" },
    ]
    catalog.update(superset)
    await Bun.sleep(10)
    expect(catalog.current().map((model) => model.id)).toEqual(["a", "b", "c", "d", "e"])
    expect(saved).toHaveLength(1)
    expect(readCatalog(saved[0])).toEqual(superset)
    expect(logs).toHaveLength(2)
  })

  test("readCatalog rejects anything but the current, well-formed layout", () => {
    expect(readCatalog(undefined)).toBeUndefined()
    expect(readCatalog([{ id: "a", name: "A" }])).toBeUndefined()
    expect(readCatalog({ v: 1, models: [{ id: "a", name: "A" }] })).toBeUndefined()
    expect(readCatalog({ v: 2, models: [{ id: 5 }] })).toBeUndefined()
    expect(readCatalog({ v: 2, models: [{ id: "a", name: "A", thinking: { levels: [], default: "x" } }] })).toEqual([{ id: "a", name: "A" }])
    expect(readCatalog({ v: 2, models: [{ id: "a", name: "A", thinking: { levels: ["low", "high"], default: "nope" } }] })).toEqual([
      { id: "a", name: "A", thinking: { levels: ["low", "high"], default: "high" } },
    ])
  })

  test("discoverOnce runs the probe once, applies a non-empty result, and retries after a failure", async () => {
    const applied: number[] = []
    const logs: string[] = []
    let calls = 0
    const trigger = discoverOnce(
      async () => {
        calls++
        if (calls === 1) throw new Error("vibe not ready")
        return [{ id: "a", name: "A" }]
      },
      (models) => applied.push(models.length),
      (message) => logs.push(message),
    )
    trigger()
    trigger() // already running
    await Bun.sleep(10)
    expect(logs).toEqual(["model discovery failed"])
    trigger() // retried after the failure
    trigger()
    await Bun.sleep(10)
    trigger() // done: never again
    await Bun.sleep(10)
    expect(calls).toBe(2)
    expect(applied).toEqual([1])
  })

  test("the chat conversation triggers discovery; helper sessions do not", async () => {
    const env = fakeEnv()
    let triggered = 0
    const { model } = setup(env, memoryStore(), { onChatSession: () => void triggered++ })
    await run(model(), [user("title please")], { "x-opencode-with-vibe-kind": "title", "x-opencode-session-id": "ses_1" })
    expect(triggered).toBe(0)
    await run(model(), [user("hello")])
    expect(triggered).toBe(1)
  })
})
