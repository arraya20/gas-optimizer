// Offline unit tests: no network, no dependencies, deterministic.
//
// Every assertion here is arithmetic or validation that must hold regardless of
// what the chain is doing. Live behaviour is tested separately.

import { test, run, eq, throws, near, setFile } from "./harness.mjs";
import { formatUnits, formatPROS, formatGwei, percent, groupDigits, toBigInt, parseUnits, InputError } from "../src/numbers.mjs";
import { minimalFees, projectCost, advise } from "../src/cost.mjs";
import { validateRequest } from "../src/analyze.mjs";
import { buildPaymentRow, analysePayments, waitingVerdict } from "../src/fees.mjs";

setFile("unit");
const GWEI = 1_000_000_000n;
const ETHER = 10n ** 18n;

// ── formatting ───────────────────────────────────────────────────────────────

test("formatUnits never rounds a non-zero amount down to zero", () => {
  eq(formatUnits(1000n, 18), "0.000000000000001", "1000 wei");
  eq(formatUnits(1n, 18), "0.000000000000000001", "1 wei");
  eq(formatUnits(5n, 6), "0.000005", "tiny token amount");
});

test("formatUnits keeps every significant digit by default", () => {
  eq(formatUnits(123456789012345678n, 18), "0.123456789012345678");
  eq(formatUnits(ETHER + 1n, 18), "1.000000000000000001");
});

test("formatUnits trims trailing zeros but not leading place value", () => {
  eq(formatUnits(1500000000000000000n, 18), "1.5");
  eq(formatUnits(10n ** 18n, 18), "1");
  eq(formatUnits(0n, 18), "0");
});

test("formatUnits handles negatives and a digit cap", () => {
  eq(formatUnits(-5n * 10n ** 17n, 18), "-0.5");
  // A 6-digit cap on 0.000000000123456789 would erase the value entirely, so the
  // documented fallback keeps the full fraction instead of printing "0".
  eq(formatUnits(123456789n, 18, 6), "0.000000000123456789");
  eq(formatUnits(1234567890123456789n, 18, 6), "1.234567");
  // A cap that would erase the value falls back to the full fraction.
  eq(formatUnits(1000n, 18, 6), "0.000000000000001");
});

test("formatGwei and formatPROS use the right decimals", () => {
  eq(formatGwei(10n * GWEI), "10");
  eq(formatGwei(1500000000n), "1.5");
  eq(formatGwei(11_250_000_000n), "11.25");
  eq(formatPROS(1628490000000000n), "0.00162849");
});

test("groupDigits separates thousands", () => {
  eq(groupDigits(162849n), "162,849");
  eq(groupDigits(1000000000n), "1,000,000,000");
  eq(groupDigits(-1500n), "-1,500");
});

test("percent returns a percentage, not a fraction", () => {
  eq(percent(26n, 44n), "59.09", "zero-tip majority");
  eq(percent(1n, 4n), "25");
  eq(percent(0n, 10n), "0");
  eq(percent(773n, 773n), "100");
  eq(percent(1n, 0n), "n/a");
});

test("parseUnits reads a fractional gas price", () => {
  eq(parseUnits("11.25", 9), 11_250_000_000n);
  eq(parseUnits("0.5", 9), 500_000_000n);
  eq(parseUnits("10", 9), 10n * GWEI);
  eq(parseUnits("0", 9), 0n);
  throws(() => parseUnits("1.1234567891", 9), "too many decimals");
  throws(() => parseUnits("abc", 9), "not a decimal");
});

test("toBigInt rejects numbers that already lost precision", () => {
  eq(toBigInt(123n), 123n);
  eq(toBigInt("0x10"), 16n);
  eq(toBigInt("42"), 42n);
  throws(() => toBigInt(Number.MAX_SAFE_INTEGER + 2), /safe integer/, "unsafe number");
  throws(() => toBigInt("abc"), "not an integer", "garbage");
  throws(() => toBigInt(""), "empty", "empty string");
  throws(() => toBigInt(1.5), /safe integer/, "fractional");
});

