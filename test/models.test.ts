import { describe, expect, test, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CATALOG, PROVIDER_PACKAGE, toModel } from "../src/models"
import { mirrorProbeHome, readOptions } from "../src/plugin"

describe("model catalog", () => {
  test("the provider package is an aisdk tag", () => {
    expect(PROVIDER_PACKAGE.startsWith("aisdk:")).toBe(true)
  })

  test("models are free, agentic, accept images and return text", () => {
    for (const entry of DEFAULT_CATALOG) {
      const model = toModel(entry)
      expect(String(model.providerID)).toBe("vibe")
      expect(model.cost).toEqual([])
      expect(model.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
      expect(model.limit.output).toBe(0)
    }
  })

  test("the default catalog is the four real Vibe base models, with their real thinking levels", () => {
    expect(DEFAULT_CATALOG.map((model) => model.id)).toEqual([
      "mistral-large-4-0",
      "mistral-medium-latest",
      "zai-glm-5-3",
      "zai-glm-5-3-flash",
    ])
    expect(DEFAULT_CATALOG.map((model) => model.thinking?.levels)).toEqual([
      ["low", "medium", "high"],
      ["off", "high"],
      ["low", "high", "max"],
      ["low", "high", "max"],
    ])
  })

  test("context windows are the one window vibe reports until a session states the real one", () => {
    const limit = (id: string) => toModel({ id, name: id }).limit.context
    expect(limit("mistral-large-4-0")).toBe(202_144)
    expect(limit("zai-glm-5-3")).toBe(202_144)
    expect(toModel({ id: "m", name: "M", context: 400_000 }).limit.context).toBe(400_000)
  })
})

describe("plugin options", () => {
  test("permission defaults to allow", () => {
    expect(readOptions(undefined)).toEqual({ permission: "allow" })
  })

  test("only permission is read; anything else is ignored", () => {
    expect(readOptions({ permission: "deny" })).toEqual({ permission: "deny" })
    expect(readOptions({ permission: "whatever", command: "C:\\vibe.exe", debug: "x.log" })).toEqual({ permission: "allow" })
  })

  test("an explicit probeHome option is honoured as-is", () => {
    expect(readOptions({ permission: "allow", probeHome: "C:\\probe-home" })).toEqual({ permission: "allow", probeHome: "C:\\probe-home" })
  })
})

describe("mirrorProbeHome: the probe runs on a copy of the real home, never the real home", () => {
  const previous = process.env.VIBE_HOME
  const created: string[] = []
  afterEach(() => {
    if (previous === undefined) delete process.env.VIBE_HOME
    else process.env.VIBE_HOME = previous
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const makeHome = () => {
    const home = mkdtempSync(join(tmpdir(), "vibe-mirror-test-"))
    created.push(home)
    writeFileSync(join(home, "config.toml"), "active_model = \"mistral-large-4-0\"\n")
    writeFileSync(join(home, "experiment_eval_cache.json"), "{}")
    writeFileSync(join(home, "session.lock"), "")
    for (const volatile of ["logs", "cache", "locks", "skills-registry-cache"]) {
      mkdirSync(join(home, volatile))
      writeFileSync(join(home, volatile, "noise"), "x")
    }
    return home
  }

  test("copies the state the probe needs, skips volatile entries and *.lock, and uses a fresh temp dir", () => {
    const home = makeHome()
    process.env.VIBE_HOME = home
    const mirror = mirrorProbeHome()!
    created.push(mirror)
    expect(mirror).not.toBe(home)
    expect(existsSync(join(mirror, "config.toml"))).toBe(true)
    expect(existsSync(join(mirror, "experiment_eval_cache.json"))).toBe(true)
    expect(existsSync(join(mirror, "session.lock"))).toBe(false)
    for (const volatile of ["logs", "cache", "locks", "skills-registry-cache"]) {
      expect(existsSync(join(mirror, volatile))).toBe(false)
    }
    // The real home is left untouched.
    expect(existsSync(join(home, "config.toml"))).toBe(true)
  })

  test("a missing real home yields undefined (the caller falls back to an empty temp home)", () => {
    process.env.VIBE_HOME = join(tmpdir(), "vibe-mirror-does-not-exist-12345")
    expect(mirrorProbeHome()).toBeUndefined()
  })
})
