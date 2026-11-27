// Plan mode for a Vibe session, reconstructed from the OpenCode agent that is active.
//
// OpenCode's Plan agent is not a special mechanism. It is three ordinary things, all of which this plugin can see
// through the host API and none of which cross the ACP boundary on their own:
//
//   1. instructions — the agent carries `instructions.selected` and `instructions.unselected`. OpenCode puts the
//      first in the system prompt while the agent is active, and the second once, after the user switches away, so
//      the model learns its earlier restrictions no longer apply. Measured on this machine: the Plan agent's text
//      names the depth of the rule ("you remain in Plan mode until the user switches agents") and the one directory
//      it may write to, `/home/ling/.opencode/plan`.
//   2. permissions — `Agent.Info.permissions` is an ordered list of `{ action, resource, effect }`. Later rules
//      override earlier ones, which is how Plan denies `edit` everywhere and then allows it under its plan
//      directory, and how it allows `git status` but asks for the rest of `git`.
//   3. the handshake — Plan refuses work and tells the user to switch agents. There is no tool and no dialog. The
//      switch is the user's, and `instructions.unselected` is what ends plan mode in the transcript.
//
// So a Vibe session runs "in plan mode" when the plugin (a) injects `selected` into the prompt, (b) answers Vibe's
// permission requests by evaluating the agent's own rule list instead of blindly allowing them, and (c) injects
// `unselected` on the first turn after the agent changed. All three use the same strings and the same rules OpenCode
// would, so the two agents cannot drift apart.

/** One entry of an OpenCode agent's `permissions` list. */
export interface Rule {
  action: string
  resource: string
  effect: string
}

/** The instruction pair an OpenCode agent carries. Either may be absent. */
export interface Instructions {
  selected?: string
  unselected?: string
}

/** What governs one Vibe session: the active OpenCode agent's rules and instructions. */
export interface Policy {
  /** Id of the OpenCode agent this policy came from, for logging. */
  agent: string
  rules: readonly Rule[]
  instructions: Instructions
}

/**
 * Matches a permission resource, the way OpenCode writes them: `*`, `.git/*`, `git status *`, `*.env`.
 *
 * `*` spans separators on purpose. The rules mix command lines (`git status *`), project-relative paths (`.git/*`)
 * and absolute paths (`/home/ling/.opencode/plan/*`), and the same pattern has to match whichever form the tool call
 * reports. A per-segment wildcard would fail on every absolute path and turn a deny into a fall-through.
 */
export function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

/**
 * Evaluates one action against an agent's rules. Later rules win, and no match asks.
 *
 * A path is tested in both the absolute and the project-relative form, because an agent file may write either and a
 * tool call reports what it was given. Both matching is deliberate: a rule that names `.git/*` must still catch
 * `/home/ling/project/.git/HEAD`.
 */
export function decide(rules: readonly Rule[], action: string, resource: string, cwd?: string): "allow" | "deny" | "ask" {
  const candidates = cwd && resource.startsWith(cwd) ? [resource, resource.slice(cwd.length).replace(/^[/\\]/, "")] : [resource]
  let effect: "allow" | "deny" | "ask" | undefined
  for (const rule of rules) {
    if (rule.action !== "*" && rule.action !== action) continue
    if (!candidates.some((candidate) => matches(rule.resource, candidate))) continue
    // Only the three effects this plugin acts on; anything else (a future effect) means "ask".
    effect = rule.effect === "allow" || rule.effect === "deny" ? rule.effect : "ask"
  }
  return effect ?? "ask"
}

/**
 * Whether the agent restricts anything at all. A fully permissive agent (`* * allow`, which is what `build` is) needs
 * no approval round trips, so the session stays in Vibe's auto-approve mode and no request is answered here.
 */
export function restricts(rules: readonly Rule[]): boolean {
  return rules.some((rule) => rule.effect !== "allow")
}

/** A tool call, as Vibe reports it on `session/update`. Only the fields the mapping reads. */
export interface CallLike {
  kind?: string
  title?: string
  locations?: { path?: string }[]
  rawInput?: unknown
  _meta?: { tool_name?: string }
}

