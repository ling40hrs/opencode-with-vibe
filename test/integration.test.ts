import { afterEach, describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { KIND_HEADER, SESSION_HEADER } from "../src/model"
import { ANY_REPLY } from "../src/sync/fingerprint"
import {
  assistant,
  fakeEnv,
  harness,
  memoryStore,
  methods,
  primaryHeaders,
  received,
  run,
  system,
  types,
  user,
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

const promptTexts = (env: ReturnType<typeof fakeEnv>) =>
  methods(env, "session/prompt").map((entry) => entry.params.prompt.map((block: any) => block.text ?? `[${block.type}]`).join("\n"))

describe("stream mapping through the language model", () => {
  test("thought, text, tool, text produce an ordered, well-formed stream ending in finish", async () => {
    const { model } = setup()
    const { parts, finish } = await run(model(), [user("script:mixed")])
    expect(types(parts)).toEqual([
      "stream-start", "response-metadata",
      "reasoning-start", "reasoning-delta", "reasoning-end",
      "text-start", "text-delta", "text-end",
      "tool-input-start", "tool-input-delta", "tool-input-end", "tool-call", "tool-result",
      "text-start", "text-delta", "text-end",
      "finish",
    ])
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1)
    const result = parts.find((part) => part.type === "tool-result")
    expect(result).toMatchObject({ toolName: "vibe_bash", result: { title: "bash: cat a.txt", diffs: [{ path: "C:\\work\\a.txt" }] } })
    expect(result).not.toHaveProperty("isError", true)
    expect(parts[1]).toEqual({ type: "response-metadata", modelId: "zai-glm-5-3" })
    // vibe counts the cached reads inside inputTokens (100), and reports no separate thought tokens
    expect(finish).toMatchObject({
      usage: { inputTokens: { total: 100, noCache: 50, cacheRead: 50 }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
    })
  })

  test("a failed tool is reported as an error result and the stream still finishes", async () => {
    const { model } = setup()
    const { parts, finish } = await run(model(), [user("script:fail-tool")])
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({ isError: true })
    expect(finish).toMatchObject({ finishReason: { unified: "stop" } })
  })

  test("max_tokens maps to finish reason length", async () => {
    const { model } = setup()
    expect((await run(model(), [user("script:max-tokens")])).finish).toMatchObject({ finishReason: { unified: "length", raw: "max_tokens" } })
  })

  test("OpenCode's tools only produce a warning; the system prompt is not forwarded", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    const { stream } = await model().doStream({
      prompt: [system("SECRET-SYSTEM"), user("hi")],
      headers: primaryHeaders(),
      tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }],
    })
    const reader = stream.getReader()
    const first = await reader.read()
    expect(first.value).toMatchObject({ type: "stream-start", warnings: [{ type: "unsupported", feature: "tools" }] })
    while (!(await reader.read()).done);
    expect(promptTexts(env).join("")).not.toContain("SECRET-SYSTEM")
  })

  test("doGenerate collects the stream", async () => {
    const { model } = setup()
    const result = await model().doGenerate({ prompt: [user("script:mixed")], headers: primaryHeaders() })
    expect(result.content.map((item) => item.type)).toEqual(["reasoning", "text", "tool-call", "tool-result", "text"])
    expect(result.finishReason.unified).toBe("stop")
  })
})

