// Regression tests for the independent review (C1-C3, M1-M7, minor items).
import { afterEach, describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { AcpClient } from "../src/acp/client"
import { contentText } from "../src/acp/content"
import { mapUsage } from "../src/convert"
import { recordUsage, usageLedger } from "../src/usage"
import { createCatalog } from "../src/catalog"
import { decide, type SessionRecord } from "../src/sync/decide"
import { ANY_REPLY, assistantHash, groups, toolInput } from "../src/sync/fingerprint"
import { userContent } from "../src/sync/render"
import {
  assistant,
  echoReply,
  fakeClient,
  fakeEnv,
  harness,
  memoryStore,
  methods,
  primaryHeaders,
  received,
  run,
  setControl,
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
const record = (store: ReturnType<typeof memoryStore>) => store.data.get("session:ses_1") as SessionRecord | undefined
const promptTexts = (env: ReturnType<typeof fakeEnv>) =>
  methods(env, "session/prompt").map((entry) => entry.params.prompt.map((block: any) => block.text ?? `[${block.type}]`).join("\n"))
const errorOf = (parts: Awaited<ReturnType<typeof run>>["parts"]) => (parts.find((part) => part.type === "error") as any)?.error as Error

describe("C1: a turn that vibe took but did not finish is not sent again", () => {
  test("crash after the prompt was written: the next message continues and only the new text is sent", async () => {
    const env = fakeEnv()
    const { model, outcomes, store } = setup(env)
    const failed = await run(model(), [user("script:crash")])
    expect(errorOf(failed.parts).message).toMatch(/exited unexpectedly/)
    expect(record(store)!.history.at(-1)).toBe(ANY_REPLY)

    const next = await run(model(), [user("script:crash"), user("follow up")])
    expect(next.text).toBe("ok-2")
    expect(outcomes.at(-1)!.mode).toBe("reattached")
    expect(promptTexts(env)).toEqual(["script:crash", "follow up"])
    expect(methods(env, "session/new")).toHaveLength(1)
  })

  test("an RPC error after vibe started answering counts as delivered", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    const failed = await run(model(), [user("script:error-after-chunk")])
    expect(errorOf(failed.parts).message).toMatch(/quota exceeded/)
    await run(model(), [user("script:error-after-chunk"), assistant("started"), user("again")])
    expect(outcomes.at(-1)!.mode).toBe("continue")
    expect(promptTexts(env)).toEqual(["script:error-after-chunk", "again"])
  })

  test("a refusal before vibe took anything leaves no trace, so both messages go out together next time", async () => {
    const env = fakeEnv()
    const { model, store } = setup(env)
    const failed = await run(model(), [user("script:reject")])
    expect(errorOf(failed.parts).message).toMatch(/not signed in|not logged in/)
    expect(store.data.size).toBe(0)
    await run(model(), [user("script:reject"), user("script:echo")])
    expect(promptTexts(env).at(-1)).toBe("script:reject\nscript:echo")
  })

  test("an abort before the prompt is written keeps the existing record and conversation untouched", async () => {
    const env = fakeEnv()
    const { model, store, outcomes } = setup(env)
    const one = await run(model(), [user("hello")])
    const before = structuredClone(record(store))
    const abort = new AbortController()
    abort.abort()
    await run(model(), [user("hello"), assistant(one.text), user("second")], primaryHeaders(), abort.signal)
    expect(record(store)).toEqual(before)
    await run(model(), [user("hello"), assistant(one.text), user("second")])
    expect(outcomes.at(-1)!.mode).toBe("continue")
    expect(promptTexts(env)).toEqual(["hello", "second"])
  })

  test("a failure that happens on a replacement conversation records the replacement", async () => {
    const env = fakeEnv()
    const { model, store, outcomes } = setup(env)
    const one = await run(model(), [user("hello")])
    // edited history -> replay into a new conversation, which then dies mid-prompt
    await run(model(), [user("hello?"), assistant(one.text), user("script:error-after-chunk")])
    expect(record(store)!.acpSessionId).not.toBe(outcomes[0]!.acpSessionId)
    expect(record(store)!.history.at(-1)).toBe(ANY_REPLY)
  })
})

describe("C2: reattach failures never destroy the earlier conversation", () => {
  async function afterRestart(control: Record<string, unknown>) {
    const env = fakeEnv()
    const store = memoryStore()
    const first = setup(env, store)
    const one = await run(first.model(), [user("hello")])
    await first.close()
    const before = structuredClone(record(store))
    setControl(env, control)
    const logs: string[] = []
    const second = setup(env, store, { debug: (message) => logs.push(message) })
    const prompt: LanguageModelV3Prompt = [user("hello"), assistant(one.text), user("again")]
    return { env, store, first, second, prompt, before, logs }
  }

  test("resume fails for a reason other than 'not found': retryable error, record and conversation untouched, retry succeeds", async () => {
    const { env, store, first, second, prompt, before } = await afterRestart({ failResume: true })
    const failed = await run(second.model(), prompt)
    const error = errorOf(failed.parts)
    expect(error.name).toBe("VibeRetryableError")
    expect(error.message).toMatch(/resume failed/)
    expect(error.message).toMatch(/try again/)
    expect(record(store)).toEqual(before)
    // resume was verified directly; no replacement conversation was created and nothing was closed
    expect(methods(env, "session/new")).toHaveLength(1)
    expect(methods(env, "session/close")).toHaveLength(0)

    setControl(env, {})
    const retried = await run(second.model(), prompt)
    expect(retried.text).toBe("ok-2")
    expect(second.outcomes[0]!.mode).toBe("reattached")
    expect(second.outcomes[0]!.acpSessionId).toBe(first.outcomes[0]!.acpSessionId)
  })

  test("a verified-missing conversation (-32602 Session not found) is replaced without closing the id that no longer exists", async () => {
    const env = fakeEnv()
    const store = memoryStore()
    const first = setup(env, store)
    const one = await run(first.model(), [user("hello")])
    await first.close()
    const { writeFileSync } = await import("node:fs")
    writeFileSync(env.state, "{}")
    const second = setup(env, store)
    await run(second.model(), [user("hello"), assistant(one.text), user("again")])
    expect(second.outcomes[0]!.mode).toBe("fresh")
    expect(methods(env, "session/close")).toHaveLength(0)
  })

  test("the old conversation is retired only after the replacement turn succeeded", async () => {
    const env = fakeEnv()
    const { model, store, outcomes } = setup(env)
    const one = await run(model(), [user("hello")])
    const two = await run(model(), [user("hello"), assistant(one.text), user("second")])
    const before = structuredClone(record(store))
    const oldId = outcomes[0]!.acpSessionId

    // edited history forces a replay, and the replacement is refused
    const failed = await run(model(), [user("hello?"), user("script:reject")])
    expect(errorOf(failed.parts)).toBeDefined()
    expect(record(store)).toEqual(before)
    expect(methods(env, "session/close").map((entry) => entry.params.sessionId)).not.toContain(oldId)

    // the original conversation keeps working
    await run(model(), [user("hello"), assistant(one.text), user("second"), assistant(two.text), user("third")])
    expect(outcomes.at(-1)!.mode).toBe("continue")
    expect(outcomes.at(-1)!.acpSessionId).toBe(oldId)

    // and once a replacement does succeed, the old one is closed
    await run(model(), [user("something else entirely")])
    expect(methods(env, "session/close").map((entry) => entry.params.sessionId)).toContain(oldId)
  })
})

describe("C3 and M5: process lifecycle", () => {
  test("dispose() during the crash backoff does not spawn an orphan", async () => {
    const env = fakeEnv()
    const client = fakeClient(env, { backoffMs: 400 })
    open.push({ close: () => client.dispose() })
    const { sessionId } = await client.request<{ sessionId: string }>("session/new", { cwd: "C:\\work", mcpServers: [] })
    await client.prompt(sessionId, [{ type: "text", text: "script:crash" }], () => {}).catch(() => {})
    const restarting = client.start().catch((error: Error) => error)
    await client.dispose()
    expect(String(await restarting)).toMatch(/disposed/)
    await Bun.sleep(600)
    expect(methods(env, "initialize")).toHaveLength(1)
    // not even a second process was launched
    expect(received(env).filter((entry) => entry.event === "started")).toHaveLength(1)
    expect(client.running).toBe(false)
  })

  test("dispose() while vibe is still initializing kills it and fails the start", async () => {
    const env = fakeEnv()
    setControl(env, { hangInit: true })
    const client = fakeClient(env, { startTimeoutMs: 30_000 })
    const starting = client.start().catch((error: Error) => error)
    await Bun.sleep(150)
    await client.dispose()
    expect(String(await starting)).toBeTruthy()
    expect(client.running).toBe(false)
  })

  test("an vibe that never answers initialize is killed after startTimeoutMs, and the next start works", async () => {
    const env = fakeEnv()
    setControl(env, { hangInit: true })
    const client = fakeClient(env, { startTimeoutMs: 200 })
    open.push({ close: () => client.dispose() })
    await expect(client.start()).rejects.toThrow(/vibe did not finish initializing/)
    expect(client.running).toBe(false)
    setControl(env, {})
    await client.start()
    expect(client.running).toBe(true)
  })

  test("stderr in a crash message is first line only and clamped", async () => {
    const env = fakeEnv()
    const client = fakeClient(env)
    open.push({ close: () => client.dispose() })
    const { sessionId } = await client.request<{ sessionId: string }>("session/new", { cwd: "C:\\work", mcpServers: [] })
    const error = await client.prompt(sessionId, [{ type: "text", text: "script:crash-noisy" }], () => {}).catch((e: Error) => e)
    expect(String((error as Error).message)).toMatch(/exited unexpectedly \(code 3\)/)
    expect((error as Error).message.length).toBeLessThan(400)
    expect((error as Error).message).not.toContain("second line")
  })
})

describe("M1: tool-role groups are identified by their content", () => {
  const tool = (id: string, value: string, providerOptions?: Record<string, any>): LanguageModelV3Prompt[number] => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "t", output: { type: "text", value, providerOptions }, providerOptions }],
  })
  test("different call id or output gives a different hash; provider options do not matter", () => {
    const base = groups([tool("a", "x")])[0]!.hash
    expect(groups([tool("b", "x")])[0]!.hash).not.toBe(base)
    expect(groups([tool("a", "y")])[0]!.hash).not.toBe(base)
    expect(groups([tool("a", "x", { anthropic: { cache: true } })])[0]!.hash).toBe(base)
  })
})

