// Speaks ACP to vibe-acp directly and dumps every usage_update, to establish what
// Vibe actually puts on the wire across turns.
import { spawn } from "node:child_process";

const bin = process.env.VIBE_ACP || "vibe-acp";
const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 1;
const pending = new Map();
const events = [];

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "session/update") {
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === "usage_update") {
        events.push({
          t: Date.now(),
          used: u.used,
          size: u.size,
          meta: u._meta,
        });
      }
      continue;
    }
    if (msg.method && msg.id !== undefined) {
      // permission request: allow once
      const opt = (msg.params?.options ?? []).find((o) => o.kind === "allow_once");
      write({ jsonrpc: "2.0", id: msg.id, result: { outcome: opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" } } });
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));

function write(obj) {
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

const only = process.argv[2]; // optional model id

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "usage-probe", version: "0" },
  });
  const session = await request("session/new", { cwd: "/tmp", mcpServers: [] });
  const sid = session.sessionId;
  const modelOption = (session.configOptions ?? []).find((o) => o.id === "model");
  console.log("session:", sid);
  console.log(
    "models:",
    (modelOption?.options ?? []).map((o) => o.value).join(", "),
    "| current:",
    modelOption?.currentValue,
  );
  const chosen = only ?? modelOption?.currentValue;
  if (chosen && chosen !== modelOption?.currentValue) {
    await request("session/set_config_option", { sessionId: sid, configId: "model", value: chosen });
    console.log("model set to", chosen);
  }

  for (const text of ["Reply with exactly: ok", "Reply with exactly: ok again"]) {
    console.log(`\n--- prompt start: ${text}`);
    events.length = 0;
    const res = await request("session/prompt", {
      sessionId: sid,
      prompt: [{ type: "text", text }],
    });
    console.log("response.usage:", JSON.stringify(res.usage));
    for (const e of events) {
      console.log(
        `  usage_update used=${e.used} size=${e.size} prompt=${e.meta?.promptTokens} completion=${e.meta?.completionTokens} cached=${e.meta?.cachedTokens} lastTurnTotal=${e.meta?.lastTurnTotalTokens} steps=${e.meta?.steps}`,
      );
    }
  }
} catch (err) {
  console.error("probe failed:", err.message);
} finally {
  proc.kill();
}
