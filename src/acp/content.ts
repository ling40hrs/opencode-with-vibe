/**
 * Text of an ACP `content` field. The spec says one content block, but be lenient: also accept an array of blocks,
 * a bare string, a `{ content: ... }` wrapper and embedded text resources. `vibe-acp` always sends `{type, text}`.
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(contentText).join("")
  if (content && typeof content === "object") {
    const block = content as { text?: unknown; content?: unknown; resource?: { text?: unknown } }
    if (typeof block.text === "string") return block.text
    if (typeof block.resource?.text === "string") return block.resource.text
    if (block.content !== undefined) return contentText(block.content)
  }
  return ""
}
