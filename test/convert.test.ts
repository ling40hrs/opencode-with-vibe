import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { SessionUpdate, UsageUpdate } from "../src/acp/types"
import { finishPart, mapUsage, normalizePath, UpdateConverter } from "../src/convert"
import { recordUsage, usageLedger, type SessionUsage } from "../src/usage"

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
  // Vibe answers a prompt with the session's cumulative totals, and states the live context in `used`. A turn moves
  // its prompt before the response and its completion after it, so a turn looks like two updates.
  const update = (used: number, promptTokens: number, completionTokens: number, cachedTokens: number): UsageUpdate => ({
    sessionUpdate: "usage_update",
    used,
    size: 202_144,
    _meta: { promptTokens, completionTokens, cachedTokens },
  })

  const gauge = (usage: ReturnType<typeof mapUsage>) =>
    (usage.inputTokens.noCache ?? 0) + (usage.inputTokens.cacheRead ?? 0) + (usage.outputTokens.total ?? 0)

  /** A ledger fed the updates of one turn of `prompts` (each 100 prompt tokens, 50 cached, 5 output). */
  function turn(state: SessionUsage, prompt: number, completion: number, cached: number, used: number) {
    recordUsage(state, update(used, prompt, completion, cached))
    return state
  }

  test("the gauge is the live context vibe reports, not the session total", () => {
    const state = usageLedger("ses_gauge")
    turn(state, 100, 0, 50, 100)
    turn(state, 100, 5, 50, 105)
    const usage = mapUsage(state)
    expect(gauge(usage)).toBe(105)
    expect(usage.outputTokens).toEqual({ total: 5, text: 5, reasoning: undefined })
  })

  test("cumulative totals are reduced to the call's own delta", () => {
    const state = usageLedger("ses_delta")
    turn(state, 100, 5, 50, 105)
    // A second turn: the counters climb by the new call's prompt and output.
    turn(state, 203, 5, 152, 108)
    turn(state, 203, 10, 152, 113)
    const usage = mapUsage(state)
    // The second call's prompt was 103 tokens, 102 of them cached; the gauge is still the live context.
    expect(usage.inputTokens.total).toBe(108)
    expect(usage.inputTokens.cacheRead).toBe(102)
    expect(usage.inputTokens.noCache).toBe(6)
    expect(gauge(usage)).toBe(113)
  })

  test("the prompt's cache split survives the update that brings the completion", () => {
    const state = usageLedger("ses_split")
    turn(state, 100, 0, 50, 100)
    turn(state, 100, 5, 50, 105)
    expect(mapUsage(state).inputTokens).toEqual({ total: 100, noCache: 50, cacheRead: 50, cacheWrite: undefined })
  })

  test("a repeated update changes nothing", () => {
    const state = usageLedger("ses_repeat")
    turn(state, 100, 5, 50, 105)
    const once = mapUsage(state).inputTokens.total
    recordUsage(state, update(105, 100, 5, 50))
    recordUsage(state, update(105, 100, 5, 50))
    expect(mapUsage(state).inputTokens.total).toBe(once)
  })

  test("sessions do not share a ledger", () => {
    turn(usageLedger("ses_a"), 100, 5, 50, 105)
    turn(usageLedger("ses_b"), 1_000, 20, 900, 1_020)
    expect(gauge(mapUsage(usageLedger("ses_a")))).toBe(105)
    expect(gauge(mapUsage(usageLedger("ses_b")))).toBe(1_020)
  })

  test("a resumed session does not report the whole session as one call", () => {
    const state = usageLedger("ses_resumed")
    // The first update of a resume carries totals from every earlier turn; `used` still bounds the result.
    turn(state, 309_000, 6_000, 293_000, 108_000)
    expect(gauge(mapUsage(state))).toBe(108_000)
  })

  test("an output larger than the context is clamped to it", () => {
    const state = usageLedger("ses_clamp")
    recordUsage(state, { sessionUpdate: "usage_update", used: 50, _meta: { promptTokens: 1, completionTokens: 9_000, cachedTokens: 0 } })
    const usage = mapUsage(state)
    expect(usage.outputTokens.total).toBe(50)
    expect(gauge(usage)).toBe(50)
  })

  test("no ledger (nothing measured yet) reports no tokens at all", () => {
    const empty = mapUsage(undefined)
    expect(Object.values(empty.inputTokens).every((value) => value === undefined)).toBe(true)
    expect(Object.values(empty.outputTokens).every((value) => value === undefined)).toBe(true)
    expect(mapUsage(usageLedger("ses_never_used"))).toEqual(empty)
  })

  test("an update without `_meta` records the context but no usage", () => {
    const state = usageLedger("ses_meta_less")
    recordUsage(state, { sessionUpdate: "usage_update", used: 500, size: 202_144 })
    expect(state.used).toBe(500)
    expect(mapUsage(state).inputTokens.total).toBeUndefined()
  })

  test("a converter feeds the ledger it is given", () => {
    const state = usageLedger("ses_converter")
    new UpdateConverter({ state }).push(update(120, 100, 0, 80))
    expect(state.used).toBe(120)
    expect(mapUsage(state).inputTokens.cacheRead).toBe(80)
  })

  test("a converter without a ledger records nothing", () => {
    expect(new UpdateConverter().push(update(120, 100, 0, 80))).toEqual([])
    expect(mapUsage(undefined).inputTokens.total).toBeUndefined()
  })

  test("finishPart reads the ledger, not the cumulative result usage", () => {
    const state = usageLedger("ses_finish")
    turn(state, 100, 5, 50, 105)
    const finish = finishPart({ stopReason: "end_turn", usage: { inputTokens: 100, cachedReadTokens: 50, outputTokens: 5 } }, undefined, state)
    expect(finish.usage.inputTokens).toEqual({ total: 100, noCache: 50, cacheRead: 50, cacheWrite: undefined })
    expect(finishPart({ stopReason: "end_turn" }).usage.inputTokens.total).toBeUndefined()
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
