// Per-token pricing for the Vibe provider, so OpenCode's own cost readout works.
//
// opencode-with-vibe declares every Vibe model with `cost: []` ("subscription
// usage is not billed per token, so every model is free as far as OpenCode is
// concerned"). OpenCode therefore computes $0.00 for a Vibe session and the
// native sidebar / prompt footer hides the price line entirely, while a native
// provider shows it. This plugin only fills the model cost table:
//
//     cost = (input.noCache * input + cache.read * cached + output * output) / 1e6
//
// which is the same formula Vibe uses for its own session cost
// (vibe/utils/pricing.py, session_token_cost). Cache writes are not part of
// Vibe's accounting and are never counted by the opencode-with-vibe usage
// mapping, so they are priced at the input rate and stay unused.
//
// Rates come from three sources, weakest first:
//
//   1. Vibe's built-in model defaults (vibe/core/config/vibe_schema.py), kept
//      below as an offline net so a cold cache still prices the two models Vibe
//      ships with a rate;
//   1. Mistral's published price list, https://docs.mistral.ai/inference/pricing
//      — the rates the API actually bills, covering every model the page lists;
//   3. ~/.vibe/config.toml `[[models]]` prices, which are what Vibe itself
//      charges by, so they win over the published list.
//
// A source may state only some of the three rates — the published page leaves
// "Cached input" out for several models — so the merge takes, per field, the
// strongest source that states it. Cached prompt tokens with no rate anywhere
// are billed at the input rate, which is Vibe's own rule.
//
// The published list is fetched cheaply: the parsed table is cached on disk for
// a day, it is only awaited when there is no cache at all, and a stale cache is
// used as-is while a refresh runs in the background and lands for the next
// start. The request carries the page's ETag, but Netlify answers 200 regardless
// (measured 2026-11-27), so a refresh transfers the page: 472 KB of HTML, ~79 KB
// on the wire once content encoding is negotiated, in ~200 ms — at most once a
// day, since a fetched table is fresh for TTL_MS.
//
// Registered globally via ~/.config/opencode/plugin/. Environment:
//
//   OPENCODE_VIBE_PRICING=0              disable this plugin
//   OPENCODE_VIBE_PRICING_TTL_HOURS=24   how long the cached list is fresh
//   OPENCODE_VIBE_PRICING_TIMEOUT_MS=5000  cap on the fetch
//   OPENCODE_VIBE_PRICING_URL=...        fetch from somewhere else
//
// Edit prices in ~/.vibe/config.toml (`input_price = ...` inside the model's
// `[[models]]` block) and restart OpenCode; nothing here needs changing.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"

const PROVIDER_ID = "vibe"
const VIBE_HOME = process.env.VIBE_HOME ?? join(homedir(), ".vibe")
const CONFIG = join(VIBE_HOME, "config.toml")

const PRICING_URL = process.env.OPENCODE_VIBE_PRICING_URL ?? "https://docs.mistral.ai/inference/pricing"
const CACHE = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "opencode",
  "vibe-pricing.json",
)
const TTL_MS = scaled(process.env.OPENCODE_VIBE_PRICING_TTL_HOURS, 24, 60 * 60 * 1000)
const TIMEOUT_MS = scaled(process.env.OPENCODE_VIBE_PRICING_TIMEOUT_MS, 5000, 1)

/** USD per million tokens. A field a source does not state is left undefined. */
interface Rate {
  input?: number
  output?: number
  cached?: number
}

/** A resolved rate: the two mandatory prices, cached folded in. */
interface Price {
  input: number
  output: number
  cached: number
}

interface Snapshot {
  fetchedAt: number
  etag?: string
  prices: Record<string, Rate>
}

function scaled(raw: string | undefined, fallback: number, scale: number): number {
  const value = Number(raw)
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value * scale : fallback
}

/** Guards every rate read: the cache file is JSON on disk and can go stale. */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Vibe's built-in model defaults (vibe 3.1.4). Only these ship with a price in
 * vibe/core/config/vibe_schema.py; every other model Vibe knows about is
 * unpriced there. Keyed by config `name` and its ACP-facing aliases.
 */
const BUILTIN: Record<string, Rate> = {
  "mistral-large-4-0": { input: 0.7, output: 2.1, cached: 0.07 },
  "mistral-vibe-cli-latest": { input: 1.5, output: 7.5, cached: 0.15 },
  "mistral-medium-3.5": { input: 1.5, output: 7.5, cached: 0.15 },
  // The model id vibe-acp reports for the same model.
  "mistral-medium-latest": { input: 1.5, output: 7.5, cached: 0.15 },
}

