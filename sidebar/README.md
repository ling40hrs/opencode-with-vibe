# Vibe spend in the sidebar

Two OpenCode plugins that make a `vibe` session report what it actually consumed, in the
same place and the same shape as a native provider:

```
Vibe $0.0104 · 1 turn
↑6,396 · ↓43 · cache 3,072 (32%)
ctx 13% of 71k
```

They are additive. They do not touch `src/`, they do not patch the built bundle, and they
run only for sessions on the `vibe` provider — a native provider's sidebar is untouched.

## Why it is needed

`opencode-with-vibe` declares every Vibe model with `cost: []` — "subscription usage is not
billed per token, so every model is free as far as OpenCode is concerned". OpenCode therefore
computes `$0.00` for a Vibe session and hides the spend line entirely, while a native provider
shows one. Two things follow:

- `vibe-pricing.ts` (a server plugin) fills the model cost table, so OpenCode's own cost
  readout has a price to work with;
- `vibe-sidebar/` (a TUI plugin) adds the block OpenCode's builtin `sidebar.content` does not
  show: the token split, the real spend, and an honest context gauge.

## Install

The plugins are read from `~/.config/opencode` at load time, so the repo copies are the
source of truth and `install.sh` is the only step:

```bash
git clone https://github.com/ling40hrs/opencode-with-vibe.git ~/.local/share/opencode-with-vibe
~/.local/share/opencode-with-vibe/sidebar/install.sh          # or: sidebar/install.sh --check
```

Then restart OpenCode and confirm both halves loaded:

```bash
opencode plugin list | grep -E 'vibe-pricing|vibe-sidebar'
```

`install.sh` copies three files, idempotently, and takes `OPENCODE_CONFIG` if your config
directory is not `~/.config/opencode`. `--check` compares source against installed copy and
exits non-zero on drift, which is the cheap way to catch an edit that never reached OpenCode.

`vibe-sidebar` resolves to the *directory*, not to `tui.tsx`: OpenCode scans
`~/.config/opencode/plugins/<name>/`, loads `<name>/index.js` as the server half and
`<name>/tui` as the TUI half.

## The pricing half

`vibe-pricing.ts` registers a `context.model.transform` that sets `cost` on each `vibe`
model:

    cost = (input.noCache * input + cache.read * cached + output * output) / 1e6

That is Vibe's own formula, `session_token_cost` in `vibe/utils/pricing.py`, which is why the
numbers agree with what Vibe bills. Cache *writes* are not part of Vibe's accounting and the
usage mapping never emits them, so they are priced at the input rate and stay unused.

### Where the rates come from

Three sources, merged **per field**, weakest first:

| # | source | why it is there |
| - | ------ | --------------- |
| 1 | Vibe's built-in defaults (`vibe/core/config/vibe_schema.py`), hard-coded in the file | offline net: a cold, disconnected start still prices the models Vibe ships with a rate |
| 2 | <https://docs.mistral.ai/inference/pricing> | the published list — the rates the API bills, covering every model the page prices |
| 3 | `~/.vibe/config.toml` `[[models]]` prices (`input_price`, `output_price`, `cached_input_price`, USD per million) | what Vibe itself charges by, so they outrank the published list |

Per-field matters: the page leaves "Cached input" out for several models, so a page rate can
still take its `cached` from Vibe's builtin. Cached prompt tokens with no rate anywhere are
billed at the input rate, which is Vibe's own rule (`cached_input_price` unset means the
input rate in `session_token_cost`).

To price a model by hand, add the price keys to its `[[models]]` block and restart OpenCode;
nothing in this plugin needs changing.

### The fetch is cheap

- Parsed table cached at `$XDG_CACHE_HOME/opencode/vibe-pricing.json`, fresh for
  `OPENCODE_VIBE_PRICING_TTL_HOURS` (default 24).
- The page is **awaited only when there is no cache at all**. A stale cache prices the
  session immediately and a refresh runs in the background, landing on the next start.
- One refresh measured 2026-11-27: `200`, 472 KB of HTML, ~79 KB on the wire (content
  encoding negotiated), ~200 ms, 5 s cap. The request sends the page's ETag, but Netlify
  answers `200` regardless, so budget a full transfer rather than a `304`.
- A parse that yields nothing never overwrites a good table, and a failed fetch never clears
  one. A page redesign costs `$0.00` and no wrong prices.
- The transform is not re-registered after a background refresh: a table one day old at worst
  is not worth the ordering questions that re-registering mid-session raises.

### What it covers

Eleven of the twelve `vibe/*` models OpenCode exposes are priced. `glm-5-2` is the
exception: the price page lists it only as a navigation link to `/models/zai-glm-5-2`, with
no price block, and `~/.vibe/config.toml` names no rate for it. It stays at `$0.00` until you
add `input_price` / `output_price` to its `[[models]]` block.

Cross-checks that the formula and the merge order are right, not just plausible:

