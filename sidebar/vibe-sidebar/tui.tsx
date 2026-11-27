// TUI half of vibe-sidebar: the Vibe block in the session sidebar.
//
// OpenCode's builtin `opencode.sidebar.context` renders
// "Context N tokens · X% used · $Y spent", but for a Vibe session that line is
// thin in three ways:
//
//   1. it prints spend with Intl currency defaults, so two decimals. A Vibe
//      turn costs fractions of a cent and a whole session is often under
//      $0.01 — the native line says "$0.00 spent" while Vibe really billed.
//   2. it shows one prompt-token total. Vibe's prompt is mostly cache reads
//      (the ACP `usage_update` splits cached from uncached input), and that
//      split is what explains why a long session stays cheap.
//   3. its numbers come from the session record, which for a Vibe session
//      double counts: the ACP runtime adds each turn's usage to the session
//      totals on top of the per-message usage the provider already reported.
//      A measured turn billed 6,396 in / 43 out / $0.0104 and left session
//      totals of 13,286 in / 741 out / $0.0264. So this block never reads the
//      session totals; it sums the assistant messages, which match the
//      provider's own per-call usage.
//
// The block keeps the native shape — bold label, muted values, one line of
// facts — and adds the breakdown:
//
//     Vibe $0.0104 · 1 turn · $0.0104/turn
//     ↑6,396 · ↓43 · cache 3,072 (32%)
//     ctx 13% of 71k
//
// The third line is the native context gauge, rebuilt on honest numbers. The
// builtin one reads the session record, which is inflated (point 3) and would
// show a share of the window several times too large. This one divides the last
// turn's prompt — cached plus uncached, since both occupy the window — by the
// window the vibe catalog learned from Vibe's own `usage_update.size`. It is
// omitted until that model has run once, rather than falling back to a guess.
//
// It renders only for sessions on the `vibe` provider, so a native provider's
// sidebar is untouched. Reverts are respected the same way the native blocks
// respect them: messages after the revert marker are not counted.
//
// Loaded from ~/.config/opencode/plugins/vibe-sidebar/tui.tsx: OpenCode scans
// that directory and resolves a plugin's TUI half as `<dir>/tui`.

import { Plugin } from "@opencode/plugin/tui"

const PROVIDER_ID = "vibe"

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const plain = new Intl.NumberFormat("en-US")

interface Tokens {
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number }
}

interface Message {
  readonly id: string
  readonly type?: string
  readonly cost?: number
  readonly tokens?: Tokens
}

/** Token counts stay readable inside the 42-column sidebar. */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  return value >= 10_000 ? compact.format(value) : plain.format(value)
}

/**
 * Sub-cent spend needs more than two decimals. The ladder keeps two significant
 * digits below a dollar: $0.0104, $0.264, $1.28.
 */
function formatCost(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

/** A context window reads better abbreviated: 71,072 -> "71k", 1,048,576 -> "1M". */
function formatWindow(value: number): string {
  return compact.format(value)
}

/** Messages after a revert marker are undone and must not count. */
function visible(messages: Message[], revertID?: string): Message[] {
  if (!revertID) return messages
  const index = messages.findIndex((message) => message.id === revertID)
  return index < 0 ? messages : messages.slice(0, index)
}

export function VibeBlock(props: { context: any; sessionID: string }) {
  const theme = props.context.theme
  const accent = theme.text.base
  const muted = theme.text.muted

  const session = () => props.context.data.session.get(props.sessionID)
  const isVibe = () => session()?.model?.providerID === PROVIDER_ID

  const assistants = () =>
    visible(
      props.context.data.session.message.list(props.sessionID) ?? [],
      session()?.revert?.messageID,
    ).filter((message) => message.type === "assistant")

  const tokens = () => {
    const sum = { input: 0, output: 0, read: 0 }
    for (const message of assistants()) {
      const value = message.tokens
      if (!value) continue
      sum.input += value.input ?? 0
      sum.output += value.output ?? 0
      sum.read += value.cache?.read ?? 0
    }
    return sum
  }

  const spend = () => {
    let total = 0
    for (const message of assistants()) total += message.cost ?? 0
    return total
  }

  const turns = () => assistants().length

  const cached = () => {
    const value = tokens()
    const prompt = value.input + value.read
    if (value.read <= 0 || prompt <= 0) return undefined
    return { read: value.read, percent: Math.round((value.read / prompt) * 100) }
  }

  const hasUsage = () => {
    const value = tokens()
    return value.input + value.output + value.read > 0
  }

  /**
   * The model's context window, as the opencode-with-vibe catalog learned it
   * from Vibe's own `usage_update.size`. Absent until that model has run once.
   */
  const modelWindow = () => {
    const model = session()?.model
    if (!model) return undefined
    const models = props.context.data.location.model.list() ?? []
    const entry = models.find(
      (candidate: any) =>
        candidate?.providerID === model.providerID && candidate?.id === model.id,
    )
    const context = entry?.limit?.context
    return typeof context === "number" && Number.isFinite(context) && context > 0
      ? context
      : undefined
  }

  /**
   * Live context is the prompt of the last turn, not a sum over turns: every
   * turn re-sends the conversation, so summing would multiply it. Cached and
   * uncached prompt tokens both occupy the window.
   */
  const liveContext = () => {
    const list = assistants()
    for (let index = list.length - 1; index >= 0; index--) {
      const value = list[index]?.tokens
      if (!value) continue
      const prompt = (value.input ?? 0) + (value.cache?.read ?? 0)
      if (prompt > 0) return prompt
    }
    return undefined
  }

  const gauge = () => {
    const used = liveContext()
    const window = modelWindow()
    if (used === undefined || window === undefined) return undefined
    return { used, window, percent: Math.min(100, Math.round((used / window) * 100)) }
  }

  const summary = () => {
    const parts: string[] = []
    const count = turns()
    const cost = formatCost(spend())
    if (cost) parts.push(cost)
    if (count > 0) parts.push(`${count} ${count === 1 ? "turn" : "turns"}`)
    const perTurn = count > 1 ? formatCost(spend() / count) : undefined
    if (cost && perTurn) parts.push(`${perTurn}/turn`)
    return parts.join(" \u00B7 ")
  }

  const breakdown = () => {
    const value = tokens()
    const parts = [`\u2191${formatTokens(value.input)}`, `\u2193${formatTokens(value.output)}`]
    const hit = cached()
    if (hit) parts.push(`cache ${formatTokens(hit.read)} (${hit.percent}%)`)
    return parts.join(" \u00B7 ")
  }

  const contextLine = () => {
    const value = gauge()
    if (!value) return undefined
    return `ctx ${value.percent}% of ${formatWindow(value.window)}`
  }

  return (
    <box flexDirection="column">
      {isVibe() && hasUsage() ? (
        <box flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={accent}>
              <b>Vibe</b>
            </text>
            <text fg={muted}>{summary()}</text>
          </box>
          <text fg={muted}>{breakdown()}</text>
          {contextLine() ? <text fg={muted}>{contextLine()}</text> : null}
        </box>
      ) : null}
    </box>
  )
}

export default Plugin.define({
  id: "vibe-sidebar",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <VibeBlock context={context} sessionID={input.sessionID} />,
    })
  },
})
