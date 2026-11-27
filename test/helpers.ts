import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpClient, type AcpClientOptions } from "../src/acp/client"
import { VibeLanguageModel, KIND_HEADER, SESSION_HEADER } from "../src/model"
import { VibeSessions, type RunOutcome, type SessionsOptions } from "../src/sessions"
import type { CatalogModel } from "../src/models"
import type { SessionRecord } from "../src/sync/decide"

const FAKE = join(import.meta.dir, "fake-agent.ts")

/** The real vibe-acp 3.1.3 catalog: the same four base models `DEFAULT_CATALOG` lists. */
export const FAKE_CATALOG: CatalogModel[] = [
  { id: "mistral-large-4-0", name: "Mistral Large 4", thinking: { levels: ["low", "medium", "high"], default: "high" } },
  { id: "mistral-medium-latest", name: "Mistral Medium 3.5", thinking: { levels: ["off", "high"], default: "high" } },
  { id: "zai-glm-5-3", name: "GLM 5.3 (Mistral Hosted)", thinking: { levels: ["low", "high", "max"], default: "max" } },
  {
    id: "zai-glm-5-3-flash",
    name: "GLM 5.3 Flash (Mistral Hosted)",
    thinking: { levels: ["low", "high", "max"], default: "high" },
  },
]
const lookup = (id: string) => FAKE_CATALOG.find((model) => model.id === id)

/** The default model the fake agent starts a conversation on. */
export const DEFAULT_MODEL = "zai-glm-5-3"

export function fakeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vibe-fake-"))
  // `session/list` filters by `cwd` in vibe; this is the directory every fake conversation is reported in.
  const cwd = "C:\\work"
  return { dir, cwd, log: join(dir, "log.jsonl"), state: join(dir, "state.json"), control: join(dir, "control.json") }
}

export type FakeEnv = ReturnType<typeof fakeEnv>

export function fakeClient(env: FakeEnv, options: AcpClientOptions = {}) {
  return new AcpClient({
    command: process.execPath,
    argv: [FAKE],
    env: {
      ...process.env,
      FAKE_VIBE_LOG: env.log,
      FAKE_VIBE_STATE: env.state,
      FAKE_VIBE_CONTROL: env.control,
      FAKE_VIBE_CWD: env.cwd,
    },
    backoffMs: 1,
    ...options,
  })
}

/** Fault injection for the fake agent: { failResume, failList, endlessPages, pageSize, hangInit }. */
export const setControl = (env: FakeEnv, value: Record<string, unknown>) => writeFileSync(env.control, JSON.stringify(value))

/** What OpenCode sends back for a reply we streamed: text, reasoning, tool calls (input parsed) and their results. */
export function echoReply(parts: LanguageModelV3StreamPart[]) {
  const content: Extract<LanguageModelV3Prompt[number], { role: "assistant" }>["content"] = []
  for (const part of parts) {
    if (part.type === "text-delta") content.push({ type: "text", text: part.delta })
    if (part.type === "reasoning-delta") content.push({ type: "reasoning", text: part.delta })
    if (part.type === "tool-call")
      content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: JSON.parse(part.input), providerExecuted: true })
    if (part.type === "tool-result")
      content.push({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: { type: "json", value: part.result } })
  }
  return { role: "assistant" as const, content }
}

/** Every message the fake agent received, in order. */
export function received(env: FakeEnv): any[] {
  if (!existsSync(env.log)) return []
  return readFileSync(env.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

export const methods = (env: FakeEnv, ...names: string[]) =>
  received(env).filter((entry) => entry.direction === "in" && names.includes(entry.method))

/** A session store backed by a Map, standing in for `ctx.storage`. Survives "restarts" when reused. */
export function memoryStore() {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
  }
}

export function harness(env: FakeEnv, store = memoryStore(), options: Partial<SessionsOptions> = {}) {
  const client = fakeClient(env)
  const sessions = new VibeSessions(client, store, { cwd: env.cwd, idleMs: 0, catalog: lookup, ...options })
  const outcomes: RunOutcome[] = []
  const model = (id = DEFAULT_MODEL) =>
    new VibeLanguageModel(id, {
      model: lookup,
      run: async (request) => {
        const outcome = await sessions.run(request)
        outcomes.push(outcome)
        return outcome
      },
    })
  return {
    client,
    sessions,
    store,
    outcomes,
    model,
    async close() {
      sessions.dispose()
      await client.dispose()
    },
  }
}

export const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
export const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })
export const system = (text: string) => ({ role: "system" as const, content: text })

/** The call options OpenCode produces for a variant whose settings are `{ thoughtLevel: level }`. */
export const variant = (level: string) => ({ vibe: { thoughtLevel: level } })

export const primaryHeaders = (sessionID = "ses_1") => ({ [KIND_HEADER]: "primary", [SESSION_HEADER]: sessionID })

export async function readAll(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value)
  return parts
}

export async function run(
  model: VibeLanguageModel,
  prompt: LanguageModelV3Prompt,
  headers: Record<string, string> = primaryHeaders(),
  abortSignal?: AbortSignal,
  /** What OpenCode would deliver for the selected variant: `{ vibe: { thoughtLevel: "low" } }`. */
  providerOptions?: Record<string, Record<string, any>>,
) {
  const { stream } = await model.doStream({ prompt, headers, abortSignal, providerOptions })
  const parts = await readAll(stream)
  const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
  return { parts, text, finish: parts.find((part) => part.type === "finish") }
}

export const types = (parts: LanguageModelV3StreamPart[]) => parts.map((part) => part.type)
