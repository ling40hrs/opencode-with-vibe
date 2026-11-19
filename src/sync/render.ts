import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { ContentBlock } from "../acp/types"

type UserMessage = Extract<LanguageModelV3Message, { role: "user" }>
type FilePart = Extract<UserMessage["content"][number], { type: "file" }>

const MAX_HISTORY_CHARS = 300_000
const MAX_TOOL_CHARS = 1_500

export interface Rendered {
  blocks: ContentBlock[]
  /** Human-readable notes about content vibe cannot take (surfaced as stream warnings). */
  warnings: string[]
}

/** ACP content for user messages. Images go through as image blocks, other files become a text note. */
export function userContent(messages: readonly LanguageModelV3Message[]): Rendered {
  const blocks: ContentBlock[] = []
  const warnings: string[] = []
  for (const message of messages) {
    if (message.role !== "user") continue
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text) blocks.push({ type: "text", text: part.text })
        continue
      }
      const image = imageBlock(part)
      if (image.block) {
        blocks.push(image.block)
        continue
      }
      const label = part.filename ?? part.mediaType
      warnings.push(`File "${label}" (${part.mediaType}) was not forwarded: ${image.reason}.`)
      blocks.push({ type: "text", text: `[attachment not available: ${label} (${part.mediaType})]` })
    }
  }
  return { blocks, warnings }
}

const DATA_URL = /^data:([^;,]+)?((?:;[^;,]+)*?);base64,(.*)$/s

/** Inline images only: vibe cannot fetch URLs, and ACP image blocks carry base64 plus the original mime type. */
function imageBlock(part: FilePart): { block: ContentBlock; reason?: undefined } | { block?: undefined; reason: string } {
  if (!part.mediaType.startsWith("image/")) return { reason: "vibe accepts only images as attachments" }
  if (part.data instanceof URL) {
    const reason = "vibe cannot fetch image URLs; attach the image as a file instead"
    if (part.data.protocol !== "data:") return { reason }
    return dataUrl(part.data.href, part.mediaType) ?? { reason }
  }
  if (typeof part.data === "string") {
    if (/^https?:/i.test(part.data)) return { reason: "vibe cannot fetch image URLs; attach the image as a file instead" }
    if (part.data.startsWith("data:")) return dataUrl(part.data, part.mediaType) ?? { reason: "malformed data: URL" }
  }
  const data = typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64")
  return { block: { type: "image", data, mimeType: concreteImageType(part.mediaType) } }
}

function dataUrl(url: string, declared: string) {
  const match = DATA_URL.exec(url)
  if (!match) return undefined
  const mime = match[1]?.startsWith("image/") ? match[1] : declared
  return { block: { type: "image", data: match[3]!, mimeType: concreteImageType(mime) } } as const
}

/** `image/*` is a wildcard, not a subtype; every concrete `image/<subtype>` is kept as given. */
const concreteImageType = (mime: string) => (mime === "image/*" ? "image/png" : mime)

/** Renders messages as plain text for replay into a fresh vibe conversation. */
export function renderHistory(messages: readonly LanguageModelV3Message[]) {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === "system") continue
    if (message.role === "user") {
      lines.push(`[user]\n${message.content.map(partText).join("\n")}`)
      continue
    }
    if (message.role === "assistant") {
      const body = message.content.flatMap((part) => {
        if (part.type === "text") return [part.text]
        if (part.type === "tool-call")
          return [`(called tool ${part.toolName} with ${clip(typeof part.input === "string" ? part.input : JSON.stringify(part.input))})`]
        if (part.type === "tool-result") return [`(tool ${part.toolName} returned ${clip(outputText(part.output))})`]
        if (part.type === "file") return [`[file: ${part.mediaType}]`]
        return []
      })
      lines.push(`[assistant]\n${body.join("\n")}`)
      continue
    }
    lines.push(
      `[tool results]\n${message.content.map((part) => (part.type === "tool-result" ? `${part.toolName}: ${clip(outputText(part.output))}` : "(approval response)")).join("\n")}`,
    )
  }
  return keepRecent(lines)
}

/** Everything vibe needs to resume the conversation: replayed history, then the new user input. */
export function catchUpContent(prompt: LanguageModelV3Prompt, latestStart: number): Rendered {
  const history = renderHistory(prompt.slice(0, latestStart))
  const latest = userContent(prompt.slice(latestStart))
  const intro = history
    ? [
        "This conversation is being continued in a fresh session, so the earlier turns are replayed below as context.",
        "They really happened: your earlier replies and the results of your tool calls are included.",
        "Do not repeat or summarise them. Answer only the request that follows the closing tag.",
        "",
        "<conversation-history>",
        history,
        "</conversation-history>",
      ].join("\n")
    : ""
  const blocks: ContentBlock[] = intro ? [{ type: "text", text: intro }, ...latest.blocks] : latest.blocks
  if (latest.blocks.length === 0) blocks.push({ type: "text", text: "Please continue." })
  return { blocks, warnings: latest.warnings }
}

/**
 * Throwaway request (title, compaction, ...): the system prompt matters here, because these calls are
 * defined by their instructions, so it is included as text.
 */
export function flattenContent(prompt: LanguageModelV3Prompt): Rendered {
  const system = prompt.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("\n\n")
  const conversation = renderHistory(prompt)
  const text = [
    "Answer the task below directly in plain text. Do not use any tools, do not read or modify files, and do not run commands.",
    system ? `\n<instructions>\n${system}\n</instructions>` : "",
    conversation ? `\n<conversation>\n${conversation}\n</conversation>` : "",
  ].join("\n")
  const media = userContent(prompt.filter((message) => message.role === "user").slice(-1))
  return { blocks: [{ type: "text", text }, ...media.blocks.filter((block) => block.type === "image")], warnings: media.warnings }
}

function partText(part: UserMessage["content"][number]) {
  if (part.type === "text") return part.text
  return part.mediaType.startsWith("image/") ? "[image attached earlier]" : `[file: ${part.filename ?? part.mediaType}]`
}

function outputText(output: { type: string; value?: unknown; reason?: string }): string {
  if (output.type === "text" || output.type === "error-text") return String(output.value)
  if (output.type === "execution-denied") return `denied${output.reason ? `: ${output.reason}` : ""}`
  if (output.type === "content" && Array.isArray(output.value))
    return output.value.map((item: { type: string; text?: string }) => (item.type === "text" ? item.text : `[${item.type}]`)).join("\n")
  return JSON.stringify(output.value)
}

const clip = (text: string) => (text.length > MAX_TOOL_CHARS ? `${text.slice(0, MAX_TOOL_CHARS)}… [truncated]` : text)

/** Drops the oldest messages first when the replay would be enormous. */
function keepRecent(lines: string[]) {
  let total = 0
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (total + line.length > MAX_HISTORY_CHARS && kept.length > 0) {
      kept.unshift(`[${i + 1} earlier message(s) omitted]`)
      break
    }
    total += line.length
    kept.unshift(line)
  }
  return kept.join("\n\n")
}
