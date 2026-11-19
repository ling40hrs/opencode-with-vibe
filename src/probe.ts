import type { AcpClient } from "./acp/client"
import type { ConfigOption, SessionSetup } from "./acp/types"
import { MODEL_CONFIG_ID, MODE_CONFIG_ID, THINKING_CONFIG_ID, type CatalogModel, type Thinking } from "./models"

export const findOption = (options: ConfigOption[] | undefined, id: string) =>
  options?.find((option) => option.id === id || option.category === id)

/** The thinking levels in a `configOptions` list, if the current model has any. */
export function thinkingOf(options: ConfigOption[] | undefined): Thinking | undefined {
  const option = findOption(options, THINKING_CONFIG_ID)
  const levels = option?.options?.map((item) => item.value).filter(Boolean) ?? []
  if (!option || levels.length === 0) return undefined
  const fallback = option.options?.map((item) => item.value).filter(Boolean).at(-1)
  const value = option.currentValue && levels.includes(option.currentValue) ? option.currentValue : fallback
  return { levels, default: value ?? levels.at(-1)! }
}

/** The session mode currently selected: `ask`, `accept-edits`, `smart-approve` or `auto-approve`. */
export function modeOf(options: ConfigOption[] | undefined): string | undefined {
  return findOption(options, MODE_CONFIG_ID)?.currentValue
}

/**
 * Asks Vibe which base models exist and which thinking levels each offers, without sending a prompt: a scratch session
 * is switched through every model (`set_config_option`) and the reported options are read back. The scratch session
 * is closed afterwards. Returns undefined when Vibe does not describe its models this way.
 */
export async function probeCatalog(
  client: AcpClient,
  cwd: string,
  debug?: (message: string, data?: unknown) => void,
): Promise<CatalogModel[] | undefined> {
  const setup = await client.request<SessionSetup>("session/new", { cwd, mcpServers: [] })
  try {
    const modelOption = findOption(setup.configOptions, MODEL_CONFIG_ID)
    if (!modelOption?.options?.length) return undefined
    const models: CatalogModel[] = []
    for (const option of modelOption.options) {
      const base: CatalogModel = { id: option.value, name: option.name || option.value }
      try {
        const configured = await client.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
          sessionId: setup.sessionId,
          configId: modelOption.id,
          value: option.value,
        })
        const thinking = thinkingOf(configured.configOptions)
        models.push(thinking ? { ...base, thinking } : base)
      } catch (error) {
        // An odd model must not hide the others; list it without levels.
        debug?.("probe: model skipped levels", { model: option.value, error: String(error) })
        models.push(base)
      }
    }
    return models
  } finally {
    await client.request("session/close", { sessionId: setup.sessionId }).catch(() => {})
  }
}
