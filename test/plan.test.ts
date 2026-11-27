// Plan mode is three pieces of OpenCode that never cross the ACP boundary on their own: the agent's instructions, its
// permission rules, and the user's switch. These tests cover the two the plugin reconstructs — the rules that decide a
// Vibe permission request, and the text that carries the agent's instructions into a turn — plus the wire behaviour
// against the fake agent: the conversation is switched to `ask` while a restricting agent is active, the rules answer
// the request, and the mode comes back when the agent changes.
import { afterEach, describe, expect, test } from "bun:test"
import {
  actionOfCall,
  decide,
  instructionText,
  instructionsOf,
  matches,
  pathOf,
  policyOf,
  restricts,
  rulesOf,
  type Policy,
} from "../src/plan"
import { assistant, fakeEnv, harness, memoryStore, methods, run, user, type FakeEnv } from "./helpers"

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})
function setup(env: FakeEnv = fakeEnv(), store = memoryStore(), options: Parameters<typeof harness>[2] = {}) {
  const h = harness(env, store, options)
  open.push(h)
  return Object.assign(h, { env })
}

/** What OpenCode's Plan agent is on the machine this was written on: everything allowed, edits and fetches denied. */
const PLAN_RULES = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "question", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
]
const PLAN_TEXT = "You are in Plan mode. Do not modify any files. Tell the user to switch agents if they ask you to."
const planPolicy = (rules = PLAN_RULES, selected = PLAN_TEXT): Policy => ({
  agent: "plan",
  rules,
  instructions: { selected, unselected: "You are no longer in Plan mode. The earlier restrictions no longer apply." },
})
/** The `build` agent: `* * allow`, no instructions. Nothing to enforce, so nothing is switched or injected. */
const buildPolicy = (): Policy => ({ agent: "build", rules: [{ action: "*", resource: "*", effect: "allow" }], instructions: {} })

const modeCalls = (env: FakeEnv) =>
  methods(env, "session/set_config_option")
    .filter((entry) => entry.params.configId === "mode")
    .map((entry) => entry.params.value)
const sentText = (outcome: { sent: { type: string; text?: string }[] }) => outcome.sent[0]?.text ?? ""
const lastText = (outcome: { sent: { type: string; text?: string }[] }) => outcome.sent.at(-1)?.text ?? ""

describe("matches", () => {
  test("a bare star spans separators, because absolute paths are matched too", () => {
    expect(matches("*", "/home/ling/project/src/a.ts")).toBe(true)
    expect(matches("*.env", "/home/ling/project/.env")).toBe(true)
    expect(matches("*.env", "a.env")).toBe(true)
  })

  test("a pattern without a star is an exact match, never a prefix", () => {
    expect(matches("edit", "edit")).toBe(true)
    expect(matches("edit", "edits")).toBe(false)
    expect(matches("git status", "git status")).toBe(true)
  })

  test("a command rule keeps its shape: `git status *` does not reach `git push`", () => {
    expect(matches("git status *", "git status --short")).toBe(true)
    expect(matches("git status *", "git push --force")).toBe(false)
    expect(matches("Remove-Item*", "Remove-Item -Recurse .")).toBe(true)
  })

  test("regex metacharacters in a resource are literal", () => {
    expect(matches("a+b(c)", "a+b(c)")).toBe(true)
    expect(matches("a+b(c)", "aab(c)")).toBe(false)
  })
})

describe("decide", () => {
  test("the last matching rule wins, which is how a later allow narrows an earlier deny", () => {
    const rules = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "/work/plan/*", effect: "allow" },
    ]
    expect(decide(rules, "edit", "/work/plan/a.md")).toBe("allow")
    expect(decide(rules, "edit", "/work/src/a.ts")).toBe("deny")
  })

  test("a later deny takes the permission away again, as the Plan agent's own rule list does", () => {
    const rules = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "/work/plan/*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
    ]
    expect(decide(rules, "edit", "/work/plan/a.md")).toBe("deny")
  })

  test("nothing matching asks rather than allows", () => {
    expect(decide([{ action: "edit", resource: "*", effect: "deny" }], "shell", "rm -rf /")).toBe("ask")
    expect(decide([], "shell", "ls")).toBe("ask")
  })

  test("a resource under the project directory is tested relative to it as well", () => {
    const rules = [{ action: "edit", resource: ".git/*", effect: "deny" }]
    expect(decide(rules, "edit", "/work/.git/HEAD", "/work")).toBe("deny")
    expect(decide(rules, "edit", "/work/src/a.ts", "/work")).toBe("ask")
  })

  test("a wildcard action rule catches a tool the mapping has no name for", () => {
    expect(decide(PLAN_RULES, "browser", "open")).toBe("allow")
    expect(decide(PLAN_RULES, "edit", "/work/a.ts")).toBe("deny")
  })

  test("an unknown effect is treated as ask, not as allow", () => {
    expect(decide([{ action: "*", resource: "*", effect: "review" }], "shell", "ls")).toBe("ask")
  })
})

