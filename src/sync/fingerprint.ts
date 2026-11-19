import { createHash } from "node:crypto"
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { canonical } from "./canonical"

export interface Group {
  readonly hash: string
  readonly role: "user" | "assistant" | "tool"
  /** Index of the first prompt message in the group. */
  readonly start: number
  /** Index after the last prompt message in the group. */
  readonly end: number
}

/** Identity of one tool call inside an assistant reply. `input` is canonical JSON. */
export interface ToolIdentity {
  readonly id: string
  readonly name: string
  readonly input: string
}

/**
 * Marks the reply of a turn whose outcome we cannot vouch for (cancelled, or failed after vibe took the prompt).
 * It matches one assistant group if present and is skipped otherwise. Only valid as the LAST recorded entry.
 */
export const ANY_REPLY = "*"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/** Whitespace-insensitive, so small re-serialisation differences by OpenCode do not read as an edit. */
export const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim()

/** Canonical form of a tool input, whether it arrives as a JSON string (our stream) or a parsed value (OpenCode's echo). */
export function toolInput(input: unknown) {
  if (typeof input === "string") {
    try {
      return canonical(JSON.parse(input))
    } catch {
      return canonical(input)
    }
  }
  return canonical(input)
}

/**
 * The hash an assistant reply gets, whether computed from our own stream or from OpenCode's echo of it.
 * Tool results are left out on purpose: OpenCode re-serialises them (errors become text), calls and inputs stay stable.
 */
export const assistantHash = (text: string, tools: readonly ToolIdentity[] = []) =>
  sha(JSON.stringify(["assistant", normalizeText(text), tools.map((tool) => [tool.id, tool.name, tool.input])]))

function userHash(message: Extract<LanguageModelV3Message, { role: "user" }>) {
  const parts: unknown[] = []
  let text = ""
  for (const part of message.content) {
    if (part.type === "text") {
      text += part.text
      continue
    }
    if (text) parts.push(["text", normalizeText(text)])
    text = ""
    const data =
      part.data instanceof URL
        ? part.data.href
        : typeof part.data === "string"
          ? part.data
          : Buffer.from(part.data).toString("base64")
    parts.push(["file", part.mediaType, sha(data)])
  }
  if (text) parts.push(["text", normalizeText(text)])
  return sha(JSON.stringify(["user", parts]))
}

/** Plain text of an assistant message; reasoning and provider options do not count. */
export function assistantText(message: Extract<LanguageModelV3Message, { role: "assistant" }>) {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

function assistantTools(message: Extract<LanguageModelV3Message, { role: "assistant" }>): ToolIdentity[] {
  return message.content.flatMap((part) =>
    part.type === "tool-call" ? [{ id: part.toolCallId, name: part.toolName, input: toolInput(part.input) }] : [],
  )
}

/** Client-executed tool results. Provider options are volatile (OpenCode adds them per target model), so they do not count. */
function toolHash(message: Extract<LanguageModelV3Message, { role: "tool" }>) {
  const parts = message.content.map((part) => {
    if (part.type !== "tool-result") return ["approval", canonical({ ...part, providerOptions: undefined })]
    const output: Record<string, unknown> = { ...part.output, providerOptions: undefined }
    if (part.output.type === "content") {
      output.value = part.output.value.map((item) => ({ ...item, providerOptions: undefined }))
    }
    return ["result", part.toolCallId, part.toolName, canonical(output)]
  })
  return sha(JSON.stringify(["tool", parts]))
}

/**
 * Splits the prompt into comparable groups. System messages are ignored (vibe has its own system prompt).
 * Each user message is its own group; consecutive assistant messages merge into one.
 */
export function groups(prompt: LanguageModelV3Prompt): Group[] {
  const result: Group[] = []
  for (let i = 0; i < prompt.length; i++) {
    const message = prompt[i]!
    if (message.role === "system") continue
    if (message.role === "user") {
      result.push({ hash: userHash(message), role: "user", start: i, end: i + 1 })
      continue
    }
    if (message.role === "assistant") {
      let text = assistantText(message)
      const tools = assistantTools(message)
      let end = i + 1
      while (end < prompt.length) {
        const next = prompt[end]!
        if (next.role !== "assistant") break
        text += assistantText(next)
        tools.push(...assistantTools(next))
        end++
      }
      // A reply with nothing visible (only reasoning) is not a message we ever recorded.
      if (normalizeText(text) === "" && tools.length === 0) {
        i = end - 1
        continue
      }
      result.push({ hash: assistantHash(text, tools), role: "assistant", start: i, end })
      i = end - 1
      continue
    }
    // Tool-role messages only appear for client-executed tools, which vibe never asks for.
    result.push({ hash: toolHash(message), role: "tool", start: i, end: i + 1 })
  }
  return result
}
