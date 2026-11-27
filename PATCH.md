# opencode-with-vibe — fork with per-call accounting, spend readouts, and plan mode

This is a fork of [ilyhalight/opencode-with-vibe](https://github.com/ilyhalight/opencode-with-vibe)
(0.1.0, MIT). It makes three additions and changes nothing upstream wrote:

1. **A usage-mapping fix.** OpenCode no longer counts `vibe-acp`'s cumulative session totals
   as the usage of a single turn. That bug inflated the context gauge past 200% and triggered
   auto-compaction with a small real context. Read [`patch/README.md`](patch/README.md) for the
   diagnosis, the fix design, and the evidence.
2. **Two plugins that report what a session consumed** — a `vibe/*` price table and a sidebar
   block with cost, token split and an honest context gauge. See
   [`sidebar/README.md`](sidebar/README.md).
3. **Plan mode, enforced.** Selecting an OpenCode agent that restricts tools (`plan`) now
   restricts the Vibe conversation the same way: its rules answer Vibe's permission requests,
   its instructions ride into the prompt, and switching away ends the mode. See
   [Plan mode](#plan-mode) below.

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
this fork once per machine at a stable path, then run the installer:

```bash
git clone https://github.com/ling40hrs/opencode-with-vibe.git ~/.local/share/opencode-with-vibe
git -C ~/.local/share/opencode-with-vibe checkout v0.1.0-fix.4
~/.local/share/opencode-with-vibe/scripts/install-local.sh --check   # what is installed now
~/.local/share/opencode-with-vibe/scripts/install-local.sh           # switch, verify, roll back on failure
```

It symlinks `dist/plugin.js` into `plugin/`, removes the `opencode-with-vibe` entry from
`plugins` in `opencode.json` (both provide `vibe/*`, and two providers with one id is not a
state to leave behind), then boots a private `opencode --standalone` against the edited config
and counts the `vibe/*` models it reports. A bundle that fails there is rolled back rather than
left for the next restart. Restart OpenCode and check:

```bash
opencode plugin list   # expect: opencode-with-vibe  local  ~/.config/opencode/plugin/opencode-with-vibe.js
```

**The trap this route exists for.** A config entry `{ "package": "opencode-with-vibe" }` loads
the published bundle out of `~/.cache/opencode/npm/opencode-with-vibe@latest/<stamp>/dist/plugin.js`.
Editing a checkout changes nothing while that entry is present — the running provider is the
cached copy, at whatever version was resolved last. `--check` reports which shape a machine is
in (`link: absent` plus `config: still lists the npm package` is the symptom), and
`patch/apply-patch.cjs` is the alternative for a machine that cannot switch at all: it edits
that cached bundle in place.

`git -C ... checkout v0.1.0-fix.4` is what pins the machine. Use the commit sha instead of
the tag if you want immunity to a force-push.

### Route 2: publish to npm (works, needs credentials)

npm specs install correctly in v2.4.2, so publishing this repo makes the spec one string:

```json
{ "package": "opencode-with-vibe-fix@0.1.0-fix.4", "options": { "permission": "allow" } }
```

Not done here: this machine has no npm credentials (`npm whoami` returns `ENEEDAUTH`) and
`opencode-with-vibe-fix` is unclaimed on the registry. Run `npm publish` from a checkout and
then use the spec above.

### What does not work in v2.4.2

- **Git specs.** `opencode plugin add 'github:ling40hrs/opencode-with-vibe#v0.1.0-fix.4'`
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

## Plan mode

OpenCode's Plan agent is not a mechanism of its own. It is three ordinary things, and only one
of them is visible to a provider:

| piece | where it lives | crosses ACP on its own? |
| --- | --- | --- |
| `instructions.selected` / `.unselected` | the agent record | no — ACP has no client-set system prompt |
| `permissions`: ordered `{action, resource, effect}` | the agent record | no — the agent asks; a client answers |
| the switch out of it | the user | no — it is a keystroke in the host |

So a Vibe session used to ignore plan mode completely: `build` and `plan` looked identical,
because Vibe runs its own tools inside its own process and OpenCode's `edit: deny` governed a
tool OpenCode never executes. [`src/plan.ts`](src/plan.ts) reconstructs the three pieces from
the agent record, and [`src/sessions.ts`](src/sessions.ts) applies them per turn:

- **Rules answer permission requests.** A restricting agent switches the conversation to Vibe's
  `ask` approval policy — under `auto-approve` Vibe never emits `session/request_permission`, so
  there would be nothing to decide. `ask` makes the state-changing tools ask (`edit`,
  `write_file`, `bash`, `web_fetch`), and each request is judged against the agent's rule list,
  last rule winning, with the project-relative form of a path tested alongside the absolute one.
- **Instructions ride in the prompt.** `instructions.selected` is prepended as a text block
  marked `[OpenCode agent: plan]`. Instructions for a turn are the only lever available: Vibe's
  system prompt is Vibe's.
- **The switch ends the mode.** `instructions.unselected` belongs to the agent that was *left*,
  not the one entered, so it is sent once on the first turn that runs under a different agent.
  That state is persisted per session (`agent:<sessionID>` in plugin storage), because a resumed
  conversation still carries the old instructions in its transcript; without the note Vibe would
  keep refusing the edits the user has just asked for, and only a new session would clear it.

`build` — `* * allow`, no instructions — is untouched: no mode switch, no injected block, no
approval round trips. Cost is one `session.get` + `agent.get` per turn.

### What it does not do, stated plainly

- **`read_file` and `grep` are never gated.** Vibe marks them `ToolPermission.ALWAYS`, so no
  request is emitted and a rule like `read *.env → ask` cannot be enforced here.
- **A rule that `ask`s is refused.** OpenCode would have prompted the user; the ACP client has
  no way to prompt, so the closed answer wins. The refusal is logged in the plugin's debug sink.
- **A request for a call Vibe never described is refused**, not approved.
- **The rules are mirrored, not corrected.** The Plan agent on the machine this was written on
  ends its list with `edit * deny` *after* allowing `/home/<user>/.opencode/plan/*`, so plan mode
  there cannot write its own plan file. That is the agent's configuration, and the plugin
  reproduces it rather than second-guessing it.
- **A failed policy lookup fails open.** If `session.get` or `agent.get` throws, the turn runs
  with Vibe's own policy — a guessed restriction would break a session the user never restricted.
- **OpenCode still runs its own plan-mode loop** for anything OpenCode executes itself. This
  makes the *Vibe* conversation behave like the agent; it does not replace the host's workflow.

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
- `bun test test/plan.test.ts` covers plan mode without needing OpenCode: rule matching
  (wildcards spanning separators, exact non-glob resources, command rules, literal regex
  characters), last-rule-wins, unknown effect as ask, cwd-relative paths, the tool-call to
  action mapping, and the instruction text including the once-only `unselected` note. Its
  second half drives the fake agent: mode becomes `ask`, the block is prepended, an edit is
  refused, an allowed call is approved once (never `allow_always`, which would write standing
  approval into the user's Vibe config), an `ask` rule is refused, an undescribed request is
  refused, the note is not repeated, it survives a restart, and a broken policy lookup does
  not restrict anything.
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
- To check plan mode live: select `plan` in OpenCode, ask for an edit, and expect a refusal
  rather than a diff; switch to `build` and the same request must go through, with one
  "no longer in Plan mode" line arriving in the transcript.
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