describe("restricts", () => {
  test("a fully permissive agent constrains nothing, so a session keeps Vibe's own policy", () => {
    expect(restricts([{ action: "*", resource: "*", effect: "allow" }])).toBe(false)
    expect(restricts(PLAN_RULES)).toBe(true)
    expect(restricts([])).toBe(false)
  })
})

describe("instructionText", () => {
  test("a restricting agent's text is marked with the agent it came from", () => {
    const text = instructionText(planPolicy(), { restricted: false })
    expect(text).toStartWith("[OpenCode agent: plan]")
    expect(text).toContain(PLAN_TEXT)
  })

  test("a restricting agent with no text of its own still says why a tool was refused", () => {
    const text = instructionText(planPolicy(PLAN_RULES, ""), { restricted: false })
    expect(text).toContain("restricted by the OpenCode agent \"plan\"")
    expect(text).toContain("Do not repeat a rejected tool call")
  })

  test("a permissive agent injects nothing, so a normal Vibe turn is untouched", () => {
    expect(instructionText(buildPolicy(), { restricted: false })).toBeUndefined()
  })

  test("the note that plan mode ended goes out once, on the first turn after the switch", () => {
    const was = { restricted: true, unselected: "You are no longer in Plan mode. The earlier restrictions no longer apply." }
    expect(instructionText(buildPolicy(), was)).toBe("You are no longer in Plan mode. The earlier restrictions no longer apply.")
    // The next turn carries the user's text alone: the note is sent once, not every turn.
    expect(instructionText(buildPolicy(), { restricted: false })).toBeUndefined()
  })

  test("an agent with no unselected text says nothing when the user switches away", () => {
    expect(instructionText({ agent: "build", rules: [], instructions: {} }, { restricted: true })).toBeUndefined()
  })
})

describe("reading an agent", () => {
  test("instructions and rules survive the shape the API returns", () => {
    const info = {
      id: "plan",
      permissions: [...PLAN_RULES, { action: "edit", effect: "deny" }, "nonsense", null],
      instructions: { selected: PLAN_TEXT, unselected: 42 },
    }
    expect(rulesOf(info)).toHaveLength(PLAN_RULES.length)
    expect(instructionsOf(info)).toEqual({ selected: PLAN_TEXT })
  })

  test("an agent with nothing readable yields no policy rather than an empty one", () => {
    expect(policyOf(undefined)).toBeUndefined()
    expect(policyOf({ id: "plan" })).toEqual({ agent: "plan", rules: [], instructions: {} })
  })

  test("session rules are appended, so they narrow the agent instead of replacing it", () => {
    const policy = policyOf({ id: "plan", permissions: PLAN_RULES }, [{ action: "shell", resource: "*", effect: "deny" }])
    expect(policy?.rules.at(-1)).toEqual({ action: "shell", resource: "*", effect: "deny" })
    expect(decide(policy!.rules, "shell", "rm -rf /")).toBe("deny")
    expect(decide(policy!.rules, "read", "/work/a.ts")).toBe("allow")
  })
})

describe("mapping a Vibe tool call to an OpenCode action", () => {
  test("the internal tool name wins over the coarse ACP kind", () => {
    expect(actionOfCall({ kind: "execute", _meta: { tool_name: "edit" }, rawInput: { file_path: "/w/a.ts" } })).toEqual({
      action: "edit",
      resource: "/w/a.ts",
    })
  })

  test("a shell call is judged by its command line, which is what the rules speak in", () => {
    expect(actionOfCall({ _meta: { tool_name: "bash" }, rawInput: { command: "git status" } })).toEqual({
      action: "shell",
      resource: "git status",
    })
  })

  test("web tools are `webfetch`, so a denied fetch is denied here too", () => {
    expect(actionOfCall({ _meta: { tool_name: "web_fetch" }, rawInput: { url: "https://x.dev" } })).toEqual({
      action: "webfetch",
      resource: "https://x.dev",
    })
  })

  test("an unknown tool keeps its own name instead of borrowing a permissive action", () => {
    expect(actionOfCall({ _meta: { tool_name: "browser" } })).toEqual({ action: "browser", resource: "" })
    expect(actionOfCall({ kind: "fetch", rawInput: { url: "https://x.dev" } })).toEqual({ action: "webfetch", resource: "https://x.dev" })
  })

  test("the path comes from the tool's own input first, then from the ACP locations", () => {
    expect(pathOf({ rawInput: { file_path: "/w/a.ts" } })).toBe("/w/a.ts")
    expect(pathOf({ locations: [{ path: "/w/b.ts" }] })).toBe("/w/b.ts")
    expect(pathOf({})).toBeUndefined()
  })
})

