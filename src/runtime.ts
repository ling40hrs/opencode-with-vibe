import type { CatalogModel } from "./models"
import { VibeRetryableError, type RunOutcome, type RunRequest } from "./sessions"

/**
 * Everything a request needs from one plugin generation (one `setup()` call). A model instance never holds on to
 * the client or the sessions themselves: OpenCode caches SDKs and language models for the whole lifetime of a
 * project (`core/src/aisdk.ts` `sdks` / `languages` maps, only ever `get`/`set`, never cleared) while a hot reload of
 * the plugin closes its scope and disposes its client (`core/src/plugin.ts:149`). A cached instance from an older
 * generation therefore looks the current runtime up here, at call time.
 *
 * This is a cross-generation contract: an old module graph may call a newer runtime and vice versa. Keep it small and
 * backwards compatible, or change `REGISTRY` below.
 */
export interface Runtime {
  run(request: RunRequest): Promise<RunOutcome>
  model(modelId: string): CatalogModel | undefined
  /** Records the context window Vibe reported for a model so the provider can show it. */
  learn(modelId: string, context: number): void
  dispose(): Promise<void>
  disposed(): boolean
}

// `Symbol.for` plus `globalThis` so the registry survives the plugin's modules being re-imported on hot reload.
const REGISTRY = Symbol.for("opencode-with-vibe.runtimes.v1")

function registry(): Map<string, Runtime> {
  const holder = globalThis as unknown as { [REGISTRY]?: Map<string, Runtime> }
  return (holder[REGISTRY] ??= new Map())
}

/** One runtime per plugin and project directory. */
export const runtimeKey = (pluginID: string, directory: string) => `${pluginID}:${directory}`

/**
 * Makes `runtime` the live one for `key`. A runtime that was live before is retired on the spot, so a reload can
 * never leave two vibe-acp processes behind even if the old generation's cleanup runs late or never.
 * Returns the generation's cleanup: it disposes `runtime` and clears the entry only if it still owns it.
 */
export function install(key: string, runtime: Runtime) {
  const previous = registry().get(key)
  registry().set(key, runtime)
  if (previous && previous !== runtime) void previous.dispose().catch(() => {})
  return async () => {
    if (registry().get(key) === runtime) registry().delete(key)
    await runtime.dispose()
  }
}

/** The live runtime, or an error that says what to do. */
export function resolve(key: string): Runtime {
  const runtime = registry().get(key)
  if (!runtime) {
    throw new VibeRetryableError(
      "vibe plugin is not active in this project (it was unloaded). Reload the OpenCode configuration or restart OpenCode.",
    )
  }
  if (runtime.disposed()) {
    throw new VibeRetryableError("vibe plugin was reloading while this request started. Nothing was sent; try again.")
  }
  return runtime
}

/** Like `resolve`, but for lookups that can do without (the catalog entry of a model). */
export function peek(key: string): Runtime | undefined {
  const runtime = registry().get(key)
  return runtime && !runtime.disposed() ? runtime : undefined
}
