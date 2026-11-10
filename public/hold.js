// Hold panel client.
//
// Same rule as app.js: no decisions here. Status, reasons, prices and the
// paid-versus-request-time figures all come from the API; this file only draws
// them. The job id is the only credential for a job, so it lives in the URL
// hash (never sent to a server in a request line) and is not listed anywhere.

const $ = (id) => document.getElementById(id);
const TERMINAL = new Set(["SETTLED", "REVERTED", "UNCONFIRMED", "SIMULATED", "FAILED", "CANCELLED"]);

let pollTimer = null;
let seq = 0;
let currentId = null;
const jobCache = new Map();

function saveCachedJob(job, rawTx) {
  if (!job?.id) return;
  const prev = loadCachedJob(job.id);
  const keepRaw = job.status === "HOLDING" ? (rawTx ?? prev?.rawTx ?? null) : null;
  const entry = keepRaw ? { ...job, rawTx: keepRaw } : { ...job };
  jobCache.set(job.id, entry);
  try {
    sessionStorage.setItem(`job:${job.id}`, JSON.stringify(entry));
  } catch {
    // sessionStorage may be unavailable in private contexts
  }
}

function loadCachedJob(id) {
  if (jobCache.has(id)) return jobCache.get(id);
  try {
    const raw = sessionStorage.getItem(`job:${id}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      jobCache.set(id, parsed);
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function stateHeaders(id) {
  const cached = loadCachedJob(id);
  if (!cached) return {};
  return { "x-job-state": encodeURIComponent(JSON.stringify(cached)) };
}

const NOTES = {
  HOLDING: "waiting for the base fee to reach the target, or for the deadline",
  SUBMITTED: "broadcast; waiting for the receipt",
  SETTLED: "included; gas paid is final",
  REVERTED: "included but the call reverted; gas was still spent",
  UNCONFIRMED: "no receipt yet; it may still be pending",
  SIMULATED: "dry run; nothing was broadcast",
  FAILED: "could not be broadcast",
  CANCELLED: "cancelled before broadcast",
};

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function fill(dl, rows) {
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => [el("dt", k), el("dd", v ?? "—")]),
  );
}

const when = (ms) => (ms == null ? "—" : new Date(ms).toLocaleString());
const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));

// ── history ─────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderHistory(await res.json());
  } catch (err) {
    $("historyNote").textContent = `history unavailable: ${err.message}`;
  }
}

function renderHistory(h) {
  const s = h.summary;
  $("historyNote").textContent = h.note;
  fill($("historyFacts"), [
    ["samples", `${num(s.count)}, one every ${Math.round(h.sampling.everyMs / 1000)}s`],
    ["first", when(s.firstAt)],
    ["latest", `${s.latestGwei ?? "—"} gwei at ${when(s.lastAt)}`],
    ["min / max", s.minGwei == null ? "—" : `${s.minGwei} / ${s.maxGwei} gwei`],
    ["distinct values", num(s.distinct)],
    ["failed samples", num(h.sampling.failedSamples)],
  ]);

  const chart = $("chart");
  const pts = h.samples;
  if (pts.length < 2) {
    chart.replaceChildren(el("div", "needs at least two samples to draw a line", "empty"));
    return;
  }
  const values = pts.map((p) => Number(p.base));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const t0 = pts[0].t;
  const span = pts[pts.length - 1].t - t0 || 1;
  // A flat series has no range to scale by: draw it mid-height rather than divide by zero.
  const y = (v) => (hi === lo ? 50 : 90 - ((v - lo) / (hi - lo)) * 80);
  const points = pts.map((p) => `${(((p.t - t0) / span) * 100).toFixed(2)},${y(Number(p.base)).toFixed(2)}`).join(" ");

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", points);
  svg.append(line);
  chart.replaceChildren(svg);
}

// ── job ─────────────────────────────────────────────────────────────────────

function showError(message) {
  $("holdError").textContent = message;
  $("holdError").hidden = false;
}

$("holdForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("holdError").hidden = true;

  const body = { rawTx: $("rawTx").value.trim(), deadlineMinutes: $("deadlineMinutes").value.trim() };
  const target = $("targetGwei").value.trim();
  if (target) body.targetBaseFeeGwei = target;
  if ($("dryRun").checked) body.dryRun = true;

  $("holdSubmit").disabled = true;
  $("holdSubmit").textContent = "holding…";
  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      showError(payload?.error ? `${payload.kind ?? "error"}: ${payload.error}` : `HTTP ${res.status}`);
      return;
    }
    const submittedRawTx = body.rawTx;
    $("rawTx").value = ""; // the signed transaction has no further use in the form
    saveCachedJob(payload, /^0x[0-9a-fA-F]{64}$/.test(submittedRawTx) ? null : submittedRawTx);
    follow(payload.id);
  } catch (err) {
    showError(`request failed: ${err.message}`);
  } finally {
    $("holdSubmit").disabled = false;
    $("holdSubmit").textContent = "hold";
  }
});

$("jobCancel").addEventListener("click", async () => {
  if (!currentId) return;
  const res = await fetch(`/api/jobs/${currentId}`, {
    method: "DELETE",
    headers: stateHeaders(currentId),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) showError(payload?.error ?? `HTTP ${res.status}`);
  else if (payload?.id) saveCachedJob(payload);
  poll();
});

function follow(id) {
  currentId = id;
  history.replaceState(null, "", `#job=${id}`);
  clearTimeout(pollTimer);
  poll();
}

async function poll() {
  const mine = ++seq;
  try {
    const res = await fetch(`/api/jobs/${currentId}`, {
      headers: stateHeaders(currentId),
    });
    const job = await res.json().catch(() => null);
    if (mine !== seq) return;
    if (!res.ok) {
      showError(job?.error ?? `HTTP ${res.status}`);
      return;
    }
    saveCachedJob(job);
    renderJob(job);
    if (!TERMINAL.has(job.status)) pollTimer = setTimeout(poll, 4000);
    else loadHistory();
  } catch (err) {
    if (mine !== seq) return;
    showError(`lost contact: ${err.message}`);
    pollTimer = setTimeout(poll, 8000);
  }
}

function renderJob(j) {
  $("job").hidden = false;
  const status = $("jobStatus");
  status.textContent = j.status.toLowerCase();
  status.className = `verdict s-${j.status}`;
  $("jobNote").textContent = NOTES[j.status] ?? "";
  $("jobWarnings").replaceChildren(...j.warnings.map((w) => el("li", w)));

  fill($("jobFacts"), [
    ["mode", j.mode === "dryRun" ? "dry run" : "live"],
    ["tx hash", j.submit?.txHash ?? j.tx.hash],
    ["deadline", `${when(j.deadlineAt)}`],
    ["price at request", `${j.quote.pricePerGasGwei} gwei (base fee ${j.quote.baseFeeGwei})`],
    ["target base fee", `${j.policy.targetBaseFeeGwei} gwei (${j.policy.targetSource})`],
    ["base fee now", `${j.lastBaseFeeGwei} gwei, ${num(j.checks)} check(s)`],
    ["maxFee / tip", `${j.maxFeeGwei} / ${j.tipGwei} gwei`],
    ["gas limit", num(j.tx.gasLimit)],
    ["submitted by", j.submit?.reason ? `${j.submit.reason}${j.submit.late ? " (late)" : ""}` : "—"],
  ]);

  const s = j.settlement;
  if (!s) {
    fill($("jobReport"), [["gas paid", j.status === "UNCONFIRMED" ? "unknown: no receipt" : "not yet"]]);
  } else if (s.simulated) {
    fill($("jobReport"), [
      ["kind", "simulated: nothing paid"],
      ["worst case now", `${s.worstCasePROS} PROS at ${s.pricePerGasGwei} gwei`],
      ["worst case at request", `${s.quotedWorstCasePROS} PROS at ${s.quotedPricePerGasGwei} gwei`],
    ]);
  } else {
    fill($("jobReport"), [
      ["gas paid", `${s.paidPROS} PROS (${num(s.gasUsed)} gas at ${s.effectiveGasPriceGwei} gwei)`],
      ["at request-time price", `${s.quotedCostPROS} PROS (same gas at ${s.quotedPricePerGasGwei} gwei)`],
      ["result", `${s.outcome.toLowerCase()} ${s.differencePROS} PROS${s.differencePct ? ` (${s.differencePct}%)` : ""}`],
      ["block", num(s.blockNumber)],
    ]);
  }

  $("jobEvents").replaceChildren(
    ...[...j.events].reverse().map((e) => {
      const li = el("li");
      li.append(el("b", e.type), document.createTextNode(`${new Date(e.at).toLocaleTimeString()} · ${e.message}`));
      return li;
    }),
  );

  $("jobCancel").hidden = j.status !== "HOLDING";
  $("jobLink").textContent = "keep this page's URL: the #job id is the only way back to this job";
}

// ── start ───────────────────────────────────────────────────────────────────

loadHistory();
setInterval(() => {
  if (!document.hidden) loadHistory();
}, 60_000);

const fromHash = location.hash.match(/^#job=([0-9a-f]{32})$/);
if (fromHash) follow(fromHash[1]);
