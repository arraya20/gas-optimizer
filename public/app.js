// Dashboard client.
//
// Two rules, both learned the hard way:
//   1. No verdict logic here. Every number and every judgement comes from
//      /api/analyze. A second implementation of the same rules is a second set
//      of rules, and they drift.
//   2. A slow response must never overwrite a newer one. Each submit takes a
//      sequence number and only the newest may paint.

const $ = (id) => document.getElementById(id);

let seq = 0;

const form = $("form");
const submitBtn = $("submit");
const errorBox = $("error");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  run();
});

async function run() {
  const mine = ++seq;
  setBusy(true);
  hideError();

  const body = {};
  const gasLimit = $("gasLimit").value.trim();
  if (gasLimit) body.gasLimit = gasLimit;
  for (const [field, input] of [
    ["gasUsed", $("gasUsed")],
    ["maxFeeGwei", $("maxFeeGwei")],
    ["tipGwei", $("tipGwei")],
  ]) {
    const v = input.value.trim();
    if (v) body[field] = v;
  }

  try {
    const res = await fetch("/api/analyze?sample=40", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);

    if (mine !== seq) return; // a newer request owns the screen
    if (!res.ok) {
      showError(payload?.error ? `${payload.kind ?? "error"}: ${payload.error}` : `HTTP ${res.status}`);
      setBusy(false);
      return;
    }
    render(payload);
  } catch (err) {
    if (mine !== seq) return;
    showError(`request failed: ${err.message}`);
  } finally {
    if (mine === seq) setBusy(false);
  }
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.textContent = busy ? "measuring…" : "measure";
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function render(report) {
  $("result").hidden = false;

  const verdict = $("verdict");
  verdict.textContent = report.advice.verdict.replaceAll("_", " ").toLowerCase();
  verdict.className = `verdict v-${report.advice.verdict}`;
  $("verdictNote").textContent =
    report.advice.verdict === "ALREADY_MINIMAL"
      ? "already at the measured minimum"
      : report.advice.verdict === "UNMEASURABLE"
        ? "no advice given"
        : "a lower setting pays the same transaction";

  $("reasons").replaceChildren(...report.advice.reasons.map((r) => li(r)));

  const m = report.market;
  fill($("market"), [
    ["base fee", m.baseFeeGwei ? `${m.baseFeeGwei} gwei` : "unreadable"],
    ["history", `${m.distinctCount} value(s) over ${num(m.blocksObserved)} blocks, ${m.windows.length} windows`],
    ["frozen", m.frozen ? "yes — never moved in the measured windows" : "no"],
    ["block usage", `${pct(m.capacity.meanUtilisation)} mean, ${pct(m.capacity.maxUtilisation)} peak`],
    ["headroom", m.capacity.headroomX ? `${num(m.capacity.headroomX)}x` : "n/a"],
  ]);

  const a = report.advice;
  const rows = [];
  if (a.recommended) {
    rows.push(["set maxFee", `${a.recommended.maxFeeGwei} gwei, tip 0`]);
    rows.push(["costs", `${a.recommended.paidPROS} PROS`]);
    rows.push(["locks", `${a.recommended.lockedPROS} PROS`]);
  }
  if (a.declared) {
    rows.push(["declared costs", `${a.declared.paidPROS} PROS`]);
    rows.push(["declared locks", `${a.declared.lockedPROS} PROS`]);
    rows.push(["spent saving", `${a.spentSavingPROS} PROS`]);
    rows.push(["lock saving", `${a.lockSavingPROS} PROS`]);
  }
  fill($("cost"), rows);

  const s = report.sample;
  fill($("sample"), [
    ["window", `${num(s.window.blocksRequested)} blocks to ${num(s.window.to)}`],
    ["with transactions", `${num(s.blocksWithTransactions)} blocks`],
    ["successful tx", num(s.transactions)],
    ["paid base only", s.zeroTipShare == null ? "n/a" : `${s.zeroTipShare}%`],
    ["median tip when paid", s.medianPositiveTipGwei ? `${s.medianPositiveTipGwei} gwei` : "none"],
    ["fees paid above base", s.tipShareOfFees == null ? "n/a" : `${s.tipShareOfFees}%`],
    ["gas limit vs usage", s.medianGasLimitOverGasUsed ? `${s.medianGasLimitOverGasUsed}x` : "n/a"],
  ]);

  $("waiting").textContent =
    report.waiting.canHelp === false
      ? "no — the price is flat and blocks are nearly empty, so holding the transaction buys nothing"
      : report.waiting.canHelp === true
        ? "yes — the measured history contains a cheaper window"
        : "unproven — not enough evidence to say";
  $("waitingReasons").replaceChildren(...report.waiting.reasons.map((r) => li(r)));

  $("notMeasured").replaceChildren(...report.notMeasured.map((item) => li(item)));
}

function fill(dl, rows) {
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v ?? "—";
      return [dt, dd];
    }),
  );
}

function li(text) {
  const el = document.createElement("li");
  el.textContent = text;
  return el;
}

const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const pct = (v) => (v == null ? "n/a" : `${(Number(v) * 100).toFixed(3)}%`);

// Paint the not-measured panel before any request, so it is never absent.
$("notMeasured").replaceChildren(
  li("nothing has been measured yet — submit a transaction above"),
);