// ── cost model ───────────────────────────────────────────────────────────────

test("minimalFees sits exactly on the base fee when the tip is zero", () => {
  const m = minimalFees({ baseFeeWei: 10n * GWEI });
  eq(m.maxFeeWei, 10n * GWEI);
  eq(m.tipWei, 0n);
});

test("minimalFees adds buffer and tip", () => {
  const m = minimalFees({ baseFeeWei: 10n * GWEI, bufferWei: 1n * GWEI, tipWei: 2n * GWEI });
  eq(m.maxFeeWei, 13n * GWEI);
});

test("minimalFees refuses a nonsense base fee or negative inputs", () => {
  throws(() => minimalFees({ baseFeeWei: 0n }), "positive", "zero base fee");
  throws(() => minimalFees({ baseFeeWei: 10n * GWEI, tipWei: -1n }), "negative");
});

test("projectCost charges min(maxFee, base+tip) per unit of gas used", () => {
  // base 10, tip 5 → bid 15; maxFee 20 does not bind, so you pay 15.
  const c = projectCost({ gasLimit: 100_000n, gasUsed: 50_000n, baseFeeWei: 10n * GWEI, maxFeeWei: 20n * GWEI, tipWei: 5n * GWEI });
  eq(c.effectiveGasPriceWei, 15n * GWEI);
  eq(c.paidWei, 750_000n * GWEI);
  eq(c.lockedWei, 2_000_000n * GWEI, "lock uses the limit, not the usage");
});

test("projectCost lets the maxFee cap bind when the tip overshoots it", () => {
  const c = projectCost({ gasLimit: 100_000n, baseFeeWei: 10n * GWEI, maxFeeWei: 12n * GWEI, tipWei: 5n * GWEI });
  eq(c.effectiveGasPriceWei, 12n * GWEI, "capped at maxFee");
});

test("projectCost refuses maxFee below base fee and gasUsed above the limit", () => {
  throws(
    () => projectCost({ gasLimit: 100n, baseFeeWei: 10n * GWEI, maxFeeWei: 9n * GWEI }),
    "below the base fee",
    "unsubmittable fee",
  );
  throws(() => projectCost({ gasLimit: 100n, gasUsed: 101n, baseFeeWei: 10n * GWEI, maxFeeWei: 10n * GWEI }), "cannot exceed");
  throws(() => projectCost({ gasLimit: 0n, baseFeeWei: 10n * GWEI, maxFeeWei: 10n * GWEI }), "positive");
});

test("a minimal setting with a zero tip pays exactly base × gas", () => {
  const c = projectCost({ gasLimit: 162_849n, baseFeeWei: 10n * GWEI, maxFeeWei: 10n * GWEI, tipWei: 0n });
  eq(c.paidWei, 1628490000000000n);
  eq(c.lockedWei, 1628490000000000n);
});

// ── advice ───────────────────────────────────────────────────────────────────

test("advise calls a base-fee-only setting ALREADY_MINIMAL", () => {
  const a = advise({ gasLimit: 100_000n, baseFeeWei: 10n * GWEI, declaredMaxFeeWei: 10n * GWEI, declaredTipWei: 0n });
  eq(a.verdict, "ALREADY_MINIMAL");
  eq(a.spentSavingWei, "0");
  eq(a.lockSavingWei, "0");
});

test("advise flags a tip as money spent, not money locked", () => {
  const a = advise({ gasLimit: 100_000n, baseFeeWei: 10n * GWEI, declaredMaxFeeWei: 15n * GWEI, declaredTipWei: 5n * GWEI });
  eq(a.verdict, "OVERPAYING");
  eq(a.spentSavingWei, (5n * GWEI * 100_000n).toString(), "5 gwei over 100k gas");
  eq(a.lockSavingWei, (5n * GWEI * 100_000n).toString(), "same figure, locked side");
});

