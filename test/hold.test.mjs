// Offline tests for the hold-until-favorable / never-miss-the-deadline engine.
// No network, no sockets: a scripted RPC and a virtual clock.

import { createHash } from "node:crypto";
import { test, run, eq, throws, setFile } from "./harness.mjs";
import { keccak256 } from "../src/keccak.mjs";
import { encodeRlp, decodeRlp, rlpInt, hexToBytes, bytesToHex } from "../src/rlp.mjs";
import { decodeRawTx, pricePerGas } from "../src/rawtx.mjs";
import { appendSample, summarizeHistory } from "../src/history.mjs";
import { validateJobRequest, createJob, decide, tick, cancel, DEFAULTS } from "../src/scheduler.mjs";
import { createOptimizer, jobView, MAX_ACTIVE_JOBS } from "../src/optimizer.mjs";
import { InputError } from "../src/numbers.mjs";
import { RpcError } from "../src/rpc.mjs";
import { Optimizer } from "../src/worker.mjs";

setFile("hold");

const GWEI = 1_000_000_000n;
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const utf8 = (s) => new TextEncoder().encode(s);
const NOW = 1_800_000_000_000;
const MIN = 60_000;

// ── fixtures ────────────────────────────────────────────────────────────────

const SIG = Uint8Array.of(1, 2, 3);
const TO = new Uint8Array(20).fill(0xab);

function rawType2({ chainId = 1672n, nonce = 7n, tip = 0n, maxFee = 12n * GWEI, gasLimit = 100_000n, signed = true } = {}) {
  const f = [rlpInt(chainId), rlpInt(nonce), rlpInt(tip), rlpInt(maxFee), rlpInt(gasLimit), TO, rlpInt(1n), new Uint8Array(0), [],
    signed ? Uint8Array.of(1) : new Uint8Array(0), signed ? SIG : new Uint8Array(0), signed ? SIG : new Uint8Array(0)];
  return bytesToHex(Uint8Array.from([0x02, ...encodeRlp(f)]));
}

function rawLegacy({ chainId = 1672n, gasPrice = 10n * GWEI, gasLimit = 21_000n } = {}) {
  const v = chainId * 2n + 35n;
  const f = [rlpInt(1n), rlpInt(gasPrice), rlpInt(gasLimit), TO, rlpInt(5n), new Uint8Array(0), rlpInt(v), SIG, SIG];
  return bytesToHex(encodeRlp(f));
}

/** Scripted node. `baseFee` is read on every call so a test can move the price. */
function fakeRpc(state) {
  const calls = [];
  return {
    calls,
    chainId: async () => state.chainId ?? 1672,
    async call(method, params = []) {
      calls.push(method);
      switch (method) {
        case "eth_chainId": return hex(state.chainId ?? 1672);
        case "eth_getBlockByNumber": {
          if (state.readFails) throw new RpcError("eth_getBlockByNumber: HTTP 503", { method, transient: true });
          return { number: hex(state.block ?? 100), baseFeePerGas: hex(state.baseFee) };
        }
        case "eth_sendRawTransaction": {
          const next = state.sendScript?.shift();
          if (next === "transient") throw new RpcError("eth_sendRawTransaction: transport failed", { method, transient: true });
          if (next === "transient-but-landed") {
            state.onChain = true;
            throw new RpcError("eth_sendRawTransaction: transport failed", { method, transient: true });
          }
          if (typeof next === "string" && next.startsWith("reject:")) throw new RpcError(`eth_sendRawTransaction: ${next.slice(7)}`, { method, code: -32000 });
          state.sent = (state.sent ?? 0) + 1;
          state.onChain = true;
          return state.returnHash ?? decodeRawTx(params[0]).hash;
        }
        case "eth_getTransactionByHash": {
          if (state.txByHash) return state.txByHash;
          return state.onChain ? { hash: params[0] } : null;
        }
        case "eth_getTransactionReceipt": return state.receipt ?? null;
        default: throw new RpcError(`method ${method} not found`, { method, code: -32601 });
      }
    },
  };
}

