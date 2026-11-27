import type { Plugin, PluginOptions } from "@opencode/plugin";
import { AcpClient, type AcpClientOptions } from "./acp/client";
type VibePlugin = Plugin.Plugin;
export declare const PLUGIN_ID = "opencode-with-vibe";
/**
 * Builds the `VIBE_HOME` a discovery probe runs against by mirroring the user's real Vibe home into a scratch
 * directory. The probe must never touch the real home (a probe run switches `active_model` in `config.toml`), but an
 * empty home reports a reduced model list, so the full state (minus volatile entries) is copied instead. The real
 * home is read-only here; only the copy is written to by the probe. Returns undefined when the real home is absent or
 * the copy fails, in which case the caller falls back to a fresh empty temp home.
 */
export declare function mirrorProbeHome(): string | undefined;
/** Plugin options, as written in `opencode.jsonc` (`{ "package": "...", "options": { ... } }`). */
export interface VibeOptions {
    /** `allow` (default) approves every Vibe permission request; `deny` rejects them. */
    permission?: "allow" | "deny";
    /**
     * Home directory for Vibe state used by model discovery probe only. When omitted, the real home is mirrored into a
     * temp dir (volatile entries excluded) so the probe sees the full model list without mutating the real config.
     */
    probeHome?: string;
}
export declare function readOptions(raw: PluginOptions | undefined): VibeOptions;
export interface PluginDependencies {
    /** How the vibe-acp process wrapper is built. Tests substitute a scripted fake agent. */
    createClient?: (options: AcpClientOptions) => AcpClient;
}
export declare function createPlugin(dependencies?: PluginDependencies): VibePlugin;
declare const _default: Plugin.Plugin;
export default _default;
