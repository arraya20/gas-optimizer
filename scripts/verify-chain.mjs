#!/usr/bin/env node
// Re-derive every headline claim straight from the chain.
//
// This deliberately does NOT import src/. If it reused the analysis code it
// would only prove the code agrees with itself. Here we go back to raw blocks
// and receipts, do the arithmetic again, and print the block numbers and hashes
// so a claim can be checked by hand.

import { createRpc } from "../src/rpc.mjs";

const rpc = createRpc({ retries: 3, timeoutMs: 25000 });
const GWEI = 1_000_000_000n;
const gwei = (wei) => {
  const v = BigInt(wei);
  const whole = v / GWEI;
  const frac = v % GWEI;
  if (frac === 0n) return `${whole}`;
  return `${whole}.${frac.toString().padStart(9, "0").replace(/0+$/, "")}`;
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  pass" : "  FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

const head = await rpc.blockNumber();
console.log(`verifying at block ${head}\n`);

// ── claim 1: the base fee has one value across independent block headers ──────
console.log("claim: the base fee never moves\n");

const SAMPLES = [0, 5_000, 50_000, 500_000, 2_000_000, 8_000_000];
const observed = [];
for (const offset of SAMPLES) {
  const n = head - offset;
  if (n < 1) continue;
  const b = await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
  if (!b) continue;
  observed.push({ block: n, baseFee: BigInt(b.baseFeePerGas) });
}

const distinct = [...new Set(observed.map((o) => o.baseFee.toString()))];
check(
  `one base fee value across ${observed.length} block headers spanning ${head - Math.min(...observed.map((o) => o.block))} blocks`,
  distinct.length === 1,
  distinct.length === 1
    ? `${gwei(distinct[0])} gwei at blocks ${observed.map((o) => o.block).join(", ")}`
    : `saw ${distinct.length} values: ${distinct.map(gwei).join(", ")} gwei`,
);

// The header says one thing; the receipts are what people were actually charged.
console.log("\nclaim: transactions are charged exactly that base fee when they do not tip\n");

async function collect({ blocks, concurrency = 16 }) {
  const numbers = [];
  for (let i = 0; i < blocks; i++) if (head - i >= 1) numbers.push(head - i);

  const blocksWithTxs = [];
  let cursor = 0;
  async function worker() {
    while (cursor < numbers.length) {
      const n = numbers[cursor++];
      const b = await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]);
      if (b && b.transactions.length > 0) blocksWithTxs.push(b);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const rows = [];
  for (const b of blocksWithTxs) {
    const base = BigInt(b.baseFeePerGas);
    for (const tx of b.transactions) {
      const r = await rpc.call("eth_getTransactionReceipt", [tx.hash]);
      if (!r || r.status !== "0x1") continue;
      const eff = BigInt(r.effectiveGasPrice);
      const used = BigInt(r.gasUsed);
      const limit = BigInt(tx.gasLimit ?? tx.gas);
      const maxFee = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : null;
      rows.push({
        hash: tx.hash,
        block: Number(BigInt(b.number)),
        base,
        eff,
        tip: eff - base,
        used,
        limit,
        maxFee,
        paid: eff * used,
      });
    }
  }
  return { rows, blocksWithTxs };
}

const { rows, blocksWithTxs } = await collect({ blocks: 400 });
const paidBaseOnly = rows.filter((r) => r.tip === 0n);
const tipped = rows.filter((r) => r.tip > 0n);

check(
  `zero-tip transactions get included (${paidBaseOnly.length} of ${rows.length} successful tx)`,
  paidBaseOnly.length > 0,
  paidBaseOnly.length > 0
    ? `example: ${paidBaseOnly[0].hash} in block ${paidBaseOnly[0].block} paid ${gwei(paidBaseOnly[0].eff)} gwei = base fee`
    : "no zero-tip transaction found in the window",
);

// The strongest form of the claim: two transactions in the SAME block, one
// tipping and one not. If the tip were required for inclusion, the zero-tip one
// could not be sitting beside a paying one.
const sameBlock = blocksWithTxs.find((b) => {
  const inBlock = rows.filter((r) => r.block === Number(BigInt(b.number)));
  return inBlock.some((r) => r.tip === 0n) && inBlock.some((r) => r.tip > 0n);
});
check(
  "a zero-tip and a tipping transaction share a block",
  Boolean(sameBlock),
  sameBlock
    ? `block ${Number(BigInt(sameBlock.number))}: tips present ${rows
        .filter((r) => r.block === Number(BigInt(sameBlock.number)))
        .map((r) => `${gwei(r.tip)} gwei`)
        .join(", ")}`
    : "no such block in the window — the claim would be unproven here",
);

// ── claim 3: how much is spent above base ────────────────────────────────────
console.log("\nclaim: a measurable share of every fee is paid above the base fee\n");

const paidTotal = rows.reduce((a, r) => a + r.paid, 0n);
const tipTotal = rows.reduce((a, r) => a + r.tip * r.used, 0n);
const tipPct = paidTotal > 0n ? Number((tipTotal * 10000n) / paidTotal) / 100 : 0;
check(
  `${tipPct.toFixed(2)}% of all fees paid went above the base fee`,
  tipPct > 0,
  `sample: ${rows.length} tx in ${new Set(rows.map((r) => r.block)).size} blocks; ${tipped.length} paid a tip, ${paidBaseOnly.length} did not`,
);

// ── claim 4: balance locked above the base fee ───────────────────────────────
console.log("\nclaim: wallets reserve more balance than the base fee requires\n");

const overMaxFee = rows.filter((r) => r.maxFee != null && r.maxFee > r.base);
const extraLock = overMaxFee.reduce((a, r) => a + (r.maxFee - r.base) * r.limit, 0n);
const ratios = rows.filter((r) => r.used > 0n).map((r) => Number(r.limit) / Number(r.used)).sort((a, b) => a - b);
const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;

check(
  `${overMaxFee.length} of ${rows.length} transactions set maxFee above the base fee`,
  overMaxFee.length > 0,
  overMaxFee.length > 0
    ? `locking ${(Number(extraLock) / 1e18).toFixed(6)} PROS more than needed across the sample`
    : "nobody overbid maxFee in this window",
);

check(
  `median gas limit is ${medianRatio ? medianRatio.toFixed(2) : "n/a"}x the gas actually used`,
  medianRatio == null || medianRatio >= 1,
  medianRatio && medianRatio > 1
    ? `a limit above usage multiplies the balance that must be reserved`
    : "gas limits were tight in this window",
);

// ── claim 5: there is spare gas capacity, and the band claim holds ───────────
console.log("\nclaim: blocks are far from full, so a higher bid buys nothing\n");

// Sampled independently of src/. Strided, because 200 consecutive blocks on this
// chain is one short burst of activity and says little about the rest of it.
const capNumbers = [];
for (let i = 0; i < 200; i++) {
  const n = head - i * 1000;
  if (n >= 1) capNumbers.push(n);
}
const capBlocks = [];
for (const n of capNumbers) {
  const b = await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
  if (b) capBlocks.push({ block: n, used: BigInt(b.gasUsed), limit: BigInt(b.gasLimit) });
}

const sumUsed = capBlocks.reduce((a, b) => a + b.used, 0n);
const sumLimit = capBlocks.reduce((a, b) => a + b.limit, 0n);
const emptyCount = capBlocks.filter((b) => b.used === 0n).length;
const aggregate = sumLimit > 0n ? Number((sumUsed * 1000000n) / sumLimit) / 1e6 : 0;
const peak = capBlocks.reduce((m, b) => Math.max(m, Number(b.used) / Number(b.limit)), 0);
const band = aggregate > 0 ? 10 ** Math.floor(Math.log10(1 / aggregate)) : null;

check(
  `aggregate gas demand was ${(aggregate * 100).toFixed(5)}% of capacity over ${capBlocks.length} blocks spanning ${Math.max(...capBlocks.map((b) => b.block)) - Math.min(...capBlocks.map((b) => b.block))} blocks`,
  aggregate < 0.01,
  `${emptyCount} of ${capBlocks.length} blocks used no gas at all; busiest was ${(peak * 100).toFixed(3)}% full`,
);

// The claim the report prints is a power of ten. Verify that specific number
// rather than the raw ratio: 1/aggregate must actually reach it.
check(
  band ? `"at least ${band}x spare capacity" is arithmetically true` : "no band claimed",
  band == null || 1 / aggregate >= band,
  band ? `1 / ${aggregate.toExponential(3)} = ${Math.round(1 / aggregate)}x, so ${band}x is a safe floor` : "no gas was used in the window",
);

// A peak is one block, so it must never be used to claim more headroom than it
// supports. This is the bug the banded figure replaced.
check(
  `busiest single block was ${(peak * 100).toFixed(3)}% full (block ${capBlocks.find((b) => Number(b.used) / Number(b.limit) === peak)?.block ?? "?"})`,
  peak < 0.5,
  `peak-based headroom would have read ${peak > 0 ? Math.round(1 / peak) : "infinite"}x — the figure that used to swing between renders`,
);

// ── arithmetic self-check on the sample ──────────────────────────────────────
console.log("\narithmetic self-check\n");
const recomputed = rows.every((r) => r.paid === r.eff * r.used && r.tip === r.eff - r.base);
check("paid = effectiveGasPrice × gasUsed and tip = effective - base for every row", recomputed);

const succeeded = results.filter((r) => r.ok).length;
console.log(`\n${succeeded}/${results.length} checks passed`);
if (succeeded !== results.length) {
  console.log("\nfailed checks:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`);
  process.exit(1);
}