const newJob = (state, extra = {}, rawTx = rawType2(), now = NOW) =>
  createJob({ rpc: fakeRpc(state), body: { rawTx, deadlineMinutes: 10, ...extra }, now, id: "a".repeat(32) });

// ── keccak / rlp ────────────────────────────────────────────────────────────

test("keccak256 matches the published vectors for empty input and 'abc'", () => {
  eq(bytesToHex(keccak256(new Uint8Array(0))), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  eq(bytesToHex(keccak256(utf8("abc"))), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});

test("the keccak permutation agrees with node:crypto SHA3-256 across block boundaries", () => {
  // Same permutation and rate as Keccak-256; only the padding byte differs, so
  // this exercises the multi-block absorb path that fixed vectors cannot.
  for (const n of [0, 1, 135, 136, 137, 271, 272, 500, 1000]) {
    const input = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
    eq(
      bytesToHex(keccak256(input, { domain: 0x06 })),
      `0x${createHash("sha3-256").update(input).digest("hex")}`,
      `length ${n}`,
    );
  }
});

test("rlp round-trips nested lists and long strings", () => {
  const item = [Uint8Array.of(1), new Uint8Array(70).fill(9), [Uint8Array.of(0x80), []], new Uint8Array(0)];
  const back = decodeRlp(encodeRlp(item));
  eq(bytesToHex(encodeRlp(back)), bytesToHex(encodeRlp(item)));
});

test("rlp rejects non-canonical encodings and trailing bytes", () => {
  throws(() => decodeRlp(Uint8Array.of(0x81, 0x05)), "malformed RLP");
  throws(() => decodeRlp(Uint8Array.of(0xb8, 0x02, 1, 2)), "malformed RLP");
  throws(() => decodeRlp(Uint8Array.of(0x01, 0x02)), "trailing");
  throws(() => decodeRlp(Uint8Array.of(0xc2, 0x01)), "malformed RLP");
  throws(() => hexToBytes("0xabc"), "not valid hex");
});

// ── raw transaction ─────────────────────────────────────────────────────────

test("decodes an EIP-1559 transaction and prices it as min(maxFee, base + tip)", () => {
  const tx = decodeRawTx(rawType2({ tip: 2n * GWEI, maxFee: 11n * GWEI, gasLimit: 90_000n }));
  eq(tx.kind, "eip1559");
  eq(tx.chainId, 1672n);
  eq(tx.gasLimit, 90_000n);
  eq(tx.maxFeeWei, 11n * GWEI);
  eq(tx.tipWei, 2n * GWEI);
  eq(pricePerGas(tx, 10n * GWEI), 11n * GWEI, "cap binds");
  eq(pricePerGas(tx, 5n * GWEI), 7n * GWEI, "tip stacks on a low base");
  eq(tx.hash.length, 66);
});

test("a legacy transaction pays its flat gasPrice whatever the base fee does", () => {
  const tx = decodeRawTx(rawLegacy({ gasPrice: 13n * GWEI }));
  eq(tx.kind, "legacy");
  eq(tx.chainId, 1672n);
  eq(tx.flatPrice, true);
  eq(pricePerGas(tx, 1n * GWEI), 13n * GWEI);
  eq(pricePerGas(tx, 99n * GWEI), 13n * GWEI);
});

test("rejects unsigned, truncated and unsupported transactions", () => {
  throws(() => decodeRawTx(rawType2({ signed: false })), "unsigned");
  throws(() => decodeRawTx(rawType2().slice(0, -4)), "malformed RLP");
  throws(() => decodeRawTx("0x03c0"), "not supported");
  throws(() => decodeRawTx("0xzz"), "not valid hex");
  throws(() => decodeRawTx(rawType2({ tip: 5n * GWEI, maxFee: 1n * GWEI })), "above maxFeePerGas");
});

// ── history ─────────────────────────────────────────────────────────────────

test("history caps its length and keeps the newest samples", () => {
  let s = [];
  for (let i = 0; i < 10; i++) s = appendSample(s, { t: i, base: 10n * GWEI }, 4);
  eq(s.length, 4);
  eq(s[0].t, 6);
  eq(s[3].t, 9);
});

test("history reports a flat line as flat, one point as unknown, and movement as movement", () => {
  eq(summarizeHistory([]).moved, null);
  eq(summarizeHistory([{ t: 1, base: "10" }]).moved, null);
  eq(summarizeHistory([{ t: 1, base: "10" }, { t: 2, base: "10" }]).moved, false);
  const moving = summarizeHistory([{ t: 1, base: "10" }, { t: 2, base: "12" }]);
  eq(moving.moved, true);
  eq(moving.minWei, "10");
  eq(moving.maxWei, "12");
});

// ── request validation ──────────────────────────────────────────────────────

test("a deadline closer than the minimum lead is refused with the reason", () => {
  throws(() => validateJobRequest({ rawTx: "0x01", deadlineSeconds: 5 }, NOW), "minimum is 30s");
});

test("exactly one deadline form is required", () => {
  throws(() => validateJobRequest({ rawTx: "0x01" }, NOW), "exactly one");
  throws(() => validateJobRequest({ rawTx: "0x01", deadlineMinutes: 5, deadlineSeconds: 300 }, NOW), "exactly one");
  eq(validateJobRequest({ rawTx: "0x01", deadlineMinutes: 5 }, NOW).deadlineAt, NOW + 5 * MIN);
  eq(validateJobRequest({ rawTx: "0x01", deadlineAt: NOW + 5 * MIN }, NOW).deadlineAt, NOW + 5 * MIN);
});

test("market fields, conclusions and keys are rejected, naming the field", () => {
  for (const field of ["baseFee", "gasPrice", "quotedPrice", "verdict", "savings", "status"]) {
    const e = throws(() => validateJobRequest({ rawTx: "0x01", deadlineMinutes: 5, [field]: "1" }, NOW), field);
    eq(e.field, field);
  }
  throws(() => validateJobRequest({ rawTx: "0x01", deadlineMinutes: 5, privateKey: "0x1" }, NOW), "never send a key");
});

test("a transaction for another chain is refused, not relayed", async () => {
  let err;
  try {
    await newJob({ baseFee: 10n * GWEI }, {}, rawType2({ chainId: 1n }));
  } catch (e) {
    err = e;
  }
  eq(err instanceof InputError, true);
  eq(err.message.includes("signed for chain 1"), true);
});

test("an unreadable base fee at creation is an error, never a recorded zero", async () => {
  let err;
  try {
    await newJob({ baseFee: 10n * GWEI, readFails: true });
  } catch (e) {
    err = e;
  }
  eq(err instanceof RpcError, true);
});

// ── the scheduler ───────────────────────────────────────────────────────────

test("creation records the price at request time and the target defaults to it", async () => {
  const job = await newJob({ baseFee: 10n * GWEI });
  eq(job.quote.baseFeeGwei, "10");
  eq(job.quote.pricePerGasGwei, "10"); // tip 0, base 10
  eq(job.policy.targetBaseFeeGwei, "10");
  eq(job.policy.targetSource, "price at request time");
  eq(job.status, "HOLDING");
});

test("holds while the base fee is above target, submits the moment it drops", async () => {
  const state = { baseFee: 10n * GWEI };
  const job = await newJob(state, { targetBaseFeeGwei: "8" });
  const rpc = fakeRpc(state);

  const held = await tick(job, { rpc, now: NOW + 30_000 });
  eq(held.status, "HOLDING");
  eq(held.checks, 1);
  eq(state.sent ?? 0, 0);

  state.baseFee = 8n * GWEI;
  const sent = await tick(held, { rpc, now: NOW + 60_000 });
  eq(sent.status, "SUBMITTED");
  eq(sent.submit.reason, "FAVORABLE");
  eq(sent.submit.baseFeeWei, (8n * GWEI).toString());
  eq(sent.rawTx, null, "the signed transaction is dropped once broadcast");
});

test("never misses the deadline: submits at the margin even when gas stays high", async () => {
  const state = { baseFee: 50n * GWEI };
  // tip 0, maxFee well above, so it is includable but never "favorable" (target 8)
  const job = await newJob(state, { targetBaseFeeGwei: "8" }, rawType2({ maxFee: 100n * GWEI }));
  const rpc = fakeRpc(state);

  let cur = job;
  let now = NOW;
  while (cur.status === "HOLDING") {
    now = Math.min(cur.nextWakeAt, cur.deadlineAt);
    cur = await tick(cur, { rpc, now });
    if (now > cur.deadlineAt + 5 * MIN) throw new Error("job never submitted");
  }
  eq(cur.status, "SUBMITTED");
  eq(cur.submit.reason, "DEADLINE");
  eq(cur.submit.late, false);
  eq(now <= job.deadlineAt, true, "broadcast happened no later than the deadline");
  eq(state.sent, 1);
});

test("the deadline still fires when the node cannot be read at all", async () => {
  const state = { baseFee: 10n * GWEI };
  const job = await newJob(state, { targetBaseFeeGwei: "1" });
  state.readFails = true;
  const rpc = fakeRpc(state);
  const out = await tick(job, { rpc, now: job.deadlineAt - 5_000 });
  eq(out.status, "SUBMITTED");
  eq(out.submit.reason, "DEADLINE");
});

test("a maxFee below the base fee holds instead of broadcasting a doomed transaction, until the deadline", async () => {
  const state = { baseFee: 10n * GWEI };
  const job = await newJob(state, {}, rawType2({ maxFee: 5n * GWEI }));
  eq(job.warnings.some((w) => w.includes("below the current base fee")), true);
  const held = await tick(job, { rpc: fakeRpc(state), now: NOW + 30_000 });
  eq(held.status, "HOLDING");
  eq(decide(held, 10n * GWEI, job.deadlineAt, DEFAULTS).reason, "DEADLINE");
});

test("transient send failures are retried and the job still submits", async () => {
  const state = { baseFee: 10n * GWEI, sendScript: ["transient", "transient"] };
  const rpc = fakeRpc(state);
  let job = await newJob(state);
  let now = NOW + 1000;
  for (let i = 0; i < 5 && job.status === "HOLDING"; i++) {
    job = await tick(job, { rpc, now });
    now = job.nextWakeAt ?? now;
  }
  eq(job.status, "SUBMITTED");
  eq(job.submit.attempts, 3);
});

test("a send that timed out but landed is recognised by hash, not resent or failed", async () => {
  const state = { baseFee: 10n * GWEI, sendScript: ["transient-but-landed"] };
  const rpc = fakeRpc(state);
  let job = await newJob(state);
  job = await tick(job, { rpc, now: NOW + 1000 });
  eq(job.status, "HOLDING");
  job = await tick(job, { rpc, now: job.nextWakeAt });
  eq(job.status, "SUBMITTED");
  eq(job.submit.txHash, job.tx.hash);
  eq(state.sent ?? 0, 0, "no second broadcast");
});

test("a permanent rejection ends FAILED with the node's reason, not a made-up hash", async () => {
  const state = { baseFee: 10n * GWEI, sendScript: ["reject:nonce too low"] };
  const job = await tick(await newJob(state), { rpc: fakeRpc(state), now: NOW + 1000 });
  eq(job.status, "FAILED");
  eq(job.submit.txHash ?? null, null);
  eq(job.lastError.includes("nonce too low"), true);
  eq(job.rawTx, null);
});

test("when every attempt fails the job says FAILED instead of pretending", async () => {
  const state = { baseFee: 10n * GWEI, sendScript: Array(20).fill("transient") };
  const rpc = fakeRpc(state);
  let job = await newJob(state);
  let now = NOW + 1000;
  for (let i = 0; i < 20 && job.status === "HOLDING"; i++) {
    job = await tick(job, { rpc, now });
    now = job.nextWakeAt ?? now;
  }
  eq(job.status, "FAILED");
  eq(job.submit.attempts, DEFAULTS.maxSendAttempts);
});

test("a broadcast that lands after the deadline is flagged late", async () => {
  const state = { baseFee: 10n * GWEI };
  const job = await newJob(state, { targetBaseFeeGwei: "1" });
  const out = await tick(job, { rpc: fakeRpc(state), now: job.deadlineAt + 10_000 });
  eq(out.status, "SUBMITTED");
  eq(out.submit.late, true);
  eq(out.events.some((e) => e.type === "LATE"), true);
});

test("settlement reports gas actually paid against the request-time price, like for like", async () => {
  const state = { baseFee: 10n * GWEI };
  const rpc = fakeRpc(state);
  let job = await newJob(state, { targetBaseFeeGwei: "10" }, rawType2({ tip: 0n, maxFee: 12n * GWEI }));
  job = await tick(job, { rpc, now: NOW + 1000 });
  eq(job.status, "SUBMITTED");

  // Receipt: paid 8 gwei, quote was 10 gwei, 60,000 gas used.
  state.receipt = { status: "0x1", gasUsed: hex(60_000n), effectiveGasPrice: hex(8n * GWEI), blockNumber: hex(555) };
  job = await tick(job, { rpc, now: NOW + 7000 });
  eq(job.status, "SETTLED");
  eq(job.settlement.outcome, "SAVED");
  eq(job.settlement.paidWei, (60_000n * 8n * GWEI).toString());
  eq(job.settlement.quotedCostWei, (60_000n * 10n * GWEI).toString());
  eq(job.settlement.differenceWei, (60_000n * 2n * GWEI).toString());
  eq(job.settlement.differencePct, "20.00");
  eq(job.settlement.blockNumber, 555);
  eq(job.settlement.simulated, false);
});

test("paying more than the request-time price is reported as EXTRA, not hidden", async () => {
  const state = { baseFee: 10n * GWEI };
  const rpc = fakeRpc(state);
  let job = await newJob(state, { targetBaseFeeGwei: "10" }, rawType2({ maxFee: 30n * GWEI }));
  job = await tick(job, { rpc, now: NOW + 1000 });
  state.receipt = { status: "0x1", gasUsed: hex(50_000n), effectiveGasPrice: hex(15n * GWEI) };
  job = await tick(job, { rpc, now: NOW + 7000 });
  eq(job.settlement.outcome, "EXTRA");
  eq(job.settlement.differenceWei, (50_000n * 5n * GWEI).toString());
});

test("a reverted transaction still reports what it cost", async () => {
  const state = { baseFee: 10n * GWEI };
  const rpc = fakeRpc(state);
  let job = await tick(await newJob(state), { rpc, now: NOW + 1000 });
  state.receipt = { status: "0x0", gasUsed: hex(21_000n), effectiveGasPrice: hex(10n * GWEI) };
  job = await tick(job, { rpc, now: NOW + 7000 });
  eq(job.status, "REVERTED");
  eq(job.settlement.executed, false);
  eq(job.settlement.paidWei, (21_000n * 10n * GWEI).toString());
});

test("no receipt past the timeout is UNCONFIRMED with no paid figure", async () => {
  const state = { baseFee: 10n * GWEI };
  const rpc = fakeRpc(state);
  let job = await tick(await newJob(state), { rpc, now: NOW + 1000 });
  job = await tick(job, { rpc, now: NOW + 1000 + DEFAULTS.receiptTimeoutMs + 1 });
  eq(job.status, "UNCONFIRMED");
  eq(job.settlement, null);
});

test("dry run broadcasts nothing and labels its figures as simulated worst case", async () => {
  const state = { baseFee: 10n * GWEI };
  const job = await tick(await newJob(state, { dryRun: true }), { rpc: fakeRpc(state), now: NOW + 1000 });
  eq(job.status, "SIMULATED");
  eq(job.settlement.simulated, true);
  eq(job.settlement.note.includes("nothing was broadcast"), true);
  eq(state.sent ?? 0, 0);
});

test("only a holding job can be cancelled, and cancelling drops the signed transaction", async () => {
  const state = { baseFee: 10n * GWEI };
  const job = await newJob(state);
  const r = cancel(job, NOW + 5);
  eq(r.ok, true);
  eq(r.job.status, "CANCELLED");
  eq(r.job.rawTx, null);
  const sent = await tick(job, { rpc: fakeRpc(state), now: NOW + 1000 });
  eq(cancel(sent, NOW + 2000).ok, false);
});

test("tick does not mutate the job it was given", async () => {
  const state = { baseFee: 10n * GWEI };
  const job = await newJob(state, { targetBaseFeeGwei: "1" });
  const before = JSON.stringify(job);
  await tick(job, { rpc: fakeRpc(state), now: NOW + 30_000 });
  eq(JSON.stringify(job), before);
});

// ── optimizer on storage ────────────────────────────────────────────────────

function memoryStorage() {
  const m = new Map();
  let alarm = null;
  return {
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => void m.set(k, structuredClone(v)),
    delete: async (k) => m.delete(k),
    list: async ({ prefix = "" } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    getAlarm: async () => alarm,
    setAlarm: async (t) => void (alarm = t),
    deleteAlarm: async () => void (alarm = null),
  };
}

function engine(state, startAt = NOW) {
  const clock = { now: startAt };
  const storage = memoryStorage();
  let n = 0;
  const e = createOptimizer({
    storage,
    rpc: fakeRpc(state),
    clock: () => clock.now,
    newId: () => (++n).toString(16).padStart(32, "0"),
  });
  return { e, clock, storage };
}

test("the API view never carries the signed transaction", async () => {
  const { e } = engine({ baseFee: 10n * GWEI });
  const { job } = await e.create({ rawTx: rawType2(), deadlineMinutes: 10 });
  eq("rawTx" in job, false);
  eq(job.hasRawTx, true);
  eq(JSON.stringify(job).includes(rawType2().slice(10, 60)), false);
  eq(jobView({ ...job, rawTx: null }).hasRawTx, false);
});

test("runDue samples the head into history, and flat prices read as flat", async () => {
  const { e, clock } = engine({ baseFee: 10n * GWEI });
  for (let i = 0; i < 3; i++) {
    await e.runDue();
    clock.now += 61_000;
  }
  const h = await e.history();
  eq(h.samples.length, 3);
  eq(h.summary.moved, false);
  eq(h.summary.latestGwei, "10");
  eq(h.note.includes("flat line is the measurement"), true);
});

test("runDue does not sample twice inside one interval", async () => {
  const { e, clock } = engine({ baseFee: 10n * GWEI });
  await e.runDue();
  clock.now += 5_000;
  await e.runDue();
  eq((await e.history()).samples.length, 1);
});

test("a failed sample is counted and surfaced, not recorded as a price", async () => {
  const { e } = engine({ baseFee: 10n * GWEI, readFails: true });
  await e.runDue();
  const h = await e.history();
  eq(h.samples.length, 0);
  eq(h.sampling.failedSamples, 1);
  eq(h.sampling.lastError.includes("503"), true);
});

test("end to end on a virtual clock: a 10 minute deadline under a price that never drops", async () => {
  const state = { baseFee: 20n * GWEI };
  const { e, clock } = engine(state);
  const { job } = await e.create({ rawTx: rawType2({ maxFee: 40n * GWEI }), deadlineMinutes: 10, targetBaseFeeGwei: "5" });

  let steps = 0;
  let v = job;
  while (v.status === "HOLDING" || v.status === "SUBMITTED") {
    const { nextWakeAt } = await e.runDue();
    clock.now = Math.max(clock.now + 1, nextWakeAt);
    if (state.onChain && !state.receipt) {
      state.receipt = { status: "0x1", gasUsed: hex(80_000n), effectiveGasPrice: hex(20n * GWEI), blockNumber: hex(9) };
    }
    v = await e.get(job.id);
    if (++steps > 200) throw new Error(`did not finish: ${v.status}`);
  }
  eq(v.status, "SETTLED");
  eq(v.submit.reason, "DEADLINE");
  eq(v.submit.at <= job.deadlineAt, true);
  eq(v.settlement.outcome, "SAME", "price never moved: quoted 20 gwei, paid 20 gwei");
});

test("the number of simultaneously active jobs is capped", async () => {
  const { e } = engine({ baseFee: 10n * GWEI });
  for (let i = 0; i < MAX_ACTIVE_JOBS; i++) await e.create({ rawTx: rawType2({ nonce: BigInt(i) }), deadlineMinutes: 10 });
  let err;
  try {
    await e.create({ rawTx: rawType2({ nonce: 999n }), deadlineMinutes: 10 });
  } catch (x) {
    err = x;
  }
  eq(err instanceof InputError && err.field === "capacity", true);
});

test("job ids that are not 128-bit hex are never looked up", async () => {
  const { e } = engine({ baseFee: 10n * GWEI });
  eq(await e.get("../history"), null);
  eq(await e.cancel("job:x"), null);
});

// ── the Durable Object shell ────────────────────────────────────────────────

test("the Durable Object serves the API and arms an alarm that runs the engine", async () => {
  const storage = memoryStorage();
  const state = { baseFee: 10n * GWEI };
  const clock = { now: NOW };
  const obj = new Optimizer({ storage }, {}, { rpc: fakeRpc(state), clock: () => clock.now });

  const created = await obj.fetch(new Request("https://x/api/jobs", {
    method: "POST",
    body: JSON.stringify({ rawTx: rawType2(), deadlineMinutes: 10, dryRun: true }),
  }));
  eq(created.status, 201);
  const job = await created.json();
  eq("rawTx" in job, false);
  eq((await storage.getAlarm()) != null, true, "an alarm exists after creating a job");

  clock.now += 2000;
  await obj.alarm();
  const after = await (await obj.fetch(new Request(`https://x/api/jobs/${job.id}`))).json();
  eq(after.status, "SIMULATED");
  eq((await storage.getAlarm()) != null, true, "the alarm re-arms for the next price sample");

  eq((await obj.fetch(new Request("https://x/api/jobs/" + "0".repeat(32)))).status, 404);
  eq((await obj.fetch(new Request("https://x/api/jobs", { method: "POST", body: "{" }))).status, 400);
  eq((await obj.fetch(new Request("https://x/api/jobs", { method: "POST", body: "x".repeat(20_000) }))).status, 400);
});

test("accepts a 32-byte on-chain Pharos tx hash, holds until favorable or deadline, and settles against its receipt", async () => {
  const txHash = "0xd3750bf50a417ab0cfab0586227367a3aec39c967946d4f1439e1760c3e96ff4";
  const state = {
    baseFee: 10n * GWEI,
    txByHash: {
      hash: txHash,
      type: "0x2",
      chainId: hex(1672n),
      nonce: "0x26",
      gas: hex(1_000_000n),
      maxFeePerGas: hex(20_281_648_221n),
      maxPriorityFeePerGas: hex(10_281_648_221n),
      to: "0x802b65b5d90a66ebe2f7f161da632fb97c2f3f53",
      value: "0x0",
    },
    receipt: {
      status: "0x1",
      gasUsed: hex(80_103n),
      effectiveGasPrice: hex(20_281_648_221n),
      blockNumber: hex(22_618_822),
    },
  };
  const rpc = fakeRpc(state);
  let job = await createJob({
    rpc,
    body: { rawTx: txHash, deadlineMinutes: 10 },
    now: NOW,
    id: "b".repeat(32),
  });
  eq(job.tx.alreadyOnChain, true);
  eq(job.tx.hash, txHash);
  eq(job.quote.pricePerGasGwei, "10");

  job = await tick(job, { rpc, now: NOW + 1000 });
  eq(job.status, "SETTLED");
  eq(job.settlement.outcome, "EXTRA");
  eq(job.settlement.gasUsed, "80103");
  eq(job.settlement.blockNumber, 22_618_822);
});

process.exit(await run());
