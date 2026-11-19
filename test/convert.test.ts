import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { SessionUpdate } from "../src/acp/types"
import { finishPart, mapUsage, normalizePath, UpdateConverter } from "../src/convert"

const text = (value: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } })
const thought = (value: string): SessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: value } })
const tool = (status: string, extra: Record<string, unknown> = {}): SessionUpdate => ({
  sessionUpdate: status === "completed" || status === "failed" ? "tool_call_update" : "tool_call",
  toolCallId: "c1",
  title: "cat a.txt",
  kind: "execute",
  status,
  rawInput: { command: "cat a.txt" },
  _meta: { tool_name: "bash", effect_kind: "shell" },
  ...extra,
}) as SessionUpdate

function feed(updates: SessionUpdate[]) {
  const converter = new UpdateConverter()
  return [...updates.flatMap((update) => converter.push(update)), ...converter.close()]
}
const kinds = (parts: LanguageModelV3StreamPart[]) => parts.map((part) => part.type)

describe("UpdateConverter", () => {
  test("text deltas share one block and close at the end", () => {
    expect(kinds(feed([text("a"), text("b")]))).toEqual(["text-start", "text-delta", "text-delta", "text-end"])
  })

  test("thought, text, tool, text interleave into separate closed blocks with fresh ids", () => {
    const parts = feed([thought("t"), text("a"), tool("in_progress"), tool("completed"), text("b")])
    expect(kinds(parts)).toEqual([
      "reasoning-start", "reasoning-delta", "reasoning-end",
      "text-start", "text-delta", "text-end",
      "tool-input-start", "tool-input-delta", "tool-input-end", "tool-call", "tool-result",
      "text-start", "text-delta", "text-end",
    ])
    const ids = parts.flatMap((part) => (part.type === "text-start" ? [part.id] : []))
    expect(new Set(ids).size).toBe(2)
  })

  test("repeated tool updates emit one call and one result", () => {
    const parts = feed([tool("in_progress"), tool("pending"), tool("in_progress"), tool("completed"), tool("completed")])
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1)
    expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(1)
  })

  test("tool call is provider-executed, named from `_meta.tool_name`, with JSON input from rawInput", () => {
    const call = feed([tool("in_progress")]).find((part) => part.type === "tool-call")
    expect(call).toMatchObject({ toolName: "vibe_bash", providerExecuted: true, input: '{"command":"cat a.txt"}' })
  })

  test("tool name falls back to kind when _meta is absent, and is sanitised", () => {
    const call = feed([tool("in_progress", { _meta: undefined, kind: "web search" })]).find((part) => part.type === "tool-call")
    expect(call).toMatchObject({ toolName: "vibe_web_search" })
  })

  test("failed tool becomes an error result", () => {
    const result = feed([tool("in_progress"), tool("failed")]).find((part) => part.type === "tool-result")
    expect(result).toMatchObject({ isError: true })
  })

  test("a call first seen already completed still yields call then result", () => {
    expect(kinds(feed([tool("completed")])).slice(-2)).toEqual(["tool-call", "tool-result"])
  })

  test("result carries title, text, normalised paths and drops duplicated output", () => {
    const result = feed([
      tool("completed", {
        title: "File /C:/work/a.txt",
        locations: [{ path: "/C:/work/a.txt" }],
        rawOutput: { stdout: "same\n", stderr: "", output: "", truncated: false, exit_code: 0 },
        content: [
          { type: "content", content: { type: "text", text: "same\n" } },
          { type: "diff", path: "/C:/work/a.txt", newText: "hi\n" },
        ],
      }),
    ]).find((part) => part.type === "tool-result")
    expect(result).toMatchObject({
      result: {
        title: "File C:/work/a.txt",
        text: "same\n",
        diffs: [{ path: "C:\\work\\a.txt", newText: "hi\n" }],
        locations: ["C:\\work\\a.txt"],
        // stdout repeats the content text and output is empty, so only the structured extras survive
        output: { truncated: false, exit_code: 0 },
      },
    })
  })

  test("huge outputs are truncated", () => {
    const result = feed([tool("completed", { content: [{ type: "content", content: { type: "text", text: "x".repeat(50_000) } }] })]).find(
      (part) => part.type === "tool-result",
    )
    expect(JSON.stringify(result).length).toBeLessThan(10_000)
  })

  test("noise updates produce nothing", () => {
    expect(feed([
      { sessionUpdate: "usage_update" },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } } as SessionUpdate,
      { sessionUpdate: "session_info_update" },
    ])).toEqual([])
  })
})

test("normalizePath turns vibe's URI-style Windows paths into native ones", () => {
  expect(normalizePath("/C:/Users/me/a b.txt")).toBe("C:\\Users\\me\\a b.txt")
  expect(normalizePath("C:\\already\\fine")).toBe("C:\\already\\fine")
  expect(normalizePath("/usr/bin")).toBe("/usr/bin")
})

describe("usage and finish mapping", () => {
  // `inputTokens` already includes the cached reads (a subset, not an extra); `totalTokens == inputTokens + outputTokens`.
  const usage = { inputTokens: 100, outputTokens: 5, cachedReadTokens: 50, totalTokens: 105 }

  test("cached reads are already part of the input total, so noCache is the remainder", () => {
    expect(mapUsage(usage)).toEqual({
      inputTokens: { total: 100, noCache: 50, cacheRead: 50, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    })
  })

  test("vibe reports no separate thought tokens, so reasoning stays undefined", () => {
    expect(mapUsage({ ...usage, outputTokens: 8, totalTokens: 108 }).outputTokens).toEqual({ total: 8, text: 8, reasoning: undefined })
  })

  test("a full cache hit does not go negative", () => {
    expect(mapUsage({ inputTokens: 10, cachedReadTokens: 10, outputTokens: 1, totalTokens: 11 }).inputTokens).toEqual({
      total: 10,
      noCache: 0,
      cacheRead: 10,
      cacheWrite: undefined,
    })
  })

  test("no usage (cancelled before generation) stays all-undefined", () => {
    const empty = mapUsage(undefined)
    expect(Object.values(empty.inputTokens).every((value) => value === undefined)).toBe(true)
    expect(Object.values(empty.outputTokens).every((value) => value === undefined)).toBe(true)
  })

  test("partial usage: only what vibe sent is filled in", () => {
    expect(mapUsage({ outputTokens: 7 })).toEqual({
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    })
    expect(mapUsage({ inputTokens: 10 }).inputTokens).toEqual({ total: 10, noCache: 10, cacheRead: 0, cacheWrite: undefined })
  })

  test.each([
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["max_turn_requests", "length"],
    ["refusal", "content-filter"],
    ["cancelled", "other"],
    ["something_new", "other"],
  ] as const)("stopReason %s -> %s, raw preserved", (stopReason, unified) => {
    expect(finishPart({ stopReason }).finishReason).toEqual({ unified, raw: stopReason })
  })
})