- the static anchors match Vibe's source — `mistral-large-4-0` = `0.7 / 2.1 / 0.07` and
  `mistral-medium-3.5` = `1.5 / 7.5 / 0.15` in `vibe_schema.py`;
- a stored message row reproduces the documented figure — `mistral-medium-latest` at 6,396
  input / 3,072 cached / 43 output is `0.0103773`, i.e. `6396*1.5 + 3072*0.15 + 43*7.5`
  micro-dollars.

## The sidebar half

`vibe-sidebar/tui.tsx` claims `append: "sidebar.content"` and renders only when the session's
`model.providerID` is `vibe`. Messages after a revert marker are not counted, matching how
the builtin blocks respect reverts.

It sums the assistant messages rather than reading the session totals, and that is the point
of the exercise. Measured, one session, one turn:

| source | input | output | cache read | cost |
| ------ | ----- | ------ | ---------- | ---- |
| assistant message | 6,396 | 43 | 3,072 | $0.0104 |
| session record (`session_v2`) | 13,286 | 741 | 6,144 | $0.0264 |

The per-message row matches the provider's own per-call usage. The session record is
inflated: the ACP runtime adds a turn's usage to the session totals on top of the
per-message usage the provider already reported. That inflation is upstream of these plugins
and is not fixed here — it is why the builtin line in the same sidebar can read `$0.03 spent`
while the turn cost `$0.0104`. The block is labelled `Vibe`; the builtin line is not.

Three smaller decisions fall out of the same numbers:

- **Sub-cent formatting.** `Intl` currency defaults give `$0.00` for a whole Vibe session, so
  the block uses two significant digits below a dollar: `$0.0104`, `$0.264`, `$1.28`.
- **The context gauge is rebuilt, not reused.** It divides the *last* turn's prompt — cached
  plus uncached input, since both occupy the window — by the window
  `opencode-with-vibe` learned from Vibe's own `usage_update.size`. Summing turns would
  multiply the prompt, and reading the session record would report a share several times too
  large for the reason above. The line is omitted, never guessed, until that model has run
  once.
- **Token counts are abbreviated** above 10k (`71k`, `1M`) so the fact line survives a
  narrow sidebar.

`vibe-sidebar/index.js` is the plugin's server half and is intentionally empty: the host
requires one to exist, and the sidebar is a TUI plugin.

`tui.tsx` is TSX on purpose. OpenCode transpiles plugin entries with Bun's `tsx` loader, and
the result must run under Solid's JSX runtime, which the host provides. Do not "fix" it by
compiling to plain JS unless the host's loader changes.

## Options

| variable | default | meaning |
| -------- | ------- | ------- |
| `OPENCODE_VIBE_PRICING` | unset | `0` disables the pricing half |
| `OPENCODE_VIBE_PRICING_TTL_HOURS` | `24` | how long a fetched table stays fresh |
| `OPENCODE_VIBE_PRICING_TIMEOUT_MS` | `5000` | cap on the fetch |
| `OPENCODE_VIBE_PRICING_URL` | the Mistral page | fetch the price list somewhere else |
| `VIBE_HOME` | `~/.vibe` | where to look for `config.toml` |
| `XDG_CACHE_HOME` | `~/.cache` | where the parsed table is cached |

## Verifying a change

```bash
bun test test/pricing-parse.test.ts   # parsing, merging, and the edge cases in between
bun run typecheck                     # sidebar/vibe-pricing.ts is in the project
sidebar/install.sh --check            # installed copies match this directory
```

The parse and merge are unit-tested without the network. The rendering is not: the block
only exists inside the TUI, so run OpenCode on a `vibe` model in a scratch directory, send
one prompt, and read the sidebar. A turn reporting `↑6,396 · ↓43 · cache 3,072` on
`mistral-medium-latest` must show `$0.0104`.

To cross-check the figures without the UI:

```bash
DB=~/.local/share/opencode/opencode.db
sqlite3 "$DB" "select json_extract(data,'\$.model.id'), json_extract(data,'\$.cost'),
  json_extract(data,'\$.tokens.input'), json_extract(data,'\$.tokens.output')
  from session_message where json_extract(data,'\$.model.providerID')='vibe'
  order by rowid desc limit 10"
```

Two things to remember when reading old rows:

- **Cost is written at message time.** A message stored before a model had a price stays at
  `cost: 0`, so only turns after the table is populated are priced. When comparing rows
  against a new table, check the timestamp first.
- **Zero means no price, not free.** A row showing `cost: 0` next to real token counts is a
  model the table could not price (see `glm-5-2`), not a free turn.

## Files

| file | role |
| ---- | ---- |
| `vibe-pricing.ts` | server half: the `vibe/*` model cost table, the price fetch and its cache |
| `vibe-sidebar/index.js` | server half of the TUI plugin, intentionally empty |
| `vibe-sidebar/tui.tsx` | the sidebar block (`sidebar.content`) |
| `install.sh` | copies both halves into the OpenCode config directory |