describe("errors and abort", () => {
  test("a JSON-RPC auth error becomes an error part, followed by finish", async () => {
    const { model } = setup()
    const { parts } = await run(model(), [user("script:rpc-error")])
    const error = parts.find((part) => part.type === "error")
    expect((error as any).error.message).toMatch(/run `vibe` once in a terminal to sign in/)
    expect(parts.at(-1)?.type).toBe("finish")
  })

  test("a crash mid-prompt is an error part; the next call respawns and works", async () => {
    const env = fakeEnv()
    const { model, client, store } = setup(env)
    const crashed = await run(model(), [user("script:crash")])
    expect((crashed.parts.find((part) => part.type === "error") as any).error.message).toMatch(/exited unexpectedly/)
    expect(crashed.parts.at(-1)?.type).toBe("finish")
    // vibe had taken the prompt, so the turn is recorded as interrupted rather than forgotten
    expect((store.data.get("session:ses_1") as any).history.at(-1)).toBe(ANY_REPLY)
    const again = await run(model(), [user("hello")])
    expect(again.text).toBe("ok-1")
    expect(client.generation).toBe(2)
  })

  test("aborting mid-prompt cancels in vibe and ends with finish(other/cancelled) keeping the usage vibe reported", async () => {
    const env = fakeEnv()
    const { model, store } = setup(env)
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 200)
    const { parts, finish, text } = await run(model(), [user("script:slow")], primaryHeaders(), abort.signal)
    expect(text).toBe("partial")
    expect(methods(env, "session/cancel")).toHaveLength(1)
    expect(finish).toMatchObject({ finishReason: { unified: "other", raw: "cancelled" } })
    // like real vibe, a cancelled turn still reports what it used so far
    expect((finish as any).usage.inputTokens.total).toBe(100)
    expect(parts.some((part) => part.type === "error")).toBe(false)
    // vibe has seen the turn even though it was cut short: the record stays usable
    const record = store.data.get("session:ses_1") as any
    expect(record.history.at(-1)).toBe(ANY_REPLY)
  })

  test("an abort before the prompt is sent never reaches vibe and leaves no record", async () => {
    const env = fakeEnv()
    const { model, store } = setup(env)
    const abort = new AbortController()
    abort.abort()
    const { finish } = await run(model(), [user("hello")], primaryHeaders(), abort.signal)
    expect(finish).toMatchObject({ finishReason: { raw: "cancelled" } })
    expect(methods(env, "session/prompt")).toHaveLength(0)
    expect(store.data.size).toBe(0)
  })

  test("after a cancelled turn the next message continues the same vibe session", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 150)
    await run(model(), [user("script:slow")], primaryHeaders(), abort.signal)
    await run(model(), [user("script:slow"), assistant("par"), user("next")])
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["fresh", "continue"])
    expect(methods(env, "session/new")).toHaveLength(1)
  })
})

describe("session reuse and divergence", () => {
  test("turn 2 continues the same vibe session and sends only the new user message", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    const one = await run(model(), [system("s"), user("hello")])
    const two = await run(model(), [system("s"), user("hello"), assistant(one.text), user("again")])
    expect(two.text).toBe("ok-2")
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["fresh", "continue"])
    expect(outcomes[0]!.acpSessionId).toBe(outcomes[1]!.acpSessionId)
    expect(methods(env, "session/new")).toHaveLength(1)
    expect(promptTexts(env)).toEqual(["hello", "again"])
  })

  test("the model is applied only when it differs from what the conversation already has", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    // a new conversation already starts on zai-glm-5-3 at its default level: nothing to apply
    const one = await run(model("zai-glm-5-3"), [user("a")])
    const two = await run(model("zai-glm-5-3"), [user("a"), assistant(one.text), user("b")])
    expect(methods(env, "session/set_config_option")).toHaveLength(0)
    await run(model("mistral-medium-latest"), [user("a"), assistant(one.text), user("b"), assistant(two.text), user("c")])
    expect(methods(env, "session/set_config_option").map((entry) => [entry.params.configId, entry.params.value])).toEqual([
      ["model", "mistral-medium-latest"],
      ["thinking", "high"],
    ])
    expect(methods(env, "session/new")).toHaveLength(1)
  })

  async function twoTurns() {
    const env = fakeEnv()
    const ctx = setup(env)
    const one = await run(ctx.model(), [user("hello")])
    const two = await run(ctx.model(), [user("hello"), assistant(one.text), user("second")])
    return { ...ctx, env, one, two }
  }

  // The record after twoTurns() is: hello, <a1>, second, <a2>
  const divergences: [string, (a1: string, a2: string) => LanguageModelV3Prompt][] = [
    ["revert of the last turn", (a1) => [user("hello"), assistant(a1), user("redo")]],
    ["edited earlier message", (a1, a2) => [user("hello?"), assistant(a1), user("second"), assistant(a2), user("third")]],
    ["compaction summary", () => [user("Summary: the user said hello"), assistant("ack"), user("third")]],
    ["foreign assistant reply", (_a1, a2) => [user("hello"), assistant("not from vibe"), user("second"), assistant(a2), user("third")]],
  ]
  test.each(divergences)("%s starts a new vibe session, replays history as text and closes the old one", async (_name, build) => {
    const { env, one, two, outcomes, model } = await twoTurns()
    const prompt = build(one.text, two.text)
    const third = await run(model(), prompt)
    expect(third.text).toBeTruthy()
    const last = outcomes.at(-1)!
    expect(last.mode).toBe("fresh")
    expect(last.acpSessionId).not.toBe(outcomes[0]!.acpSessionId)
    expect(methods(env, "session/new")).toHaveLength(2)
    expect(methods(env, "session/close").map((entry) => entry.params.sessionId)).toContain(outcomes[0]!.acpSessionId)
    const sent = promptTexts(env).at(-1)!
    expect(sent).toContain("<conversation-history>")
    const lastMessage = prompt.at(-1)!
    const latest = lastMessage.role === "user" ? lastMessage.content.map((part) => (part.type === "text" ? part.text : "")).join("") : ""
    expect(latest).not.toBe("")
    expect(sent.slice(sent.indexOf("</conversation-history>"))).toContain(latest)
  })

  test("a catch-up prompt ends with the latest user message after the history block", async () => {
    const { env, model } = setup()
    await run(model(), [user("old question"), assistant("old answer"), user("new question")])
    const sent = promptTexts(env).at(-1)!
    expect(sent).toContain("[user]\nold question")
    expect(sent).toContain("[assistant]\nold answer")
    expect(sent.indexOf("</conversation-history>")).toBeLessThan(sent.indexOf("new question"))
    expect(sent).not.toContain("[user]\nnew question")
  })

  test("a tool message in the history forces a replay instead of a continue", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    const one = await run(model(), [user("hello")])
    await run(model(), [
      user("hello"),
      assistant(one.text),
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "x", output: { type: "text", value: "r" } }] },
      user("next"),
    ])
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["fresh", "fresh"])
  })

  test("different OpenCode sessions get different vibe sessions", async () => {
    const { model, outcomes } = setup()
    await run(model(), [user("a")], primaryHeaders("ses_a"))
    await run(model(), [user("a")], primaryHeaders("ses_b"))
    expect(outcomes[0]!.acpSessionId).not.toBe(outcomes[1]!.acpSessionId)
  })
})

