import type { Plugin, PluginOptions } from "@opencode/plugin"
import { AcpClient, type AcpClientOptions } from "./acp/client"
import { createCatalog, discoverOnce, readCatalog, serializeCatalog } from "./catalog"
import { KIND_HEADER, PROVIDER_ID as MODEL_PROVIDER, SESSION_HEADER, VibeLanguageModel } from "./model"
import { DEFAULT_CATALOG, PROVIDER_ID, PROVIDER_NAME, PROVIDER_PACKAGE, toModel } from "./models"
import { policyOf } from "./plan"
import { probeCatalog } from "./probe"
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { install, peek, resolve, runtimeKey, type Runtime } from "./runtime"
import { VibeSessions } from "./sessions"

type VibePlugin = Plugin.Plugin

export const PLUGIN_ID = "opencode-with-vibe"

const CATALOG_KEY = "catalog.v2"

/** Top-level entries of the real Vibe home that are volatile (locks, logs, caches) and must never be mirrored. */
const VOLATILE_HOME_ENTRIES = new Set(["logs", "cache", "locks", "skills-registry-cache"])

/**
 * Builds the `VIBE_HOME` a discovery probe runs against by mirroring the user's real Vibe home into a scratch
 * directory. The probe must never touch the real home (a probe run switches `active_model` in `config.toml`), but an
 * empty home reports a reduced model list, so the full state (minus volatile entries) is copied instead. The real
 * home is read-only here; only the copy is written to by the probe. Returns undefined when the real home is absent or
 * the copy fails, in which case the caller falls back to a fresh empty temp home.
 */
export function mirrorProbeHome(): string | undefined {
  const realHome = process.env.VIBE_HOME ?? join(homedir(), ".vibe")
  if (!existsSync(realHome)) return undefined
  const destination = mkdtempSync(join(tmpdir(), "opencode-vibe-probe-"))
  try {
    cpSync(realHome, destination, {
      recursive: true,
      filter: (source) => {
        // Sockets and pipes cannot be copied; skip them alongside locks and known volatile directories.
        try {
          const stats = statSync(source)
          if (!stats.isDirectory() && !stats.isFile()) return false
        } catch {
          return false
        }
        const relative = source.slice(realHome.length).replace(/^[\\/]+/, "")
        if (relative === "") return true
        const top = relative.split(/[\\/]/)[0]!
        if (VOLATILE_HOME_ENTRIES.has(top)) return false
        if (relative.split(/[\\/]/).some((part) => part.endsWith(".lock"))) return false
        return true
      },
    })
    return destination
  } catch {
    rmSync(destination, { recursive: true, force: true })
    return undefined
  }
}

/** Plugin options, as written in `opencode.jsonc` (`{ "package": "...", "options": { ... } }`). */
export interface VibeOptions {
  /** `allow` (default) approves every Vibe permission request; `deny` rejects them. */
  permission?: "allow" | "deny"
  /**
   * Home directory for Vibe state used by model discovery probe only. When omitted, the real home is mirrored into a
   * temp dir (volatile entries excluded) so the probe sees the full model list without mutating the real config.
   */
  probeHome?: string
}

export function readOptions(raw: PluginOptions | undefined): VibeOptions {
  const options = raw as VibeOptions | undefined
  return {
    permission: options?.permission === "deny" ? "deny" : "allow",
    probeHome: typeof options?.probeHome === "string" ? options.probeHome : undefined,
  }
}

export interface PluginDependencies {
  /** How the vibe-acp process wrapper is built. Tests substitute a scripted fake agent. */
  createClient?: (options: AcpClientOptions) => AcpClient
}

