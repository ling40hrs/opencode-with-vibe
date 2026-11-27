# opencode-with-vibe — fork with per-call token accounting

This is a fork of [ilyhalight/opencode-with-vibe](https://github.com/ilyhalight/opencode-with-vibe)
(0.1.0, MIT). The only functional change is the usage mapping: OpenCode no longer counts
`vibe-acp`'s cumulative session totals as the usage of a single turn. That bug inflated the
context gauge past 200% and triggered auto-compaction with a small real context. Read
[`patch/README.md`](patch/README.md) for the diagnosis, the fix design, and the evidence.

Upstream source is untouched. The fix is applied to the built bundle, which this fork
commits at `dist/plugin.js`.

## Using it on another machine

Pin a ref; a bare repo spec is left on whatever it installed and gets update-checked.

```json
{
  "plugins": [
    {
      "package": "github:ling40hrs/opencode-with-vibe#v0.1.0-fix.1",
      "options": { "permission": "allow" }
    }
  ]
}
```

Or from the CLI:

```bash
opencode plugin add 'github:ling40hrs/opencode-with-vibe#v0.1.0-fix.1'
```

Replace the tag with a commit sha if you want the ref to be immutable against a force-push.
Restart OpenCode afterwards: the plugin module is read once at load time.

## Why `dist/` is committed here

Upstream's `.gitignore` excludes `dist/`, `package.json` sets `main` to `dist/plugin.js`,
and there is no `prepare` script — only `build`, which needs the dev dependencies. A git
install of upstream as-is therefore resolves `main` to a file that does not exist. Committing
the built bundle is what makes the fork installable from git, and it means no machine needs a
toolchain.

`dist/plugin.js` is reproducible from the patch:

```bash
cp patch/plugin.js.orig /tmp/repatch.js
node patch/apply-patch.cjs /tmp/repatch.js && cmp /tmp/repatch.js dist/plugin.js
rm -f /tmp/repatch.js
```

The bundle has no runtime dependencies — it imports only Node builtins — so `dist/plugin.js`
plus `dist/plugin.d.ts` are the whole artifact.

## Maintaining it

- `node patch/test-usage.cjs` runs the unit checks for the patched math.
- When upstream releases a new version, rebuild `dist/`, then run `patch/apply-patch.cjs`
  against the fresh bundle. If it throws, the minified call sites moved: re-derive the six
  needles as described in `patch/README.md`. Do not revert to cumulative counters.
- The underlying bug is worth reporting upstream; if it is fixed there, this fork can be
  retired. The ACP cross-check in `patch/README.md` (live `used = 39,453` versus
  `_meta.promptTokens = 48,996` on one turn) is the evidence a maintainer needs.

## License

MIT, per upstream `LICENSE.md`. The modification is documented here and in
`patch/README.md`; the vendored bundle is a modified build of upstream's output.