describe("M2: assistant groups include tool-call identity", () => {
  const withCall = (id: string, name: string, input: unknown): LanguageModelV3Prompt[number] => ({
    role: "assistant",
    content: [{ type: "text", text: "done" }, { type: "tool-call", toolCallId: id, toolName: name, input, providerExecuted: true }],
  })
  const hash = (message: LanguageModelV3Prompt[number]) => groups([message])[0]!.hash

  test("id, name and input all count; key order and string-vs-object input do not", () => {
    const base = hash(withCall("c1", "vibe_write_file", { Path: "a", Content: "b" }))
    expect(hash(withCall("c2", "vibe_write_file", { Path: "a", Content: "b" }))).not.toBe(base)
    expect(hash(withCall("c1", "vibe_read_file", { Path: "a", Content: "b" }))).not.toBe(base)
    expect(hash(withCall("c1", "vibe_write_file", { Path: "a", Content: "c" }))).not.toBe(base)
    expect(hash(withCall("c1", "vibe_write_file", { Content: "b", Path: "a" }))).toBe(base)
    expect(hash(withCall("c1", "vibe_write_file", '{"Content":"b","Path":"a"}'))).toBe(base)
    expect(toolInput('{"b":1,"a":2}')).toBe(toolInput({ a: 2, b: 1 }))
  })

  test("OpenCode's echo of a streamed reply with a tool call continues the same conversation", async () => {
    const env = fakeEnv()
    const { model, outcomes, store } = setup(env)
    const one = await run(model(), [user("script:mixed")])
    expect(record(store)!.history.at(-1)).not.toBe(ANY_REPLY)
    await run(model(), [user("script:mixed"), echoReply(one.parts), user("next")])
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["fresh", "continue"])
  })

  test("a tampered echo (different tool call) no longer matches", async () => {
    const env = fakeEnv()
    const { model, outcomes } = setup(env)
    const one = await run(model(), [user("script:mixed")])
    const echoed = echoReply(one.parts)
    for (const part of echoed.content) if (part.type === "tool-call") part.toolName = "vibe_other"
    await run(model(), [user("script:mixed"), echoed, user("next")])
    expect(outcomes.at(-1)!.mode).toBe("fresh")
  })
})