function input(call: CallLike): Record<string, unknown> {
  const raw = call.rawInput
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/**
 * The path a call touches, from the tool's own input first (`file_path` is Vibe's edit/write field) and the sparse
 * ACP `locations` second, which is what a `read` or a `grep` may carry instead.
 */
export function pathOf(call: CallLike): string | undefined {
  const raw = input(call)
  return text(raw.file_path) ?? text(raw.path) ?? text(raw.pattern) ?? text(call.locations?.[0]?.path)
}

/**
 * Maps a Vibe tool call to the OpenCode action and resource its rules speak in.
 *
 * The internal tool name (`_meta.tool_name`) is what Vibe actually ran (`write_file`, `bash`, `read_file`); `kind` is
 * the coarser ACP classification and only serves as a fallback for a tool this mapping has not met.
 */
export function actionOfCall(call: CallLike): { action: string; resource: string } {
  const name = call._meta?.tool_name ?? ""
  const raw = input(call)
  switch (name) {
    case "bash":
    case "git_bash":
    case "experimental_bash":
      return { action: "shell", resource: text(raw.command) ?? call.title ?? "" }
    case "edit":
    case "write_file":
      return { action: "edit", resource: pathOf(call) ?? "" }
    case "read_file":
      return { action: "read", resource: pathOf(call) ?? "" }
    case "grep":
      return { action: "grep", resource: pathOf(call) ?? "" }
    case "web_fetch":
    case "web_search":
      return { action: "webfetch", resource: text(raw.url) ?? text(raw.query) ?? "" }
    case "ask_user_question":
      return { action: "question", resource: "" }
    case "task":
      return { action: "subagent", resource: "" }
    default:
      break
  }
  switch (call.kind) {
    case "execute":
      return { action: "shell", resource: text(raw.command) ?? call.title ?? "" }
    case "edit":
      return { action: "edit", resource: pathOf(call) ?? "" }
    case "read":
      return { action: "read", resource: pathOf(call) ?? "" }
    case "fetch":
      return { action: "webfetch", resource: text(raw.url) ?? "" }
    default:
      // An unmapped tool is governed only by a rule that names it or `*`; nothing else may silently allow it.
      return { action: name || "other", resource: "" }
  }
}

/** The instruction pair of an agent, tolerating the shapes the API may hand back. */
export function instructionsOf(info: { instructions?: unknown } | undefined): Instructions {
  const raw = info?.instructions
  if (!raw || typeof raw !== "object") return {}
  const value = raw as { selected?: unknown; unselected?: unknown }
  const selected = text(value.selected)
  const unselected = text(value.unselected)
  return { ...(selected ? { selected } : {}), ...(unselected ? { unselected } : {}) }
}

/**
 * Builds the policy of one session: the agent's rules, then the session's own rules appended (a session rule on a
 * Vibe conversation is OpenCode's way of narrowing an agent, and later rules win, so appending is the right merge).
 */
export function policyOf(
  agent: { id: string; permissions?: unknown; instructions?: unknown } | undefined,
  sessionRules?: unknown,
): Policy | undefined {
  if (!agent || typeof agent.id !== "string") return undefined
  return {
    agent: agent.id,
    rules: [...rulesOf(agent), ...rulesOf({ permissions: sessionRules })],
    instructions: instructionsOf(agent),
  }
}

/** What the previous turn in the same conversation left behind. */
export interface Previous {
  /** Whether that turn ran under an agent that restricts anything. */
  restricted: boolean
  /** That agent's `instructions.unselected`: the note to send once its restrictions stop applying. */
  unselected?: string
}

/**
 * The text a turn carries, or `undefined` when it carries none.
 *
 * The pair is asymmetric and easy to get wrong: `selected` belongs to the agent that is active now, but `unselected`
 * belongs to the agent that was left, which is why the previous turn's text comes in as an argument rather than being
 * read off the current policy. It is sent once — the first turn that is not restricted any more.
 *
 * A restricted agent with no `selected` text still gets one line, because Vibe reports a refused tool call as a bare
 * permission error and a model that does not know why would retry it.
 */
export function instructionText(policy: Policy | undefined, previous: Previous): string | undefined {
  if (policy && restricts(policy.rules)) {
    const body =
      policy.instructions.selected ||
      `Tool use is restricted by the OpenCode agent "${policy.agent}". Do not repeat a rejected tool call; report the restriction instead.`
    return `[OpenCode agent: ${policy.agent}]\n\n${body}`
  }
  return previous.restricted ? previous.unselected : undefined
}

/** The rules of an agent, dropping anything malformed rather than guessing at it. */
export function rulesOf(info: { permissions?: unknown } | undefined): Rule[] {
  const raw = info?.permissions
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const rule = entry as Record<string, unknown>
    if (typeof rule.action !== "string" || typeof rule.resource !== "string" || typeof rule.effect !== "string") return []
    return [{ action: rule.action, resource: rule.resource, effect: rule.effect }]
  })
}
