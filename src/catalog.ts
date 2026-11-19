import type { CatalogModel, Thinking } from "./models"

type Debug = (message: string, data?: unknown) => void

/**
 * The model list shown in OpenCode. `update` is fire-and-forget (it runs next to a chat request): a failure to
 * persist or reload is logged, never thrown, and the in-memory list is only replaced when it actually changed.
 */
export function createCatalog(initial: CatalogModel[], persist: (next: CatalogModel[]) => Promise<void>, debug?: Debug) {
  let models = initial
  const apply = (next: CatalogModel[]) => {
    models = next
    persist(models).catch((error) => debug?.("catalog refresh failed", String(error)))
  }
  return {
    current: () => models,
    find: (id: string) => models.find((model) => model.id === id),
    update: (next: readonly CatalogModel[]) => {
      if (next.length === 0 || JSON.stringify(next) === JSON.stringify(models)) return
      // Safety net: a probe run against a reduced/empty home would otherwise drop models the user still has. Never
      // drop an id the current catalog knows; adding models (a new Vibe release) is always allowed.
      const dropped = models.filter((model) => !next.some((candidate) => candidate.id === model.id)).map((model) => model.id)
      if (dropped.length > 0) {
        debug?.(`catalog update rejected: would drop ${dropped.join(", ")}`)
        return
      }
      apply([...next])
    },
    /** Records the context window Vibe reported for a model (`usage_update.size`). */
    learn: (modelId: string, context: number) => {
      if (!Number.isFinite(context) || context <= 0) return
      const index = models.findIndex((model) => model.id === modelId)
      if (index < 0 || models[index]!.context === context) return
      const next = [...models]
      next[index] = { ...models[index]!, context }
      apply(next)
    },
  }
}

/**
 * Runs the (prompt-free) model probe once per plugin lifetime, the first time a chat conversation is created, and
 * feeds the result to `apply`. A failed probe is logged and tried again at the next chat conversation.
 */
export function discoverOnce(run: () => Promise<CatalogModel[] | undefined>, apply: (models: CatalogModel[]) => void, debug?: Debug) {
  let state: "idle" | "running" | "done" = "idle"
  return () => {
    if (state !== "idle") return
    state = "running"
    run().then(
      (models) => {
        if (models && models.length > 0) apply(models)
        state = "done"
      },
      (error) => {
        debug?.("model discovery failed", String(error))
        state = "idle"
      },
    )
  }
}

const STORAGE_VERSION = 2

/** Storage form: plain JSON, versioned so a future layout change never misreads an old entry. */
export function serializeCatalog(models: readonly CatalogModel[]) {
  return {
    v: STORAGE_VERSION,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.thinking ? { thinking: { levels: [...model.thinking.levels], default: model.thinking.default } } : {}),
      ...(model.context !== undefined ? { context: model.context } : {}),
    })),
  }
}

/** Reads the stored catalog; anything that is not the current, well-formed layout counts as "nothing stored". */
export function readCatalog(value: unknown): CatalogModel[] | undefined {
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== STORAGE_VERSION) return undefined
  const list = (value as { models?: unknown }).models
  if (!Array.isArray(list)) return undefined
  const models = list.flatMap((item): CatalogModel[] => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.name !== "string") return []
    const thinking = readThinking(item.thinking)
    const context = (item as { context?: unknown }).context
    return [
      {
        id: item.id,
        name: item.name,
        ...(thinking ? { thinking } : {}),
        ...(typeof context === "number" && Number.isFinite(context) && context > 0 ? { context } : {}),
      },
    ]
  })
  return models.length > 0 ? models : undefined
}

function readThinking(value: unknown): Thinking | undefined {
  if (!value || typeof value !== "object") return undefined
  const { levels, default: fallback } = value as { levels?: unknown; default?: unknown }
  if (!Array.isArray(levels) || levels.length === 0 || !levels.every((level) => typeof level === "string")) return undefined
  return { levels, default: typeof fallback === "string" && levels.includes(fallback) ? fallback : levels[levels.length - 1]! }
}