describe("M4: an interrupted-reply marker is only valid in the last position", () => {
  const h = (prompt: LanguageModelV3Prompt) => groups(prompt).map((group) => group.hash)
  const saved = (history: string[]): SessionRecord => ({ v: 1, acpSessionId: "a", model: "m", cwd: "c", history })

  test("in the middle it is corrupt, not a wildcard", () => {
    const [u1, u2] = h([user("one"), user("two")])
    const prompt = [user("one"), assistant("anything"), user("two"), assistant("x"), user("next")]
    expect(decide(groups(prompt), saved([u1!, ANY_REPLY, u2!, assistantHash("x")]))).toEqual({ kind: "fresh", reason: "diverged" })
  })

  test("at the end it still matches an assistant group or none", () => {
    const [u1] = h([user("one")])
    expect(decide(groups([user("one"), assistant("part"), user("next")]), saved([u1!, ANY_REPLY])).kind).toBe("continue")
    expect(decide(groups([user("one"), user("next")]), saved([u1!, ANY_REPLY])).kind).toBe("continue")
  })
})

describe("M6: ACP content shapes", () => {
  test("contentText accepts a block, an array, a wrapper and a string", () => {
    expect(contentText({ type: "text", text: "a" })).toBe("a")
    expect(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab")
    expect(contentText({ type: "content", content: { type: "text", text: "w" } })).toBe("w")
    expect(contentText({ type: "resource", resource: { text: "r" } })).toBe("r")
    expect(contentText("s")).toBe("s")
    expect(contentText(undefined)).toBe("")
  })

  test("a reply delivered as an array of blocks is streamed and recorded by its text, not as an interrupted turn", async () => {
    const env = fakeEnv()
    const { model, store, outcomes } = setup(env)
    const one = await run(model(), [user("script:array-content")])
    expect(one.text).toBe("abcd")
    expect(record(store)!.history.at(-1)).toBe(assistantHash("abcd"))
    await run(model(), [user("script:array-content"), assistant("abcd"), user("next")])
    expect(outcomes.at(-1)!.mode).toBe("continue")
  })
})

describe("M7: model catalog refresh", () => {
  test("a failing persist is logged, never thrown, and an unchanged list is not persisted", async () => {
    const logs: string[] = []
    let persisted = 0
    const catalog = createCatalog([{ id: "a", name: "A" }], async () => {
      persisted++
      throw new Error("disk full")
    }, (message) => logs.push(message))
    catalog.update([{ id: "a", name: "A" }])
    expect(persisted).toBe(0)
    catalog.update([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ])
    await Bun.sleep(20)
    expect(persisted).toBe(1)
    expect(logs).toEqual(["catalog refresh failed"])
    expect(catalog.current()).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ])
  })

  test("throwaway sessions do not trigger a refresh; chat sessions do; a throwing callback does not break the request", async () => {
    const env = fakeEnv()
    const seen: string[] = []
    const { model } = setup(env, memoryStore(), {
      onChatSession: () => {
        seen.push("chat")
        throw new Error("boom")
      },
    })
    await run(model(), [user("a title please")], { "x-opencode-with-vibe-kind": "title", "x-opencode-session-id": "ses_1" })
    expect(seen).toEqual([])
    const chat = await run(model(), [user("hello")])
    expect(seen).toEqual(["chat"])
    expect(chat.text).toBe("ok-1")
  })
})

