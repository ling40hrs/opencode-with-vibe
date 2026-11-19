import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { decide, type SessionRecord } from "../src/sync/decide"
import { ANY_REPLY, assistantHash, groups } from "../src/sync/fingerprint"
import { assistant, system, user } from "./helpers"

const recordFor = (prompt: LanguageModelV3Prompt, reply: string | typeof ANY_REPLY): SessionRecord => ({
  v: 1,
  acpSessionId: "acp-1",
  model: "m",
  cwd: "C:\\work",
  history: [...groups(prompt).map((group) => group.hash), reply === ANY_REPLY ? ANY_REPLY : assistantHash(reply)],
})

const first: LanguageModelV3Prompt = [system("sys"), user("hello")]
const record = recordFor(first, "pong")

describe("decide", () => {
  test("no record -> fresh", () => {
    expect(decide(groups(first), undefined)).toEqual({ kind: "fresh", reason: "no-record" })
  })

  test("recorded history plus a new user message -> continue from the new message", () => {
    const prompt = [system("other system prompt"), user("hello"), assistant("pong"), user("next")]
    expect(decide(groups(prompt), record)).toEqual({ kind: "continue", from: 2 })
  })

  test("several new user messages all continue", () => {
    const prompt = [user("hello"), assistant("pong"), user("a"), user("b")]
    expect(decide(groups(prompt), record)).toEqual({ kind: "continue", from: 2 })
  })

  test("our reply echoed back with reasoning, tool parts, provider options and different whitespace still matches", () => {
    const echoed = {
      role: "assistant" as const,
      content: [
        { type: "reasoning" as const, text: "hidden", providerOptions: { x: { y: 1 } } },
        { type: "text" as const, text: " po" },
        { type: "tool-call" as const, toolCallId: "c", toolName: "vibe_x", input: "{}", providerExecuted: true },
        { type: "tool-result" as const, toolCallId: "c", toolName: "vibe_x", output: { type: "json" as const, value: { a: 1 } } },
        { type: "text" as const, text: "ng\n" },
      ],
    }
    const withTool: SessionRecord = {
      ...record,
      history: [record.history[0]!, assistantHash("pong", [{ id: "c", name: "vibe_x", input: "{}" }])],
    }
    expect(decide(groups([user("hello"), echoed, user("next")]), withTool).kind).toBe("continue")
  })

  test("revert (history shorter than the record) -> fresh", () => {
    expect(decide(groups([user("hello")]), record)).toEqual({ kind: "fresh", reason: "diverged" })
  })

  test("edited earlier user message -> fresh", () => {
    expect(decide(groups([user("hello!"), assistant("pong"), user("next")]), record)).toEqual({ kind: "fresh", reason: "diverged" })
  })

  test("compaction summary replacing history -> fresh", () => {
    const prompt = [user("Summary of the conversation so far: ..."), user("next")]
    expect(decide(groups(prompt), record)).toEqual({ kind: "fresh", reason: "diverged" })
  })

  test("another model answered in between -> fresh", () => {
    expect(decide(groups([user("hello"), assistant("Hi, I am someone else"), user("next")]), record)).toEqual({
      kind: "fresh",
      reason: "diverged",
    })
  })

  test("a tool message after our reply -> fresh (vibe never asks for client tools)", () => {
    const prompt: LanguageModelV3Prompt = [
      user("hello"),
      assistant("pong"),
      { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "t", output: { type: "text", value: "r" } }] },
      user("next"),
    ]
    expect(decide(groups(prompt), record)).toEqual({ kind: "fresh", reason: "unexpected-groups" })
  })

  test("identical prompt with nothing new -> fresh", () => {
    expect(decide(groups([user("hello"), assistant("pong")]), record)).toEqual({ kind: "fresh", reason: "no-new-input" })
  })

  test("image attachments are part of the identity of a user message", () => {
    const withImage = (data: string): LanguageModelV3Prompt => [
      { role: "user", content: [{ type: "text", text: "see" }, { type: "file", mediaType: "image/png", data }] },
    ]
    expect(groups(withImage("AAAA"))[0]!.hash).not.toBe(groups(withImage("BBBB"))[0]!.hash)
  })

  describe("after a cancelled or failed turn (ANY_REPLY)", () => {
    const partial = recordFor(first, ANY_REPLY)

    test("matches whatever partial reply OpenCode saved", () => {
      expect(decide(groups([user("hello"), assistant("po"), user("next")]), partial).kind).toBe("continue")
    })

    test("also matches when OpenCode saved no reply at all", () => {
      expect(decide(groups([user("hello"), user("next")]), partial)).toEqual({ kind: "continue", from: 1 })
    })
  })
})

describe("groups", () => {
  test("assistant messages that only contain reasoning are invisible", () => {
    const prompt: LanguageModelV3Prompt = [user("a"), { role: "assistant", content: [{ type: "reasoning", text: "x" }] }, user("b")]
    expect(groups(prompt).map((group) => group.role)).toEqual(["user", "user"])
  })

  test("consecutive assistant messages merge into one group", () => {
    expect(groups([user("a"), assistant("x"), assistant("y")]).map((group) => group.role)).toEqual(["user", "assistant"])
    expect(groups([user("a"), assistant("x"), assistant("y")])[1]!.hash).toBe(assistantHash("xy"))
  })
})