test("advise separates a pure over-lock from an overpayment", () => {
  const a = advise({ gasLimit: 100_000n, baseFeeWei: 10n * GWEI, declaredMaxFeeWei: 20n * GWEI, declaredTipWei: 0n });
  eq(a.verdict, "OVER_LOCKED", "maxFee above base with no tip spends nothing extra");
  eq(a.spentSavingWei, "0");
  eq(a.lockSavingWei, (10n * GWEI * 100_000n).toString());
});

test("advise keeps the declared tip when a zero tip is unproven", () => {
  const a = advise({
    gasLimit: 100_000n,
    baseFeeWei: 10n * GWEI,
    declaredMaxFeeWei: 15n * GWEI,
    declaredTipWei: 5n * GWEI,
    slotPolicy: "match-declared",
  });
  eq(a.recommended.effectiveGasPriceWei, 15n * GWEI, "recommendation must not undercut a tip we cannot prove is safe");
});

test("advise refuses to advise without a base fee", () => {
  const a = advise({ gasLimit: 100_000n, baseFeeWei: null });
  eq(a.verdict, "UNMEASURABLE");
  eq(a.recommended, null);
});

test("advise reports NO_DECLARED_FEE rather than inventing a verdict", () => {
  const a = advise({ gasLimit: 100_000n, baseFeeWei: 10n * GWEI });
  eq(a.verdict, "NO_DECLARED_FEE");
  eq(a.recommended.effectiveGasPriceWei, 10n * GWEI);
});

// ── request validation ──────────────────────────────────────────────────────

test("validateRequest accepts a plain transaction description", () => {
  const r = validateRequest({ gasLimit: 100000, gasUsed: 21000, maxFeeGwei: "12.5", tipGwei: "0" });
  eq(r.gasLimit, 100000n);
  eq(r.gasUsed, 21000n);
  eq(r.maxFeeWei.wei, 12_500_000_000n);
  eq(r.tipWei.wei, 0n);
});

test("validateRequest refuses a caller-supplied market number", () => {
  for (const field of ["baseFee", "baseFeeWei", "gasPrice", "currentGasGwei", "effectiveGasPrice"]) {
    throws(() => validateRequest({ gasLimit: 21000, [field]: 1 }), "may not be supplied", field);
  }
});

test("validateRequest refuses a caller-supplied verdict", () => {
  for (const field of ["verdict", "recommendation", "shouldExecute", "decision", "savings"]) {
    throws(() => validateRequest({ gasLimit: 21000, [field]: "x" }), "may not be supplied", field);
  }
});

test("validateRequest requires a plausible gas limit", () => {
  throws(() => validateRequest({}), "gasLimit is required");
  throws(() => validateRequest({ gasLimit: 0 }), "positive");
  throws(() => validateRequest({ gasLimit: 99_000_000 }), "plausible");
  throws(() => validateRequest({ gasLimit: 21000, gasUsed: 30000 }), "cannot exceed");
});

test("validateRequest rejects a non-object body", () => {
  throws(() => validateRequest(null), "JSON object");
  throws(() => validateRequest([1, 2]), "JSON object");
  throws(() => validateRequest("x"), "JSON object");
});

// ── payment analysis ────────────────────────────────────────────────────────

const GWEI10 = 10n * GWEI;
function row({ hash = "0x1", blockNumber = 1, gasUsed = 100_000n, gasLimit = 100_000n, effGwei = 10n, maxFeeGwei = 10n, tipGwei = 0n } = {}) {
  return buildPaymentRow(
    {
      blockNumber,
      baseFeeWei: GWEI10,
      tx: {
        hash,
        type: "0x2",
        gasLimit: `0x${gasLimit.toString(16)}`,
        maxFeePerGas: `0x${(maxFeeGwei * GWEI).toString(16)}`,
        maxPriorityFeePerGas: `0x${(tipGwei * GWEI).toString(16)}`,
      },
    },
    { status: "0x1", gasUsed: `0x${gasUsed.toString(16)}`, effectiveGasPrice: `0x${(effGwei * GWEI).toString(16)}` },
  );
}

