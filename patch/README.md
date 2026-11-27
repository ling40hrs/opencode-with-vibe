# opencode-with-vibe: token-accounting patch

Local patch to the `opencode-with-vibe` OpenCode plugin that fixes inflated context
accounting and the spurious auto-compaction it caused. Written for whoever inherits this
setup: read this before touching the plugin.

This fork also ships the patched bundle prebuilt at `dist/plugin.js`, so machines that
install the fork from git need none of the steps in "The patch lives in a volatile cache".
That section applies when you use the upstream npm package instead.

## Symptom

OpenCode's context gauge showed 200%+ usage and auto-compacted mid-turn, right after the
plugin reported usage.

Real example from before the fix (`session ses_de4eb8c65ffeHD1a4882CvRFeq`, seq 144):

| field                 | value    |
| --------------------- | -------- |
| `tokens.input`        | 42,431   |
| `tokens.cache.read`   | 822,784  |
| `tokens.output`       | 12,817   |
| gauge total           | 878,032  |
| learned context       | 400,000  |
| usage                 | 219.5%   |

Auto-compaction fired 13 ms after seq 305, with a tiny real context.

## Root cause

Not routing, not the model provider. `vibe-acp` answers `session/prompt` with
**cumulative session counters** in `_meta` (`promptTokens`, `completionTokens`,
`cachedTokens`, plus `lastTurnTotal` and `steps`). The plugin mapped those as the usage of
the single call that had just finished, so every turn re-counted the whole session. Summed
into OpenCode's per-message `tokens`, the prompt and cached-prompt totals compound across
turns and blow past the context window.

Cross-check that proves the shape of the data: a direct ACP probe of one turn returned
`usage_update.used = 39,453` while `_meta.promptTokens = 48,996`. `used` is live context,
`promptTokens` is session-cumulative.

## Fix design

The patch keeps the cumulative `_meta` counters out of the usage math and anchors on
Vibe's live per-call context instead.

- A per-session ledger (`tn: Map`, keyed by OpenCode session id) stores `used`, the
  previous cumulative counters `prev`, and the last derived per-call delta `last`.
- `usage_update` writes into the ledger (`Ot`). The reducer subtracts `prev` from the
  cumulative counters to get the delta for the turn; it tolerates repeated and zeroed
  updates, which `usage_update` emits several times per turn.
- `mapUsage` (`Fe`) reads the ledger (`Wt`) and yields usage whose gauge components sum to
  `used`: `output = min(completion, used)`, `total = max(0, used - output)`,
  `cacheRead = min(cached, total)`, `noCache = total - cacheRead`.
- No ledger entry means the plugin reports **no** tokens rather than a cumulative sum.
  That is deliberate: unknown beats wrong.
- OpenCode stores `tokens.input` as the non-cached part, so
  `gauge = input.noCache + cache.read + output`.

Invariant after the patch: `noCache + cacheRead + output === used`.

Out of scope, do not re-add: `x-affinity` header stamping. The plugin talks ACP over
stdio JSON-RPC and never makes HTTP calls to Mistral; `vibe-acp` 3.1.4 already derives
affinity from the session family id.

## Files here

| file              | role                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `apply-patch.cjs` | idempotent patcher; applies the six bundle edits to a target file |
| `plugin.js.orig`  | pristine bundle from the npm package, pre-patch                  |
| `plugin.js.patched` | expected post-patch bundle, 30,849 → 31,902 bytes               |
| `fe.src`          | extracted patched `mapUsage` (`Fe`)                              |
| `ledger.src`      | extracted patched `Wt`/`Ot` helpers                              |
| `test-usage.cjs`  | unit checks for the patched math; reads `fe.src`/`ledger.src` from its own directory |
| `acp-probe.mjs`   | direct ACP probe showing per-call vs cumulative usage            |

## Where the patched bundle lives

Upstream publishes only `dist/` and gitignores it, so this fork commits the patched
bundle at `dist/plugin.js` (force-added past `.gitignore`). That is what OpenCode loads
when it installs the fork from git — no build step, no cache patching.

That committed bundle is reproducible from the patch: applying `apply-patch.cjs` to
`patch/plugin.js.orig` yields `dist/plugin.js` byte for byte. Check it after any edit:

```bash
cd "$(git rev-parse --show-toplevel)"
cp patch/plugin.js.orig /tmp/repatch.js
node patch/apply-patch.cjs /tmp/repatch.js && cmp /tmp/repatch.js dist/plugin.js
rm -f /tmp/repatch.js
```

## Patching an npm install instead

If a machine uses the upstream npm package rather than this fork, the patch lives in a
volatile cache and must be re-applied. The plugin is not vendored. OpenCode resolves it
from
`~/.cache/opencode/npm/opencode-with-vibe@latest/<build>/node_modules/opencode-with-vibe/dist/plugin.js`
(`<build>` is a numeric build dir; `1795516518641` at time of writing). Config side, it is
the `opencode-with-vibe` entry under `plugins` in `~/.config/opencode/opencode.json`.

**Reinstalling or updating the plugin wipes the patch.** After any such change, re-run:

```bash
P=$(ls -d ~/.cache/opencode/npm/opencode-with-vibe@latest/*/node_modules/opencode-with-vibe/dist/plugin.js | head -1)
node "$(git rev-parse --show-toplevel)/patch/apply-patch.cjs" "$P"
```

Then restart OpenCode, since the patched module is only read at load time.

`apply-patch.cjs` fails loudly instead of half-applying: each edit asserts exactly one
occurrence, and it refuses to run if the identifiers `Wt`, `Ot`, or `tn` already exist in
the bundle. If it throws on a new plugin version, the minified call sites changed — diff
`plugin.js` against `plugin.js.orig`, re-derive the six needles, and keep the semantics
above. Do not "fix" it by reverting to the cumulative counters.

## Verifying

Unit checks:

```bash
node patch/test-usage.cjs
```

They cover: gauge equals `used`, `noCache` excludes the cached prompt, cache read equals
the call's cached prompt, session isolation, no-ledger returns no tokens, a resumed
session does not inflate, duplicate updates keep the last call.

End to end, two real turns on one session:

```bash
opencode run -m vibe/<model> --auto --format json "<prompt>"
```

Then read `$.tokens.*` from the `session_message` rows in
`~/.local/share/opencode/opencode.db`. Per-turn `tokens` must stay flat-ish rather than
accumulate. The passing run recorded 9,547 and 19,105 tokens against a 71,072 window
(13% and 27%).

## Notes / gotchas

- `usage_update` fires more than once per turn, including a zeroed update at turn start.
  The ledger must survive repeats and out-of-order zeros.
- The ledger is process-local and in-memory. It is not persisted; a resumed session starts
  clean and therefore reports no tokens until its first `usage_update`.
- OpenCode's learned context window (`onContext(size)`) is fed unchanged by the patch. Only
  the per-message usage mapping changed.
- Time of writing: OpenCode v2.4.2, `opencode-with-vibe` 0.1.0, `vibe-acp` 3.1.4, Node
  v24.18.0, Linux.
