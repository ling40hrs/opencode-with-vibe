# opencode-with-vibe — fork with per-call token accounting

This is a fork of [ilyhalight/opencode-with-vibe](https://github.com/ilyhalight/opencode-with-vibe)
(0.1.0, MIT). The only functional change is the usage mapping: OpenCode no longer counts
`vibe-acp`'s cumulative session totals as the usage of a single turn. That bug inflated the
context gauge past 200% and triggered auto-compaction with a small real context. Read
[`patch/README.md`](patch/README.md) for the diagnosis, the fix design, and the evidence.

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
git -C ~/.local/share/opencode-with-vibe checkout v0.1.0-fix.2
ln -sf ~/.local/share/opencode-with-vibe/dist/plugin.js ~/.config/opencode/plugin/opencode-with-vibe.js
```

Then drop the `opencode-with-vibe` entry from `plugins` in `opencode.json`, so the npm
package cannot load alongside it — both provide `vibe/*` providers. Restart OpenCode and
check:

```bash
opencode plugin list   # expect: opencode-with-vibe  local  ~/.config/opencode/plugin/opencode-with-vibe.js
```

`git -C ... checkout v0.1.0-fix.2` is what pins the machine. Use the commit sha instead of
the tag if you want immunity to a force-push.

### Route 2: publish to npm (works, needs credentials)

npm specs install correctly in v2.4.2, so publishing this repo makes the spec one string:

```json
{ "package": "opencode-with-vibe-fix@0.1.0-fix.1", "options": { "permission": "allow" } }
```

Not done here: this machine has no npm credentials (`npm whoami` returns `ENEEDAUTH`) and
`opencode-with-vibe-fix` is unclaimed on the registry. Run `npm publish` from a checkout and
then use the spec above.

### What does not work in v2.4.2

- **Git specs.** `opencode plugin add 'github:ling40hrs/opencode-with-vibe#v0.1.0-fix.2'`
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

## Maintaining it

- `bun test` covers the mapping: gauge equals the live `used`, cumulative totals reduced to
  one call's delta, a repeated update changing nothing, per-session isolation, a resumed
  session not inflating, and no ledger meaning no tokens.
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
