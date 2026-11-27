import { describe, expect, test } from "bun:test"
import { mergeRates, parsePricing } from "../sidebar/vibe-pricing"

/**
 * One price-list block, shaped like the JSON embedded in the docs page: the
 * model's ids first, then a `pricing` array of `{ direction, label, priceUsd,
 * unit }` entries. `direction` is "input" for both the Input and Cached input
 * columns, so the label is what separates them.
 */
function block(options: {
  modelIds: string[]
  aliases?: string[]
  entries: Array<[label: string, priceUsd: number | null, unit?: string]>
  relatedModels?: string
}): string {
  const pricing = options.entries.map(([label, priceUsd, unit = "/M Tokens"]) =>
    JSON.stringify({
      id: "price",
      direction: label === "Output" ? "output" : "input",
      priceUsd,
      unit,
      label,
    }),
  )
  const related = options.relatedModels ? `"relatedModels":[${options.relatedModels}],` : ""
  return `{"modelIds":${JSON.stringify(options.modelIds)},"aliases":${JSON.stringify(
    options.aliases ?? [],
  )},"pricing":[${pricing.join(",")}],${related}"cta":{"label":null}}`
}

const deepseek = block({
  modelIds: ["deepseek-v4-1-flash-1017"],
  entries: [
    ["Input", 0.3],
    ["Cached input", 0.007],
    ["Output", 1.2],
  ],
})

describe("parsePricing", () => {
  test("reads all three columns into a rate", () => {
    expect(parsePricing(deepseek)).toEqual({
      "deepseek-v4-1-flash-1017": { input: 0.3, cached: 0.007, output: 1.2 },
    })
  })

  test("aliases are priced too, so an id or an alias both resolve", () => {
    const page = block({
      modelIds: ["zai-glm-5-3"],
      aliases: ["zai-glm-5", "zai-glm-latest"],
      entries: [
        ["Input", 1.4],
        ["Output", 4.4],
      ],
    })
    expect(Object.keys(parsePricing(page)).sort()).toEqual(["zai-glm-5", "zai-glm-5-3", "zai-glm-latest"])
  })

  test("a source that omits the cached column leaves it unset rather than zero", () => {
    const page = block({
      modelIds: ["mistral-medium-latest"],
      entries: [
        ["Input", 1.5],
        ["Output", 7.5],
      ],
    })
    expect(parsePricing(page)["mistral-medium-latest"]).toEqual({ input: 1.5, output: 7.5 })
  })

  test("non-token units are skipped, so a model priced only per minute stays unpriced", () => {
    const page = block({
      modelIds: ["per-minute-model"],
      entries: [
        ["Input", 0.006, "/Minute"],
        ["Output", 0.012, "/Minute"],
      ],
    })
    expect(parsePricing(page)).toEqual({})
  })

  test("a token model is skipped unless it states both input and output", () => {
    const page = block({
      modelIds: ["half-priced"],
      entries: [
        ["Input", 0.3],
        ["Cached input", 0.03],
      ],
    })
    expect(parsePricing(page)).toEqual({})
  })

  test("a stated price of zero is a price, not a missing field", () => {
    const page = block({
      modelIds: ["free-cache"],
      entries: [
        ["Input", 0.2],
        ["Cached input", 0],
        ["Output", 0.6],
      ],
    })
    expect(parsePricing(page)["free-cache"]).toEqual({ input: 0.2, cached: 0, output: 0.6 })
  })

  test("the Next.js payload arrives with escaped quotes and still parses", () => {
    expect(parsePricing(deepseek.replace(/"/g, '\\"'))).toEqual(parsePricing(deepseek))
  })

  test("a related model's nested block does not become a rate of its own", () => {
    const page = block({
      modelIds: ["zai-glm-5-3"],
      entries: [
        ["Input", 1.4],
        ["Cached input", 0.14],
        ["Output", 4.4],
      ],
      relatedModels: JSON.stringify({ slug: "zai-glm-5-3-flash", pricing: [{ label: "Input", priceUsd: 9, unit: "/M Tokens" }] }),
    })
    const rates = parsePricing(page)
    expect(Object.keys(rates)).toEqual(["zai-glm-5-3"])
    expect(rates["zai-glm-5-3"]).toEqual({ input: 1.4, cached: 0.14, output: 4.4 })
  })

  test("prose and navigation links alone yield nothing", () => {
    expect(parsePricing('<a href="/models/zai-glm-5-2">GLM 5.2</a>')).toEqual({})
  })
})

describe("mergeRates", () => {
  test("the strongest layer wins per field, not per record", () => {
    expect(mergeRates([{ input: 1.5, output: 7.5, cached: 0.15 }, { input: 1.5, output: 7.5 }])).toEqual({
      input: 1.5,
      output: 7.5,
      cached: 0.15,
    })
  })

  test("cached prompt tokens with no rate anywhere are billed at the input rate", () => {
    expect(mergeRates([{ input: 0.2, output: 0.6 }])).toEqual({ input: 0.2, output: 0.6, cached: 0.2 })
  })

  test("layers complete each other, since the merge is per field", () => {
    expect(mergeRates([{ input: 0.2 }, { output: 0.6 }])).toEqual({ input: 0.2, output: 0.6, cached: 0.2 })
  })

  test("nothing priceable means no price at all", () => {
    expect(mergeRates([{ input: 0.2 }])).toBeUndefined()
    expect(mergeRates([{ output: 0.6 }])).toBeUndefined()
    expect(mergeRates([undefined, undefined])).toBeUndefined()
  })

  test("a later layer can only raise a stated field, never blank one", () => {
    expect(mergeRates([{ input: 0.3, output: 1.2, cached: 0.007 }, {}])).toEqual({
      input: 0.3,
      output: 1.2,
      cached: 0.007,
    })
  })
})
