import { ANY_REPLY, type Group } from "./fingerprint"

/** What is persisted per OpenCode session so the matching vibe conversation can be found again. */
export interface SessionRecord {
  v: 1
  /** vibe conversation id (the ACP session id). */
  acpSessionId: string
  /** Last model applied to that conversation. */
  model: string
  /** Working directory the conversation was created with. */
  cwd: string
  /** Hashes of the groups vibe has already seen, in order. A trailing `ANY_REPLY` marks an interrupted turn. */
  history: string[]
}

export type Decision =
  /** No usable conversation: create one and replay the prompt as text. */
  | { kind: "fresh"; reason: "no-record" | "diverged" | "no-new-input" | "unexpected-groups" }
  /** The recorded conversation is a prefix: send only `groups[from..]` (all user messages). */
  | { kind: "continue"; from: number }

export function decide(groups: readonly Group[], record: SessionRecord | undefined): Decision {
  if (!record || record.history.length === 0) return { kind: "fresh", reason: "no-record" }
  const saved = record.history
  let s = 0
  let g = 0
  while (s < saved.length) {
    const entry = saved[s]!
    if (entry === ANY_REPLY) {
      // Only the final entry can be an interrupted reply; anywhere else it is a corrupt record.
      if (s !== saved.length - 1) break
      if (groups[g]?.role === "assistant") g++
      s++
      continue
    }
    if (g >= groups.length || groups[g]!.hash !== entry) break
    s++
    g++
  }
  // A revert, an edited message, a compaction summary or another model's reply all end up here.
  if (s < saved.length) return { kind: "fresh", reason: "diverged" }
  const rest = groups.slice(g)
  if (rest.length === 0) return { kind: "fresh", reason: "no-new-input" }
  if (rest.some((group) => group.role !== "user")) return { kind: "fresh", reason: "unexpected-groups" }
  return { kind: "continue", from: g }
}