describe("minor items", () => {
  test("m2: usage is per call, and nothing is invented when nothing was measured", () => {
    // No ledger entry: every field stays undefined rather than claiming a zero.
    const empty = mapUsage(undefined)
    expect(Object.values(empty.inputTokens).every((value) => value === undefined)).toBe(true)
    expect(Object.values(empty.outputTokens).every((value) => value === undefined)).toBe(true)

    // vibe counts the cache reads inside the prompt total, so the cache-free part is what the call's prompt leaves
    // over, and the gauge (`noCache + cacheRead + output`) is the live context it reported.
    const state = usageLedger("ses_review_m2")
    recordUsage(state, {
      sessionUpdate: "usage_update",
      used: 105,
      _meta: { promptTokens: 100, completionTokens: 5, cachedTokens: 50 },
    })
    expect(mapUsage(state)).toEqual({
      inputTokens: { total: 100, noCache: 50, cacheRead: 50, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    })
  })

  const fileMessage = (mediaType: string, data: any, filename?: string): LanguageModelV3Prompt[number] => ({
    role: "user",
    content: [{ type: "file", mediaType, data, filename }],
  })

  test("m3: image subtypes are kept, bytes and data: URLs are forwarded, the wildcard becomes png", () => {
    const block = (mediaType: string, data: any) => userContent([fileMessage(mediaType, data)]).blocks[0]
    expect(block("image/jpeg", "QUJD")).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" })
    expect(block("image/svg+xml", "QUJD")).toEqual({ type: "image", data: "QUJD", mimeType: "image/svg+xml" })
    expect(block("image/webp", new Uint8Array([65, 66, 67]))).toEqual({ type: "image", data: "QUJD", mimeType: "image/webp" })
    expect(block("image/*", "QUJD")).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" })
    expect(block("image/*", "data:image/gif;base64,QUJD")).toEqual({ type: "image", data: "QUJD", mimeType: "image/gif" })
    expect(block("image/png", new URL("data:image/png;base64,QUJD"))).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" })
  })

  test("m3: URL images and other files get accurate warnings", () => {
    const url = userContent([fileMessage("image/png", new URL("https://example.com/a.png"), "a.png")])
    expect(url.warnings[0]).toMatch(/cannot fetch image URLs/)
    expect(url.blocks[0]).toMatchObject({ type: "text" })
    const pdf = userContent([fileMessage("application/pdf", "QUJD", "x.pdf")])
    expect(pdf.warnings[0]).toMatch(/only images/)
    expect(userContent([fileMessage("image/png", "https://example.com/a.png")]).warnings[0]).toMatch(/cannot fetch image URLs/)
  })

  test("the new AcpClient option is accepted next to the old ones", () => {
    expect(new AcpClient({ startTimeoutMs: 10, backoffMs: 1 }).running).toBe(false)
  })
})
