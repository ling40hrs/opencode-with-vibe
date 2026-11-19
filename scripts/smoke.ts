// Live smoke test against the real `vibe` CLI. Uses 2 prompts on mistral-large-4-0.
//   bun run scripts/smoke.ts
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { AcpClient } from "../src/acp/client"
import { VibeLanguageModel, KIND_HEADER, SESSION_HEADER } from "../src/model"
import { VibeSessions, type RunOutcome } from "../src/sessions"
import { DEFAULT_CATALOG } from "../src/models"
import type { SessionRecord } from "../src/sync/decide"

const MODEL = "mistral-large-4-0"
// What OpenCode delivers for `--variant low` / `vibe/mistral-large-4-0#low`.
const providerOptions = { vibe: { thoughtLevel: "low" } }
const lookup = (id: string) => DEFAULT_CATALOG.find((model) => model.id === id)
const cwd = process.env.SMOKE_CWD ?? process.cwd()
const outcomes: RunOutcome[] = []
const records = new Map<string, unknown>()

const client = new AcpClient({
  cwd,
  debug: process.env.SMOKE_DEBUG ? (m, d) => console.error("[acp]", m, JSON.stringify(d)?.slice(0, 300)) : undefined,
})
const sessions = new VibeSessions(
  client,
  { get: async (k) => records.get(k), set: async (k, v: SessionRecord) => void records.set(k, structuredClone(v)) },
  { cwd, catalog: lookup },
)
const model = new VibeLanguageModel(MODEL, {
  model: lookup,
  run: async (request) => {
    const outcome = await sessions.run(request)
    outcomes.push(outcome)
    return outcome
  },
})

const headers = { [KIND_HEADER]: "primary", [SESSION_HEADER]: "ses_smoke" }

async function turn(prompt: LanguageModelV3Prompt) {
  const { stream } = await model.doStream({ prompt, headers, providerOptions })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value)
  const text = parts.flatMap((p) => (p.type === "text-delta" ? [p.delta] : [])).join("")
  const counts: Record<string, number> = {}
  for (const p of parts) counts[p.type] = (counts[p.type] ?? 0) + 1
  const finish = parts.find((p) => p.type === "finish")
  console.log("parts:", JSON.stringify(counts))
  console.log("text:", JSON.stringify(text))
  console.log("finish:", JSON.stringify(finish))
  if (!finish || parts.at(-1)?.type !== "finish") throw new Error("stream did not end with finish")
  return text
}

const check = (ok: boolean, message: string) => {
  console.log(ok ? "PASS" : "FAIL", message)
  if (!ok) process.exitCode = 1
}

try {
  const user1 = "Reply with exactly: pong"
  const user2 = "What did I ask you first?"
  console.log("--- turn 1")
  const reply1 = await turn([
    { role: "system", content: "OpenCode system prompt that must not be forwarded" },
    { role: "user", content: [{ type: "text", text: user1 }] },
  ])
  console.log("--- turn 2")
  const reply2 = await turn([
    { role: "system", content: "OpenCode system prompt that must not be forwarded" },
    { role: "user", content: [{ type: "text", text: user1 }] },
    { role: "assistant", content: [{ type: "text", text: reply1 }] },
    { role: "user", content: [{ type: "text", text: user2 }] },
  ])
  const [first, second] = outcomes
  check(first?.mode === "fresh", `turn 1 started a fresh vibe session (mode=${first?.mode})`)
  check(second?.mode === "continue", `turn 2 continued the existing session (mode=${second?.mode})`)
  check(first?.acpSessionId === second?.acpSessionId, "same ACP session id on both turns")
  const sent2 = JSON.stringify(second?.sent)
  check(
    second?.sent.length === 1 && sent2.includes(user2) && !sent2.includes(user1) && !sent2.includes("conversation-history"),
    `turn 2 sent only the new user message: ${sent2}`,
  )
  check(!JSON.stringify(first?.sent).includes("must not be forwarded"), "system prompt was not forwarded")
  check(/pong/i.test(reply2), "turn 2 answer came from vibe session memory (mentions pong)")
  console.log("usage turn1/turn2:", JSON.stringify(outcomes.map((o) => o.result.usage)))
} finally {
  sessions.dispose()
  await client.dispose()
}
