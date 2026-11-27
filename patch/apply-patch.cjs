const fs = require("fs");

const file = process.argv[2];
let s = fs.readFileSync(file, "utf8");
const before = s;

function sub(needle, replacement, label) {
  const count = s.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected 1 occurrence, found ${count}`);
  }
  s = s.replace(needle, () => replacement);
}

// Collision guard for the new identifiers.
for (const id of ["Wt", "Ot", "tn"]) {
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${id}($|[^A-Za-z0-9_$])`);
  if (re.test(s)) throw new Error(`identifier ${id} already used in bundle`);
}

// 1. mapUsage: read the per-session ledger instead of the cumulative ACP totals.
sub(
  'function Fe(n){let e=n?.inputTokens,t=n?.cachedReadTokens,o=n?.outputTokens;return{inputTokens:{total:e,noCache:e===void 0?void 0:Math.max(0,e-(t??0)),cacheRead:e===void 0&&t===void 0?void 0:t??0,cacheWrite:void 0},outputTokens:{total:o,text:o,reasoning:void 0}}}',
  'function Fe(n,e){let t=e?.last;if(t===void 0)return{inputTokens:{total:void 0,noCache:void 0,cacheRead:void 0,cacheWrite:void 0},outputTokens:{total:void 0,text:void 0,reasoning:void 0}};let o=Math.max(0,t.completion??0),i=e?.used,s;if(i!==void 0){o=Math.min(o,i),s=Math.max(0,i-o)}else s=Math.max(0,t.prompt??0);let r=Math.min(Math.max(0,t.cached??0),s),a=Math.max(0,s-r);return{inputTokens:{total:s,noCache:a,cacheRead:r,cacheWrite:void 0},outputTokens:{total:o,text:o,reasoning:void 0}}}',
  "mapUsage",
);

// 2. finishPart: pass the session ledger through.
sub(
  'function U(n,e){return{type:"finish",usage:Fe(n.usage),finishReason:',
  'function U(n,e,t){return{type:"finish",usage:Fe(n.usage,t),finishReason:',
  "finishPart signature",
);

// 3. Finish part of a completed prompt carries the ledger of that stream.
sub(
  'U(g.result,{conversationId:g.acpSessionId,mode:g.mode})',
  'U(g.result,{conversationId:g.acpSessionId,mode:g.mode},r.options.state)',
  "finishPart call",
);

// 4. The converter gets the ledger of the OpenCode session it serves.
sub(
  'r=new V({onContext:d=>this.dependencies.learn?.(this.modelId,d)})',
  'r=new V({state:Wt(i[K]),onContext:d=>this.dependencies.learn?.(this.modelId,d)})',
  "converter ledger",
);

// 5. usage_update feeds the ledger, not only the context-window learner.
sub(
  'case"usage_update":{let t=e.size;return typeof t=="number"&&Number.isFinite(t)&&t>0&&this.options.onContext?.(t),[]}',
  'case"usage_update":{let t=e.size;return this.options.state!==void 0&&Ot(this.options.state,e),typeof t=="number"&&Number.isFinite(t)&&t>0&&this.options.onContext?.(t),[]}',
  "usage_update recording",
);

// 6. Ledger storage and the cumulative-to-per-call reducer.
s +=
  "var tn=new Map;" +
  "function Wt(n){if(n===void 0)return{used:void 0,prev:void 0,last:void 0};let e=tn.get(n);return e===void 0&&(e={used:void 0,prev:void 0,last:void 0},tn.set(n,e)),e}" +
  "function Ot(n,e){" +
  "if(!e)return;" +
  "let t=e.used;typeof t==\"number\"&&Number.isFinite(t)&&t>=0&&(n.used=t);" +
  "let o=e._meta;if(!o||typeof o!=\"object\")return;" +
  "let i=o.promptTokens,s=o.completionTokens,r=o.cachedTokens;" +
  "if(typeof i!=\"number\"||!Number.isFinite(i)||typeof s!=\"number\"||!Number.isFinite(s)||typeof r!=\"number\"||!Number.isFinite(r))return;" +
  "let a=n.prev??{prompt:0,completion:0,cached:0},c=i-a.prompt,l=s-a.completion,d=r-a.cached;" +
  "(c>0||l>0)&&(n.last={prompt:Math.max(0,c),completion:Math.max(0,l),cached:Math.max(0,d)})," +
  "n.prev={prompt:i,completion:s,cached:r}}";

if (s === before) throw new Error("nothing changed");
fs.writeFileSync(file, s);
console.log("patched", file, "bytes", before.length, "->", s.length);
