/** Key-order independent JSON, so hashes do not depend on how an object was serialised on the way back. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    const fields: string[] = []
    for (const key of Object.keys(object).sort()) {
      if (object[key] !== undefined) fields.push(`${JSON.stringify(key)}:${canonical(object[key])}`)
    }
    return `{${fields.join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
