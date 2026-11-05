// Live tests against the real Pharos node. Opt-in: `npm run test:live`.
//
// These assert shape and internal consistency, never a specific verdict or a
// specific fee. The chain moves; a test that pins today's numbers is a test that
// breaks tomorrow for no reason.

import { createRpc } from "../src/rpc.mjs";
import { validateRequest, analyze } from "../src/analyze.mjs";
import { capacityFromBlocks, sampleTransactions } from "../src/fees.mjs";
import { test, run, eq, setFile } from "./harness.mjs";

setFile("live");

const rpc = createRpc({ retries: 2, timeoutMs: 25000 });
let cached = null;

async function report() {
  if (!cached) {
    const request = validateRequest({ gasLimit: 162849, maxFeeGwei: "22.91779976", tipGwei: "8.83464938" });
    cached = await analyze({ rpc, request, sampleBlocks: 120 });
  }
  return cached;
}

test("the node answers with the expected chain id", async () => {
  const r = await report();
  eq(r.chain.id, 1672);
  eq(r.chain.head > 0, true);
});

test("the base fee is reported in gwei and matches the raw wei", async () => {
  const r = await report();
  eq(/^\d+(\.\d+)?$/.test(r.market.baseFeeGwei), true, `gwei looks numeric: ${r.market.baseFeeGwei}`);
  eq(BigInt(r.market.baseFeeWei) > 0n, true);
  eq(BigInt(r.market.baseFeeWei), BigInt(Math.round(Number(r.market.baseFeeGwei) * 1e9)));
});

test("history was actually sampled across several disjoint windows", async () => {
  const r = await report();
  eq(r.market.windows.length >= 3, true, "at least three windows");
  eq(r.market.blocksObserved > 1000, true, "more than a thousand blocks observed");
  for (const w of r.market.windows) {
    eq(w.error === null || typeof w.error === "string", true);
  }
});

test("the frozen claim agrees with the distinct values it listed", async () => {
  const r = await report();
  const m = r.market;
  // frozen is tri-state: true = measured flat everywhere, false = measured to
  // move, null = too few windows answered to say. A partial read must not be
  // promoted into "the price never moves".
  if (m.frozen === true) {
    eq(m.distinctCount, 1, "frozen requires exactly one distinct value");
    eq(m.windowsFailed, 0, "frozen requires every requested window to have answered");
  }
  if (m.frozen === false) {
    eq(m.distinctCount > 1, true, "a price that moved has more than one distinct value");
  }
  if (m.coverageComplete === false) {
    eq(m.frozen, null, "incomplete coverage cannot settle the flat/frozen question");
    eq(m.windowsFailed > 0, true);
  }
  eq(m.distinctGwei.length, m.distinctCount);
  eq(
    m.windowsSucceeded + m.windowsFailed,
    m.windowsAttempted,
    "every attempted window is either answered or counted as failed",
  );
});

test("capacity figures are plausible fractions", async () => {
  const r = await report();
  const c = r.market.capacity;
  if (c.blocksSampled === 0) return;
  eq(c.aggregateUtilisation >= 0 && c.aggregateUtilisation <= 1, true);
  eq(c.peakUtilisation >= c.aggregateUtilisation, true, "a peak cannot be below the aggregate");
  eq(c.emptyCount <= c.blocksSampled, true);
  eq(c.spanBlocks >= c.blocksSampled, true, "span covers the sampled blocks");
});

test("headroom band is stable across independent windows", async () => {
  // The regression this exists for: the old figure was round(1/peak) over 32
  // consecutive blocks and moved by 17x between renders of the same chain.
  // Two unrelated windows must now agree on the band, not on the digits.
  const a = capacityFromBlocks((await sampleTransactions(createRpc({ retries: 1, timeoutMs: 20000 }), { blocks: 96, stride: 800, concurrency: 12 })).blockSummaries);
  const b = capacityFromBlocks((await sampleTransactions(createRpc({ retries: 1, timeoutMs: 20000 }), { blocks: 96, stride: 811, concurrency: 12 })).blockSummaries);
  eq(a.blocksSampled > 50 && b.blocksSampled > 50, true, "both windows actually read blocks");
  eq(
    a.headroomAtLeastX,
    b.headroomAtLeastX,
    `bands disagree: ${a.headroomAtLeastX} vs ${b.headroomAtLeastX} ` +
      `(aggregate ${a.aggregateUtilisation} vs ${b.aggregateUtilisation})`,
  );
  eq(a.congestion, b.congestion, "queue state must not flap between windows");
});

