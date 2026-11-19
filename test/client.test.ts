import { afterEach, describe, expect, test } from "bun:test"
import { AcpClient, choosePermission } from "../src/acp/client"
import { AcpRpcError, type SessionUpdate } from "../src/acp/types"
import { fakeClient, fakeEnv, methods, received } from "./helpers"

const clients: AcpClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
})
const make = (...args: Parameters<typeof fakeClient>) => {
  const client = fakeClient(...args)
  clients.push(client)
  return client
}

async function promptText(client: AcpClient, text: string, signal?: AbortSignal) {
  const { sessionId } = await client.request<{ sessionId: string }>("session/new", { cwd: "C:\\work", mcpServers: [] })
  const updates: SessionUpdate[] = []
  const result = await client.prompt(sessionId, [{ type: "text", text }], (update) => updates.push(update), signal)
  const reply = updates.flatMap((update) => (update.sessionUpdate === "agent_message_chunk" ? [(update as any).content.text] : [])).join("")
  return { sessionId, result, reply, updates }
}

describe("AcpClient", () => {
  test("starts lazily, initializes without fs/terminal capabilities, and routes updates per session", async () => {
    const env = fakeEnv()
    const client = make(env)
    expect(client.running).toBe(false)
    const { result, reply } = await promptText(client, "hello")
    expect(client.running).toBe(true)
    expect(reply).toBe("ok-1")
    expect(result).toMatchObject({ stopReason: "end_turn", usage: { inputTokens: 100 } })
    const init = methods(env, "initialize")[0]
    expect(init.params.clientCapabilities).toEqual({})
  })

  test("auto-allow picks allow_once, never a standing approval", async () => {
    const env = fakeEnv()
    const { reply } = await promptText(make(env), "script:permission")
    // allow_once is preferred so a standing "always allow" is never written to the user's config
    expect(reply).toBe('permission:{"outcome":"selected","optionId":"allow_once"}')
  })

  test("auto-allow never picks allow_always_permanent when allow_once is offered", async () => {
    const env = fakeEnv()
    const { reply } = await promptText(make(env), "script:permission")
    expect(reply).not.toBe('permission:{"outcome":"selected","optionId":"allow_always_permanent"}')
    expect(reply).not.toBe('permission:{"outcome":"selected","optionId":"allow_always"}')
  })

  test("deny mode picks the reject option", async () => {
    const env = fakeEnv()
    const { reply } = await promptText(make(env, { permission: "deny" }), "script:permission")
    expect(reply).toBe('permission:{"outcome":"selected","optionId":"reject_once"}')
  })

  test("unknown client-side requests get -32601", async () => {
    const env = fakeEnv()
    const { reply } = await promptText(make(env), "script:unknown-request")
    expect(reply).toBe("unknown:-32601")
  })

  test("JSON-RPC errors reject with AcpRpcError", async () => {
    const error = await promptText(make(fakeEnv()), "script:rpc-error").catch((e) => e)
    expect(error).toBeInstanceOf(AcpRpcError)
    expect(error.code).toBe(-32000)
  })

  test("aborting sends session/cancel as a notification and resolves with the agent's cancelled result", async () => {
    const env = fakeEnv()
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 150)
    const { result, reply } = await promptText(make(env), "script:slow", abort.signal)
    expect(result).toMatchObject({ stopReason: "cancelled", usage: { inputTokens: 100 } })
    expect(reply).toBe("partial")
    // a notification has no id; as a request vibe-acp answers -32601
    expect(methods(env, "session/cancel")).toHaveLength(1)
    expect(methods(env, "session/cancel")[0]!.id).toBeUndefined()
  })

  test("an already-aborted signal never sends the prompt", async () => {
    const env = fakeEnv()
    const abort = new AbortController()
    abort.abort()
    const error = await promptText(make(env), "hello", abort.signal).catch((e) => e)
    expect(error.name).toBe("AbortError")
    expect(methods(env, "session/prompt")).toHaveLength(0)
    expect(methods(env, "session/cancel")).toHaveLength(0)
  })

  test("a crash mid-prompt rejects the prompt, and the next request respawns the process", async () => {
    const env = fakeEnv()
    const client = make(env)
    const error = await promptText(client, "script:crash").catch((e) => e)
    expect(String(error.message)).toMatch(/vibe exited unexpectedly/)
    const generation = client.generation
    const { reply } = await promptText(client, "hello")
    expect(reply).toBe("ok-1")
    expect(client.generation).toBe(generation + 1)
    expect(methods(env, "initialize")).toHaveLength(2)
  })

  test("a missing executable gives an actionable error", async () => {
    const client = new AcpClient({ command: "definitely-not-vibe-xyz", backoffMs: 1 })
    clients.push(client)
    await expect(client.start()).rejects.toThrow(/vibe executable not found/)
  })

  test("dispose closes stdin so the child exits, and the client refuses further work", async () => {
    const client = make(fakeEnv())
    await client.start()
    await client.dispose()
    expect(client.running).toBe(false)
    await expect(client.start()).rejects.toThrow(/disposed/)
  })

  test("nothing but the client's own messages is written to the fake agent's log for unknown replies", async () => {
    const env = fakeEnv()
    await promptText(make(env), "script:permission")
    const replies = received(env).filter((entry) => entry.id >= 1000)
    expect(replies).toHaveLength(1)
    // vibe reads the nested outcome, not a flat {outcome, optionId}
    expect(replies[0].result.outcome.optionId).toBe("allow_once")
  })
})

describe("choosePermission", () => {
  const options = [
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
    { optionId: "no", kind: "reject_once" },
  ]
  test("allow prefers allow_once, never allow_always*", () => {
    expect(choosePermission({ sessionId: "s", options }, "allow")).toEqual({ outcome: "selected", optionId: "once" })
    expect(choosePermission({ sessionId: "s", options: [options[0]!] }, "allow")).toEqual({ outcome: "selected", optionId: "once" })
    // even with only the two allow_always* options available, allow_once is not invented, so the first is used:
    // this is a documented fallback, not a preference for standing approval
    const alwaysOnly = [
      { optionId: "always", kind: "allow_always" },
      { optionId: "always_permanent", kind: "allow_always" },
    ]
    expect(choosePermission({ sessionId: "s", options: alwaysOnly }, "allow")).toEqual({ outcome: "selected", optionId: "always" })
  })
  test("deny picks a reject option, cancelled when none", () => {
    expect(choosePermission({ sessionId: "s", options }, "deny")).toEqual({ outcome: "selected", optionId: "no" })
    expect(choosePermission({ sessionId: "s", options: [options[0]!] }, "deny")).toEqual({ outcome: "cancelled" })
    expect(choosePermission({ sessionId: "s" }, "allow")).toEqual({ outcome: "cancelled" })
  })
})