describe("restart reattach", () => {
  test("after a restart the recorded vibe session is resumed and gets only the new message", async () => {
    const env = fakeEnv()
    const store = memoryStore()
    const first = setup(env, store)
    const one = await run(first.model(), [user("hello")])
    await first.close()

    const second = setup(env, store)
    const two = await run(second.model(), [user("hello"), assistant(one.text), user("again")])
    expect(two.text).toBe("ok-2")
    expect(second.outcomes[0]!.mode).toBe("reattached")
    expect(second.outcomes[0]!.acpSessionId).toBe(first.outcomes[0]!.acpSessionId)
    const names = received(env).filter((entry) => entry.direction === "in").map((entry) => entry.method)
    expect(names.filter((name) => name === "session/new")).toHaveLength(1)
    expect(names).toContain("session/resume")
    // resume is verified directly: no listing has to be searched
    expect(names).not.toContain("session/list")
    // model and level are re-applied after resume because vibe resets them
    expect(methods(env, "session/set_config_option").map((entry) => [entry.params.configId, entry.params.value])).toEqual([
      ["model", "zai-glm-5-3"],
      ["thinking", "max"],
    ])
    expect(promptTexts(env)).toEqual(["hello", "again"])
  })

  test("resuming an id vibe does not know (Session not found) falls back to fresh with catch-up", async () => {
    const env = fakeEnv()
    const store = memoryStore()
    const first = setup(env, store)
    const one = await run(first.model(), [user("hello")])
    await first.close()
    writeFileSync(env.state, "{}") // vibe lost the conversation: resume now answers -32602 Session not found

    const second = setup(env, store)
    const two = await run(second.model(), [user("hello"), assistant(one.text), user("again")])
    expect(two.text).toBeTruthy()
    expect(second.outcomes[0]!.mode).toBe("fresh")
    expect(second.outcomes[0]!.acpSessionId).not.toBe(first.outcomes[0]!.acpSessionId)
    expect(methods(env, "session/new")).toHaveLength(2)
    const sent = promptTexts(env).at(-1)!
    expect(sent).toContain("<conversation-history>")
    expect(sent).toContain("[user]\nhello")
    // the old id does not exist in vibe, so there is nothing to close; the record now points at the replacement
    expect(methods(env, "session/close").map((entry) => entry.params.sessionId)).not.toContain(first.outcomes[0]!.acpSessionId)
    expect((store.data.get("session:ses_1") as any).acpSessionId).toBe(second.outcomes[0]!.acpSessionId)
  })

  test("a changed working directory does not reuse the recorded conversation", async () => {
    const env = fakeEnv()
    const store = memoryStore()
    const first = setup(env, store)
    const one = await run(first.model(), [user("hello")])
    await first.close()
    const second = setup(env, store, { cwd: "C:\\elsewhere" })
    await run(second.model(), [user("hello"), assistant(one.text), user("again")])
    expect(second.outcomes[0]!.mode).toBe("fresh")
  })

  test("an idle vibe session is closed and transparently resumed on the next message", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env, memoryStore(), { idleMs: 40 })
    const one = await run(model(), [user("hello")])
    await Bun.sleep(300)
    expect(methods(env, "session/close")).toHaveLength(1)
    await run(model(), [user("hello"), assistant(one.text), user("again")])
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["fresh", "reattached"])
  })

  test("a corrupt stored record is ignored", async () => {
    const store = memoryStore()
    store.data.set("session:ses_1", { v: 1, history: "nope" })
    const { model, outcomes } = setup(fakeEnv(), store)
    await run(model(), [user("hello")])
    expect(outcomes[0]!.mode).toBe("fresh")
  })
})