test("capacity is computed from the blocks the payment sample read", async () => {
  const r = await report();
  eq(
    r.market.capacity.blocksSampled <= r.sample.blocksScanned,
    true,
    "capacity cannot claim more blocks than the sample fetched",
  );
  eq(r.market.capacity.failedBlocks, r.sample.failedBlocks, "same failures, same window");
});

test("the payment sample holds together arithmetically", async () => {
  const r = await report();
  if (!r.sample.transactions) return;
  eq(r.sample.transactions > 0, true);
  eq(r.sample.zeroTipCount <= r.sample.transactions, true, "zero-tip count cannot exceed the sample");
  eq(Number(r.sample.zeroTipShare) >= 0 && Number(r.sample.zeroTipShare) <= 100, true, "share is a percentage");
  eq(BigInt(r.sample.tipTotalWei) <= BigInt(r.sample.paidTotalWei), true, "tips are part of what was paid");
  if (r.sample.medianPositiveTipGwei) {
    eq(Number(r.sample.medianPositiveTipGwei) > 0, true, "a positive median tip must be above zero");
  }
});

test("zero tips really do get included when the sample says so", async () => {
  const r = await report();
  if (!r.sample.transactions || Number(r.sample.zeroTipShare) === 0) return;
  eq(r.sample.zeroTipCount > 0, true, "a non-zero zero-tip share requires non-zero zero-tip transactions");
});

test("the recommendation never exceeds the base fee when a zero tip is proven", async () => {
  const r = await report();
  if (r.advice.verdict === "UNMEASURABLE" || !r.advice.recommended) return;
  if (Number(r.sample.zeroTipShare) > 0) {
    eq(BigInt(r.advice.recommended.maxFeeWei), BigInt(r.market.baseFeeWei), "minimal maxFee sits on the base fee");
  }
});

test("a declared fee above base is reported as overpaying", async () => {
  const r = await report();
  eq(["OVERPAYING", "TIP_ABOVE_BASE"].includes(r.advice.verdict), true, `declared 22.9 gwei against a 10 gwei base: ${r.advice.verdict}`);
  eq(BigInt(r.advice.spentSavingWei) > 0n, true, "the tip portion is a real saving");
});

test("spent and locked savings are reported separately and stay consistent", async () => {
  const r = await report();
  if (!r.advice.declared) return;
  eq(BigInt(r.advice.spentSavingWei) >= 0n, true);
  eq(BigInt(r.advice.lockSavingWei) >= 0n, true);
  eq(
    BigInt(r.advice.lockSavingWei) >= BigInt(r.advice.spentSavingWei),
    true,
    "the lock gap cannot be smaller than the spend gap for an over-locked tx",
  );
});

test("the not-measured list is never empty", async () => {
  const r = await report();
  eq(r.notMeasured.length > 0, true);
  eq(r.notMeasured.every((s) => typeof s === "string" && s.length > 20), true);
});

test("the waiting verdict is one of three honest answers", async () => {
  const r = await report();
  eq([false, true, null].includes(r.waiting.canHelp), true, `got ${r.waiting.canHelp}`);
  eq(r.waiting.reasons.length > 0, true);
});

test("the whole report survives JSON serialisation without BigInt leakage", async () => {
  const text = JSON.stringify(await report());
  eq(/:\s*-?\d+n[,\s}]/.test(text), false);
});

const failures = await run();
process.exit(failures === 0 ? 0 : 1);