export function createPlugin(dependencies: PluginDependencies = {}): VibePlugin {
  const createClient = dependencies.createClient ?? ((options) => new AcpClient(options))
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = readOptions(ctx.options)
      const cwd = ctx.location.directory

      // The child process is spawned lazily by the first request, never at startup.
      // A user-supplied home is used as-is and never removed; otherwise we mirror the real home into a temp dir we
      // own (falling back to a fresh empty one) and clean it up on dispose.
      const mirrored = options.probeHome === undefined ? mirrorProbeHome() : undefined
      const ownedProbeHome = options.probeHome === undefined ? mirrored ?? mkdtempSync(join(tmpdir(), "opencode-vibe-probe-")) : undefined
      const probeHome = options.probeHome ?? ownedProbeHome!
      const client = createClient({
        permission: options.permission,
        cwd,
      })
      const probeClient = createClient({
        permission: options.permission,
        cwd,
        env: { ...process.env, VIBE_HOME: probeHome },
      })

      const catalog = createCatalog(
        readCatalog(await ctx.storage.get(CATALOG_KEY)) ?? [...DEFAULT_CATALOG],
        async (next) => {
          await ctx.storage.set(CATALOG_KEY, serializeCatalog(next))
          await ctx.provider.reload()
        },
      )

      const sessions = new VibeSessions(
        client,
        {
          get: (key) => ctx.storage.get(key),
          set: (key, value) => ctx.storage.set(key, value as unknown as Parameters<typeof ctx.storage.set>[1]),
        },
        {
          cwd,
          catalog: catalog.find,
          // The active OpenCode agent is what makes a plan turn read-only: its rules answer Vibe's permission
          // requests, and its instructions ride along in the prompt. An agent that cannot be read yields no policy
          // rather than a guessed one, because a guessed policy would restrict a session the user never restricted.
          policy: async (sessionID: string) => {
            try {
              const session = await ctx.session.get({ sessionID })
              if (!session.agent) return undefined
              const agent = await ctx.agent.get({ agentID: session.agent })
              return policyOf(agent.data, session.permissions)
            } catch {
              return undefined
            }
          },
          // Looks up which thinking levels each model offers, once, without sending any prompt.
          onChatSession: discoverOnce(() => probeCatalog(probeClient, cwd), catalog.update),
        },
      )

      let disposed = false
      const runtime: Runtime = {
        run: (request) => sessions.run(request),
        model: catalog.find,
        // The context window comes from `usage_update.size`; `toModel` reads it back on the next provider reload.
        learn: (modelId, context) => catalog.learn(modelId, context),
        disposed: () => disposed,
        dispose: async () => {
          if (disposed) return
          disposed = true
          sessions.dispose()
          await Promise.allSettled([client.dispose(), probeClient.dispose()])
          if (ownedProbeHome) rmSync(ownedProbeHome, { recursive: true, force: true })
        },
      }
      // From here on this generation owns the project's runtime; the previous one (if any) is retired.
      const key = runtimeKey(PLUGIN_ID, cwd)
      const release = install(key, runtime)

      const registrations = await Promise.all([
        ctx.provider.transform((editor) => {
          editor.add({
            info: {
              id: PROVIDER_ID,
              name: PROVIDER_NAME,
              activation: "auto",
              package: PROVIDER_PACKAGE,
            } as Parameters<typeof editor.add>[0]["info"],
            models: catalog.current().map(toModel),
          })
        }),
        ctx.aisdk.hook(
          "sdk",
          (event) => {
            // OpenCode keeps this SDK (and the models it makes) for as long as the project is open, across plugin
            // reloads, so nothing here may capture this generation's client or sessions: look them up per call.
            event.sdk = {
              languageModel: (modelID: string) =>
                new VibeLanguageModel(modelID, {
                  run: (request) => resolve(key).run(request),
                  model: (id) => peek(key)?.model(id),
                  learn: (id, context) => peek(key)?.learn(id, context),
                }),
            }
          },
          { providerID: PROVIDER_ID },
        ),
        ctx.session.hook(
          "model.request",
          (event) => {
            // The kind is the only thing OpenCode does not already send. It sets `x-opencode-session-id` itself
            // (session/model-request.ts); repeating it here is a harmless fallback should that ever change.
            event.headers[KIND_HEADER] = event.kind
            event.headers[SESSION_HEADER] = event.sessionID
          },
          { providerID: MODEL_PROVIDER },
        ),
        // Replaying a failed step would repeat Vibe's side effects (file writes, commands) and permanent auth errors.
        ctx.session.hook(
          "retry",
          (event) => {
            event.decision = { retry: false }
          },
          { providerID: PROVIDER_ID },
        ),
      ]).catch(async (error) => {
        // A failed setup must not leave a live runtime (and its vibe-acp process) behind.
        await release()
        throw error
      })

      return async () => {
        await Promise.all(registrations.map((registration) => registration.dispose().catch(() => {})))
        await release()
      }
    },
  }
}

export default createPlugin()
