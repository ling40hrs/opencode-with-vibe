# opencode-with-vibe — fork with per-call token accounting and Vibe spend readouts

This is a fork of [ilyhalight/opencode-with-vibe](https://github.com/ilyhalight/opencode-with-vibe)
(0.1.0, MIT). It makes two additions, both outside upstream's source, and changes nothing
upstream wrote:

1. **A usage-mapping fix.** OpenCode no longer counts `vibe-acp`'s cumulative session totals
   as the usage of a single turn. That bug inflated the context gauge past 200% and triggered
   auto-compaction with a small real context. Read [`patch/README.md`](patch/README.md) for the
   diagnosis, the fix design, and the evidence.
2. **Two plugins that report what a session consumed** — a `vibe/*` price table and a sidebar
   block with cost, token split and an honest context gauge. See
   [`sidebar/README.md`](sidebar/README.md).

The fix lives in `src/`: [`src/usage.ts`](src/usage.ts) holds the per-session ledger, and
`src/convert.ts` maps usage from it instead of from the prompt result. `dist/plugin.js` is
that source built, committed for the reasons below. `patch/` keeps the original patch
against the shipped bundle, which is still how the same fix reaches a machine that loads
the npm package rather than this checkout.

## Using it on another machine

Measured on OpenCode v2.4.2. One route works, one needs a registry login, and the obvious
one — a git spec — does not work at all.

### Route 1: the plugin directory (works today)

OpenCode scans `~/.config/opencode/plugin/` and loads every plugin it finds there. Clone
this fork once per machine at a stable path and symlink the bundle in:

```bash
git clone https://github.com/ling40hrs/opencode-with-vibe.git ~/.local/share/opencode-with-vibe
git -C ~/.local/share/opencode-with-vibe checkout v0.1.0-fix.3
ln -sf ~/.local/share/opencode-with-vibe/dist/plugin.js ~/.config/opencode/plugin/opencode-with-vibe.js
```

Then drop the `opencode-with-vibe` entry from `plugins` in `opencode.json`, so the npm
package cannot load alongside it — both provide `vibe/*` providers. Restart OpenCode and
check:

```bash
opencode plugin list   # expect: opencode-with-vibe  local  ~/.config/opencode/plugin/opencode-with-vibe.js
```

`git -C ... checkout v0.1.0-fix.3` is what pins the machine. Use the commit sha instead of
the tag if you want immunity to a force-push.

### Route 2: publish to npm (works, needs credentials)

npm specs install correctly in v2.4.2, so publishing this repo makes the spec one string:

```json
{ "package": "opencode-with-vibe-fix@0.1.0-fix.3", "options": { "permission": "allow" } }
```

Not done here: this machine has no npm credentials (`npm whoami` returns `ENEEDAUTH`) and
`opencode-with-vibe-fix` is unclaimed on the registry. Run `npm publish` from a checkout and
then use the spec above.

### What does not work in v2.4.2

- **Git specs.** `opencode plugin add 'github:ling40hrs/opencode-with-vibe#v0.1.0-fix.3'`
  fails with `git dep preparation failed`, after which bun prints `Unrecognized flag:
  --force in command opencode` and friends — OpenCode's binary re-execs itself with npm
  flags and its own CLI rejects them. Pristine upstream
  (`github:ilyhalight/opencode-with-vibe`) fails identically, so this is an OpenCode bug,
  not something this fork can fix. Worth an upstream issue.
- **A filesystem path in the object form.** `{"package": "/abs/path/dist/plugin.js"}` is
  accepted without error and silently ignored — `opencode plugin list` shows nothing. Only
  the plugin-directory scan works for local code.

## Why `dist/` is committed here

Upstream's `.gitignore` excludes `dist/`, `package.json` sets `main` to `dist/plugin.js`,
and there is no `prepare` script — only `build`, which needs the dev dependencies. Any
consumer that resolves the package rather than the file finds nothing to load. Committing
the built bundle means no machine needs a toolchain, and Route 1 has something to link.

`dist/plugin.js` is reproducible from the source:

```bash
bun install --frozen-lockfile
bun test && bun run typecheck && bun run build   # writes dist/plugin.js
bun run scripts/smoke.ts                         # two real turns against vibe-acp
```

The bundle has no runtime dependencies — it imports only Node builtins — so `dist/plugin.js`
plus `dist/plugin.d.ts` are the whole artifact.

## The sidebar and pricing plugins

`sidebar/` holds two plugins that are independent of the bundle above. `dist/plugin.js` does
not contain them and cannot: one is a server plugin that edits the model table, the other is a
TUI plugin that claims a sidebar slot. A machine set up with Route 1 needs
`sidebar/install.sh` as well.

```bash
./sidebar/install.sh             # into ${OPENCODE_CONFIG:-~/.config/opencode}
./sidebar/install.sh --check     # report drift between source and installed copy
opencode plugin list | grep -E 'vibe-pricing|vibe-sidebar'
```

- **`vibe-pricing.ts`** sets `cost` on every `vibe/*` model with Vibe's own formula
  (`vibe/utils/pricing.py`, `session_token_cost`), so OpenCode's native cost readout has a
  price instead of the `cost: []` upstream declares. Rates come from Mistral's published price
  list, fetched at most once a day into `$XDG_CACHE_HOME/opencode/vibe-pricing.json`, merged
  per field over Vibe's builtin defaults and overridden by `~/.vibe/config.toml` prices.
- **`vibe-sidebar/`** appends a block to `sidebar.content` for `vibe` sessions only. It sums
  assistant messages rather than the session record — the ACP runtime double counts that
  record — formats sub-cent spend, and rebuilds the context gauge from the last turn's prompt
  over the window Vibe reported.

Why this is a plugin and not a `src/` change: the price table and the block are policy, not
mapping. They are worth being able to turn off (`OPENCODE_VIBE_PRICING=0`), and they are worth
being able to keep across an upstream merge without touching upstream's files. Both halves are
loaded through the same public host API a third-party plugin uses — `model.transform` and
`ui.slot` — so nothing here depends on a fork-only hook.

Coverage as of 2026-11-27: eleven of the twelve `vibe/*` models OpenCode exposes are priced.
`glm-5-2` stays at `$0.00` because the price page lists it only as a navigation link, with no
price block; add `input_price` / `output_price` to its `[[models]]` block in
`~/.vibe/config.toml` to price it. Cost is written onto a message when the message is stored,
so rows recorded before a model had a price keep `cost: 0`.

## Maintaining it

- `bun test` covers the mapping: gauge equals the live `used`, cumulative totals reduced to
  one call's delta, a repeated update changing nothing, per-session isolation, a resumed
  session not inflating, and no ledger meaning no tokens.
- `bun test test/pricing-parse.test.ts` covers the price list without the network: the page's
  escaped Next.js payload, aliases priced alongside ids, a missing "Cached input" column left
  unset rather than zero, a stated `0` treated as a price, non-token units and half-priced
  models skipped, nested `relatedModels` blocks not becoming rates of their own, and the
  per-field merge order. Run it whenever the price page is suspected of changing; the parser
  fails closed (an empty parse never overwrites the cache), so a redesign costs a stale table,
  not a wrong price.
- `sidebar/install.sh --check` after editing either plugin half. OpenCode reads the installed
  copy, not this checkout, so an uninstalled edit looks like a bug in the code.
- `bun run scripts/smoke.ts` is the live check: two real prompts on `mistral-large-4-0`,
  with the per-turn usage printed. A turn whose mapped total equals the previous turn's
  cumulative total means the deltas are not being reduced.
- When upstream releases a new version, merge the release, then rebuild `dist/`. The
  mapping is in `src/usage.ts` and `src/convert.ts`, well away from upstream's changed
  files. Do not revert to cumulative counters.
- For machines that load the published bundle out of the npm cache (no checkout, no
  toolchain), `patch/apply-patch.cjs` applies the same fix to a bundle at rest; `patch/`
  documents those six needles. Re-check it against a new build, since its needles are the
  minified call sites of the version it was written for.
- The underlying bug is worth reporting upstream; if it is fixed there, this fork can be
  retired. The ACP cross-check in `patch/README.md` (live `used = 39,453` versus
  `_meta.promptTokens = 48,996` on one turn) is the evidence a maintainer needs.

## License

MIT, per upstream `LICENSE.md`. The modification is documented here and in
`patch/README.md`; the vendored bundle is a modified build of upstream's output.