test("buildPaymentRow skips reverted transactions", () => {
  const r = buildPaymentRow(
    { blockNumber: 1, baseFeeWei: GWEI10, tx: { hash: "0x2", gasLimit: "0x5208" } },
    { status: "0x0", gasUsed: "0x5208", effectiveGasPrice: `0x${GWEI10.toString(16)}` },
  );
  eq(r, null);
});

test("buildPaymentRow computes paid, paid tip and locked balance", () => {
  const r = row({ gasUsed: 50_000n, gasLimit: 100_000n, effGwei: 15n, maxFeeGwei: 20n, tipGwei: 5n });
  eq(r.paidTip, 5n * GWEI);
  eq(r.paidWei, 750_000n * GWEI);
  eq(r.lockedWei, 2_000_000n * GWEI);
});

test("analysePayments counts zero-tip inclusion and both kinds of waste", () => {
  const rows = [
    row({ hash: "0xa", blockNumber: 1, effGwei: 10n, maxFeeGwei: 10n }),
    row({ hash: "0xb", blockNumber: 1, effGwei: 10n, maxFeeGwei: 20n }),
    row({ hash: "0xc", blockNumber: 2, effGwei: 15n, maxFeeGwei: 20n, tipGwei: 5n }),
    row({ hash: "0xd", blockNumber: 2, effGwei: 10n, maxFeeGwei: 10n }),
  ];
  const a = analysePayments(rows, { baseFeeWei: GWEI10 });
  eq(a.transactions, 4);
  eq(a.blocks, 2);
  eq(a.zeroTipCount, 3, "three paid base only");
  eq(a.zeroTipShare, "75");
  eq(a.positiveTipCount, 1);
  eq(a.tipTotalWei, (5n * GWEI * 100_000n).toString());
  eq(a.tipShareOfFees, "11.11", "tip share of everything paid");
  eq(a.lockExtraWei, (10n * GWEI * 100_000n * 2n).toString(), "two rows over-locked maxFee");
  eq(a.overbidders, 2);
  eq(a.overbidShare, "50");
});

test("analysePayments refuses to invent statistics from nothing", () => {
  eq(analysePayments([]).measured, false);
  eq(analysePayments(null).measured, false);
});

// ── the central question ────────────────────────────────────────────────────

const frozenMarket = {
  distinctCount: 1,
  distinctGwei: ["10"],
  blocksObserved: 2048,
  windows: [{}, {}, {}, {}],
};

test("waiting cannot help when the base fee never moved and zero-tip txs land", () => {
  const v = waitingVerdict({ baseFee: frozenMarket, analyse: { measured: true, zeroTipShare: "74", transactions: 773 } });
  eq(v.canHelp, false);
  eq(v.reasons.length >= 2, true);
});

test("waiting might help when the base fee did move", () => {
  const v = waitingVerdict({ baseFee: { ...frozenMarket, distinctCount: 3, distinctGwei: ["9", "10", "12"] }, analyse: null });
  eq(v.canHelp, true);
});

test("waiting is unproven when nobody was included without a tip", () => {
  const v = waitingVerdict({ baseFee: frozenMarket, analyse: { measured: true, zeroTipShare: "0", transactions: 50 } });
  eq(v.canHelp, null, "cannot recommend a zero tip we never observed being accepted");
});

test("waiting claims nothing without base fee history", () => {
  eq(waitingVerdict({ baseFee: null, analyse: null }).canHelp, null);
  eq(waitingVerdict({ baseFee: { distinctCount: null }, analyse: null }).canHelp, null);
});

const failures = await run();
process.exit(failures === 0 ? 0 : 1);