/**
 * The slice of a price-list entry this plugin reads. The page renders exactly
 * these fields into its "Input / Cached input / Output" columns.
 */
interface Entry {
  direction?: string
  label?: string
  priceUsd?: number
  unit?: string
}

/**
 * Reads the balanced array that starts at `start`, respecting JSON strings so a
 * bracket inside a tooltip or description cannot end it early.
 */
function readArray(text: string, start: number): string | undefined {
  if (text[start] !== "[") return undefined
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "[") depth++
    else if (char === "]") {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Parses the JSON array that follows `key` inside `block`. */
function arrayAfter(block: string, key: string): unknown {
  const at = block.indexOf(key)
  if (at < 0) return undefined
  const raw = readArray(block, block.indexOf("[", at))
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Pulls `modelId -> rate` out of the price page.
 *
 * The rendered HTML is a Next.js payload: every listable model appears as an
 * object carrying `modelIds`, `aliases` and a `pricing` array of
 * `{ direction, label, priceUsd, unit }`. Ids are what matter — the page's own
 * links use marketing slugs (`ministral-3-14b-25-12`), while the API and Vibe
 * use `ministral-14b-2512`, so matching on slugs would miss half the catalogue.
 *
 * Objects nested under `relatedModels` repeat the same shape, so each block is
 * cut there: a block's first `pricing` belongs to the model the block starts
 * with. Non-token units (per minute, per thousand pages) are skipped, and so is
 * any model that does not state both an input and an output price.
 */
export function parsePricing(html: string): Record<string, Rate> {
  const text = html.replace(/\\"/g, '"')
  const anchors: number[] = []
  for (let at = text.indexOf('"modelIds":'); at >= 0; at = text.indexOf('"modelIds":', at + 1)) {
    anchors.push(at)
  }

  const rates: Record<string, Rate> = {}
  for (let index = 0; index < anchors.length; index++) {
    const end = index + 1 < anchors.length ? anchors[index + 1]! : text.length
    let block = text.slice(anchors[index], end)
    const related = block.indexOf('"relatedModels"')
    if (related >= 0) block = block.slice(0, related)

    const entries = arrayAfter(block, '"pricing":')
    if (!Array.isArray(entries)) continue

    const rate: Rate = {}
    for (const entry of entries as Entry[]) {
      if (entry?.unit !== "/M Tokens") continue
      const price = finite(entry.priceUsd)
      if (price === undefined) continue
      const column = entry.label ?? entry.direction
      if (column === "Input") rate.input = price
      else if (column === "Cached input") rate.cached = price
      else if (column === "Output") rate.output = price
    }
    if (rate.input === undefined || rate.output === undefined) continue

    const ids = arrayAfter(block, '"modelIds":')
    const aliases = arrayAfter(block, '"aliases":')
    for (const id of [...(Array.isArray(ids) ? ids : []), ...(Array.isArray(aliases) ? aliases : [])]) {
      if (typeof id === "string" && !(id in rates)) rates[id] = rate
    }
  }
  return rates
}

/**
 * Folds layers weakest-first into one price. Per field, the last layer that
 * states it wins; cached prompt tokens fall back to the input rate.
 */
export function mergeRates(layers: readonly (Rate | undefined)[]): Price | undefined {
  let input: number | undefined
  let output: number | undefined
  let cached: number | undefined
  for (const layer of layers) {
    if (!layer) continue
    input = finite(layer.input) ?? input
    output = finite(layer.output) ?? output
    cached = finite(layer.cached) ?? cached
  }
  if (input === undefined || output === undefined) return undefined
  return { input, output, cached: cached ?? input }
}

/** Every id any source prices, resolved. */
function priceTable(published: Record<string, Rate>, configured: Map<string, Rate>): Map<string, Price> {
  const ids = new Set<string>([...Object.keys(BUILTIN), ...Object.keys(published), ...configured.keys()])
  const table = new Map<string, Price>()
  for (const id of ids) {
    const price = mergeRates([BUILTIN[id], published[id], configured.get(id)])
    if (price) table.set(id, price)
  }
  return table
}

interface ConfigEntry {
  name?: string
  alias?: string
  input?: number
  output?: number
  cached?: number
}

function toNumber(raw: string): number | undefined {
  const value = raw.replace(/#.*$/, "").trim()
  if (value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Minimal `[[models]]` reader: enough for the handful of keys pricing needs. */
function readModelEntries(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = []
  let current: ConfigEntry | undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith("[")) {
      current = trimmed.replace(/\s/g, "") === "[[models]]" ? {} : undefined
      if (current) entries.push(current)
      continue
    }
    if (!current) continue
    const match = /^([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const [, key, rest] = match
    const raw = (rest ?? "").trim()
    if (key === "name" || key === "alias") {
      const quoted = /^"([^"]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw)
      if (quoted) current[key] = quoted[1]
      continue
    }
    if (key === "input_price") current.input = toNumber(raw)
    else if (key === "output_price") current.output = toNumber(raw)
    else if (key === "cached_input_price") current.cached = toNumber(raw)
  }
  return entries
}

/**
 * Prices the user set in `~/.vibe/config.toml` — the same rates Vibe bills by.
 * Entries with no price keys are skipped, and so is an explicit 0/0 pair: an
 * unpriced model must stay unpriced rather than become free on purpose.
 */
function loadConfigRates(): Map<string, Rate> {
  const rates = new Map<string, Rate>()
  let text = ""
  try {
    text = readFileSync(CONFIG, "utf8")
  } catch {
    return rates
  }
  for (const entry of readModelEntries(text)) {
    const rate: Rate = {}
    if (entry.input !== undefined) rate.input = entry.input
    if (entry.output !== undefined) rate.output = entry.output
    if (entry.cached !== undefined) rate.cached = entry.cached
    if (rate.input === undefined && rate.output === undefined && rate.cached === undefined) continue
    if (!rate.input && !rate.output) continue
    for (const id of [entry.name, entry.alias]) {
      if (id) rates.set(id, rate)
    }
  }
  return rates
}

function readCache(): Snapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(CACHE, "utf8")) as Snapshot
    if (typeof snapshot?.fetchedAt !== "number" || typeof snapshot.prices !== "object") return undefined
    return snapshot
  } catch {
    return undefined
  }
}

function writeCache(snapshot: Snapshot): void {
  try {
    mkdirSync(dirname(CACHE), { recursive: true })
    const temporary = `${CACHE}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(snapshot))
    renameSync(temporary, CACHE)
  } catch {
    // A cache that cannot be written only costs one fetch on the next start.
  }
}

/** One conditional GET. `undefined` means the fetch failed; the old table stands. */
async function download(etag?: string): Promise<"not-modified" | Snapshot | undefined> {
  try {
    const response = await fetch(PRICING_URL, {
      headers: etag ? { "if-none-match": etag } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status === 304) return "not-modified"
    if (!response.ok) return undefined
    const prices = parsePricing(await response.text())
    // A layout change on the page must not overwrite a good table with nothing.
    if (Object.keys(prices).length === 0) return undefined
    return {
      fetchedAt: Date.now(),
      etag: response.headers.get("etag") ?? undefined,
      prices,
    }
  } catch {
    return undefined
  }
}

/**
 * Background refresh of a stale cache; its result is only written to disk, so it
 * lands on the next start. Re-registering the model transform mid-session is not
 * worth the ordering questions it raises for a table that is a day old at worst.
 */
async function refresh(cache: Snapshot): Promise<void> {
  const next = await download(cache.etag)
  if (next === undefined) return
  if (next === "not-modified") writeCache({ ...cache, fetchedAt: Date.now() })
  else writeCache(next)
}

export default Plugin.define({
  id: "vibe-pricing",
  async setup(context) {
    if (process.env.OPENCODE_VIBE_PRICING === "0") return

    const cache = readCache()
    let published: Record<string, Rate> = cache?.prices ?? {}
    if (!cache) {
      // First run on this machine: pay for the fetch once, bounded by the timeout.
      const first = await download()
      if (first !== undefined && first !== "not-modified") {
        published = first.prices
        writeCache(first)
      }
    } else if (Date.now() - cache.fetchedAt > TTL_MS) {
      void refresh(cache)
    }

    const prices = priceTable(published, loadConfigRates())
    const registration = await context.model.transform((editor) => {
      for (const model of editor.list(PROVIDER_ID)) {
        const price = prices.get(model.id)
        if (!price) continue
        editor.update(PROVIDER_ID, model.id, (draft) => {
          // `cost` is branded USD-per-million in @opencode/schema (effect
          // `Schema.brand`), so plain numbers need one assertion. Vibe's rates
          // are already USD per million tokens, which is what the brand says.
          draft.cost = [
            {
              input: price.input,
              output: price.output,
              cache: { read: price.cached, write: price.input },
            },
          ] as unknown as typeof draft.cost
        })
      }
    })

    return () => registration.dispose()
  },
})