describe("plan mode over ACP", () => {
  test("a restricting agent switches the conversation to ask and carries its instructions", async () => {
    const { model, env, outcomes } = setup(fakeEnv(), memoryStore(), { policy: async () => planPolicy() })
    await run(model(), [user("script:echo hello")])
    expect(modeCalls(env)).toEqual(["ask"])
    expect(sentText(outcomes[0]!)).toStartWith("[OpenCode agent: plan]")
    expect(sentText(outcomes[0]!)).toContain(PLAN_TEXT)
    // The user's own message still follows the injected block, unchanged.
    expect(outcomes[0]!.sent.at(-1)).toEqual({ type: "text", text: "script:echo hello" })
  })

  test("a permissive agent injects nothing and leaves the mode Vibe started on", async () => {
    const { model, env, outcomes } = setup(fakeEnv(), memoryStore(), { policy: async () => buildPolicy() })
    await run(model(), [user("script:echo hello")])
    expect(modeCalls(env)).toEqual([])
    expect(outcomes[0]!.sent).toEqual([{ type: "text", text: "script:echo hello" }])
  })

  test("a denied tool call is refused once, never granted a standing approval", async () => {
    const { model, env } = setup(fakeEnv(), memoryStore(), { policy: async () => planPolicy() })
    const { text } = await run(model(), [user("script:permission-write")])
    expect(text).toContain('"optionId":"reject_once"')
    expect(text).not.toContain("allow_always")
    // An edit is denied by the Plan agent's own rules, not by the plugin's opinion.
    expect(decide(PLAN_RULES, "edit", "C:\\work\\notes.md")).toBe("deny")
    expect(modeCalls(env)).toEqual(["ask"])
  })

  test("an allowed tool call is approved once, so nothing is written to the user's Vibe config", async () => {
    const { model } = setup(fakeEnv(), memoryStore(), { policy: async () => planPolicy() })
    const { text } = await run(model(), [user("script:permission-call")])
    expect(text).toContain('"optionId":"allow_once"')
  })

  test("a rule that asks is refused, because the ACP client has no one to ask", async () => {
    const asking = planPolicy([
      { action: "*", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "ask" },
    ])
    const { model } = setup(fakeEnv(), memoryStore(), { policy: async () => asking })
    const { text } = await run(model(), [user("script:permission-call")])
    expect(text).toContain('"optionId":"reject_once"')
  })

  test("a request for a call that was never described is refused, not approved", async () => {
    // `script:permission` asks about `call_1` without ever describing it.
    const { model } = setup(fakeEnv(), memoryStore(), { policy: async () => planPolicy() })
    const { text } = await run(model(), [user("script:permission")])
    expect(text).toContain('"optionId":"reject_once"')
  })

  test("switching agents sends the note once and restores the mode Vibe started on", async () => {
    let agent: Policy = planPolicy()
    const { model, env, outcomes } = setup(fakeEnv(), memoryStore(), { policy: async () => agent })
    const one = await run(model(), [user("script:echo one")])
    agent = buildPolicy()
    await run(model(), [user("script:echo one"), assistant(one.text), user("script:echo two")])
    expect(sentText(outcomes[1]!)).toStartWith("You are no longer in Plan mode.")
    expect(modeCalls(env)).toEqual(["ask", "accept-edits"])
    // Only once: the next turn carries the user's text and nothing else.
    const three = await run(model(), [
      user("script:echo one"),
      assistant(one.text),
      user("script:echo two"),
      assistant(lastText(outcomes[1]!)),
      user("script:echo three"),
    ])
    expect(three.text).toBeString()
    expect(modeCalls(env)).toEqual(["ask", "accept-edits"])
  })

  test("the note survives a restart, so a resumed conversation does not think it is still in plan mode", async () => {
    const env = fakeEnv()
    let agent: Policy = planPolicy()
    const first = setup(env, memoryStore(), { policy: async () => agent })
    const one = await run(first.model(), [user("script:echo one")])
    const store = first.store
    await first.close()
    open.splice(open.indexOf(first), 1)

    agent = buildPolicy()
    // A second plugin generation (restart, reload) with the same storage: the conversation is resumed, not restarted.
    const again = setup(env, store, { policy: async () => agent })
    await run(again.model(), [user("script:echo one"), assistant(one.text), user("script:echo two")])
    expect(sentText(again.outcomes[0]!)).toStartWith("You are no longer in Plan mode.")
  })

  test("a policy that cannot be read fails the turn open, not closed", async () => {
    const { model, env } = setup(fakeEnv(), memoryStore(), {
      policy: async () => {
        throw new Error("agent lookup exploded")
      },
    })
    const result = await run(model(), [user("script:echo hello")])
    expect(result.text).toBeString()
    // No policy means no restriction: nothing is switched and the user's text goes alone.
    expect(modeCalls(env)).toEqual([])
  })
})

