// Exercises the patched mapUsage/ledger code extracted verbatim from the shipped bundle.
const fs = require("fs");
const path = require("path");

const here = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const feSrc = here("fe.src");
const ledgerSrc = here("ledger.src");

const factory = new Function(`${ledgerSrc}\n${feSrc}\nreturn { Fe, Wt, Ot };`);
const { Fe, Wt, Ot } = factory();

const WINDOW = 400000;
const gauge = (u) =>
  (u.inputTokens.noCache ?? 0) + (u.inputTokens.cacheRead ?? 0) + (u.outputTokens.total ?? 0);

const upd = (used, p, c, r) => ({
  sessionUpdate: "usage_update",
  used,
  size: WINDOW,
  _meta: { promptTokens: p, completionTokens: c, cachedTokens: r },
});

let failures = 0;
const check = (name, got, want) => {
  const ok = Math.abs(got - want) <= 1e-6;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}: got ${got}, want ${want}`);
};

// The affected session: cumulative session totals climbing per model call.
const st = Wt("ses_de4eb8c65ffeHD1a4882CvRFeq");
Ot(st, upd(102000, 100000, 2000, 95000));
Ot(st, upd(105000, 203000, 4000, 192000));
Ot(st, upd(108000, 309000, 6000, 293000));

const finish = { stopReason: "end_turn", usage: { inputTokens: 309000, outputTokens: 6000, cachedReadTokens: 293000 } };
const usage = Fe(finish.usage, st);
console.log("mapped:", JSON.stringify(usage));

check("context gauge equals Vibe's live context", gauge(usage), 108000);
check("input excludes cache (non-cached prompt)", usage.inputTokens.noCache, usage.inputTokens.total - usage.inputTokens.cacheRead);
check("cache read is the call's cached prompt", usage.inputTokens.cacheRead, 101000);
check("input total = prompt of the last call", usage.inputTokens.total, 106000);
check("context percent of window", Math.round((gauge(usage) / WINDOW) * 100), 27);

// Old behaviour, for contrast.
const oldGauge = 309000 + 6000 + 293000;
console.log(`old mapping would have reported ${Math.round((oldGauge / WINDOW) * 100)}% of the window`);

// Resumed session in a fresh process: first update carries session totals.
const fresh = Wt("resumed");
Ot(fresh, upd(108000, 309000, 6000, 293000));
check("resumed session does not inflate", gauge(Fe(finish.usage, fresh)), 108000);

// Repeated usage_update without a new call must not zero the last call.
const dup = Wt("dup");
Ot(dup, upd(102000, 100000, 2000, 95000));
Ot(dup, upd(105000, 203000, 4000, 192000));
Ot(dup, upd(105000, 203000, 4000, 192000));
check("duplicate update keeps last call", gauge(Fe(finish.usage, dup)), 105000);

// No ledger data at all: report nothing rather than a cumulative total.
const empty = Wt("empty");
check("no ledger reports no tokens", gauge(Fe(finish.usage, empty)), 0);

// Output can never exceed the measured context.
const odd = Wt("odd");
Ot(odd, upd(50000, 100000, 60000, 90000));
check("output clamped to live context", gauge(Fe(finish.usage, odd)), 50000);

// Two different sessions do not share state.
Ot(Wt("a"), upd(10000, 8000, 1000, 7000));
Ot(Wt("b"), upd(30000, 28000, 3000, 26000));
check("sessions are isolated", gauge(Fe(finish.usage, Wt("a"))), 10000);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
