import type { Model } from "@opencode/plugin"

export const PROVIDER_ID = "vibe"
export const PROVIDER_NAME = "Mistral Vibe"
/** `aisdk:` marks the package as an in-process AI SDK provider; the name itself is only a tag. */
export const PROVIDER_PACKAGE = "aisdk:opencode-with-vibe"

/**
 * The key variant settings use, e.g. `{ "thoughtLevel": "medium" }`. This is an OpenCode *variant settings* key, not
 * an ACP one: it arrives as `providerOptions.vibe.thoughtLevel`. Do not confuse it with `THINKING_CONFIG_ID`.
 */
export const THOUGHT_LEVEL_KEY = "thoughtLevel"

/** The ACP config option Vibe exposes the base model under (matched by id or category). */
export const MODEL_CONFIG_ID = "model"
/**
 * The ACP config option Vibe exposes the thinking level under, passed to `session/set_config_option`. `vibe-acp` 3.1.3
 * reports it as `{"id":"thinking","name":"Thinking","category":"thinking"}`. Distinct from `THOUGHT_LEVEL_KEY`.
 */
export const THINKING_CONFIG_ID = "thinking"
/** The ACP config option Vibe exposes the session mode (permission policy) under (matched by id or category). */
export const MODE_CONFIG_ID = "mode"

/**
 * The level a request asks for from the selected variant's settings, which OpenCode delivers as
 * `providerOptions.vibe`. `thoughtLevel` is the primary key `toModel` writes; the ACP config id (`thinking`), the
 * camelCase spelling of it and the agy-era `thought_level` are accepted as aliases.
 */
export function requestedLevel(options: Record<string, unknown> | undefined): unknown {
  if (!options) return undefined
  return options[THOUGHT_LEVEL_KEY] ?? options[THINKING_CONFIG_ID] ?? options["thinkingLevel"] ?? options["thought_level"]
}

/** The thinking levels Vibe offers for one base model. */
export interface Thinking {
  levels: string[]
  /** What Vibe uses when no level is chosen. */
  default: string
}

/** One base Vibe model. Thinking levels are variants of it, never separate models. */
export interface CatalogModel {
  id: string
  name: string
  /** Absent for models without a thinking option. */
  thinking?: Thinking
  /** Context window in tokens, once `usage_update` reported it for this model. */
  context?: number
}

/** What `vibe-acp` 3.1.3 offered when this plugin was written. Replaced by what `session/new` reports. */
export const DEFAULT_CATALOG: readonly CatalogModel[] = [
  { id: "mistral-large-4-0", name: "Mistral Large 4", thinking: { levels: ["low", "medium", "high"], default: "high" } },
  { id: "mistral-medium-latest", name: "Mistral Medium 3.5", thinking: { levels: ["off", "high"], default: "high" } },
  { id: "zai-glm-5-3", name: "GLM 5.3 (Mistral Hosted)", thinking: { levels: ["low", "high", "max"], default: "max" } },
  {
    id: "zai-glm-5-3-flash",
    name: "GLM 5.3 Flash (Mistral Hosted)",
    thinking: { levels: ["low", "high", "max"], default: "high" },
  },
]

/**
 * Vibe reports the real window per session through `usage_update.size`, which the plugin stores on the model. Until a
 * model has actually been used, this is the size Vibe reported for its default model rather than a per-family guess.
 */
const UNKNOWN_CONTEXT = 202_144

/** Subscription usage is not billed per token, so every model is free as far as OpenCode is concerned. */
export function toModel(model: CatalogModel): Model.Info {
  return {
    id: model.id as Model.ID,
    modelID: model.id as Model.ID,
    providerID: PROVIDER_ID as Model.Info["providerID"],
    name: model.name,
    // Vibe is agentic and reads images; it only returns text.
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: (model.thinking?.levels ?? []).map((level) => ({
      id: level as Model.VariantID,
      settings: { [THOUGHT_LEVEL_KEY]: level },
    })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    // Output limit unknown: 0 means "not specified" in OpenCode (same as the Claude Agent provider).
    limit: { context: model.context ?? UNKNOWN_CONTEXT, output: 0 },
  }
}