describe("throwaway sessions", () => {
  test.each(["title", "compaction", "generate"])("%s requests use a throwaway session with the system prompt as text", async (kind) => {
    const env = fakeEnv()
    const { model, store, outcomes } = setup(env)
    await run(model(), [system("Generate a title"), user("fix the bug")], { [KIND_HEADER]: kind, [SESSION_HEADER]: "ses_1" })
    expect(outcomes[0]!.mode).toBe("throwaway")
    const sent = promptTexts(env)[0]!
    expect(sent).toContain("Generate a title")
    expect(sent).toContain("fix the bug")
    expect(sent).toContain("Do not use any tools")
    const created = methods(env, "session/new")
    const closed = methods(env, "session/close")
    expect(created).toHaveLength(1)
    expect(closed.map((entry) => entry.params.sessionId)).toEqual([outcomes[0]!.acpSessionId])
    expect(store.data.size).toBe(0)
  })

  test("a primary request without a session header is also throwaway", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    await run(model(), [user("hello")], { [KIND_HEADER]: "primary" })
    expect(outcomes[0]!.mode).toBe("throwaway")
  })

  test("a throwaway request does not disturb the primary conversation", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    const one = await run(model(), [user("hello")])
    await run(model(), [system("title please"), user("hello")], { [KIND_HEADER]: "title", [SESSION_HEADER]: "ses_1" })
    await run(model(), [user("hello"), assistant(one.text), user("again")])
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["fresh", "throwaway", "continue"])
  })
})

describe("per-session serialisation", () => {
  test("concurrent turns of one OpenCode session never overlap in vibe, and the second one continues", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    const first = run(model(), [user("script:hold one")])
    const second = run(model(), [user("script:hold one"), assistant("held"), user("script:hold two")])
    await Promise.all([first, second])
    const holds = received(env).filter((entry) => entry.event?.startsWith("hold"))
    expect(holds.map((entry) => entry.event)).toEqual(["hold-start", "hold-end", "hold-start", "hold-end"])
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["fresh", "continue"])
  })

  test("different OpenCode sessions run in parallel", async () => {
    const env = fakeEnv()
    const { model } = setup(env)
    await Promise.all([
      run(model(), [user("script:hold a")], primaryHeaders("ses_a")),
      run(model(), [user("script:hold b")], primaryHeaders("ses_b")),
    ])
    const holds = received(env).filter((entry) => entry.event?.startsWith("hold")).map((entry) => entry.event)
    expect(holds).toEqual(["hold-start", "hold-start", "hold-end", "hold-end"])
  })
})
