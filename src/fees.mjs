// Measure the live fee market, and decide whether waiting can help at all.
//
// The inherited scaffold compared a gas price the *user typed* against a target.
// That is not a monitor: whoever submits the request chooses the answer. Every
// number here comes from the node or it is reported as missing.

import { toBigInt, formatGwei, percent } from "./numbers.mjs";
import { toNumber } from "./rpc.mjs";

/**
 * Base fee across several disjoint windows of history.
 *
 * Disjoint windows matter: sampling one contiguous run can miss a regime change
 * that happened earlier, and a tool that claims "the price never moves" had
 * better have looked at more than the last few hundred blocks.
 *
 * @param {object} rpc
 * @param {object} [opts]
 * @param {number[]} [opts.offsets]  how far back each window ends, in blocks
 * @param {number} [opts.windowSize]
 */
export async function measureBaseFee(rpc, { offsets = [0, 200_000, 1_000_000, 5_000_000], windowSize = 1024 } = {}) {
  const head = await rpc.blockNumber();
  const windows = [];
  const allValues = new Set();

  for (const offset of offsets) {
    const end = head - offset;
    if (end < 1) continue;
    let hist;
    try {
      hist = await rpc.call("eth_feeHistory", [`0x${windowSize.toString(16)}`, `0x${end.toString(16)}`, []]);
    } catch (err) {
      // Record the failure instead of pretending the window was flat.
      windows.push({ offset, end, error: err.message });
      continue;
    }
    const values = (hist?.baseFeePerGas || []).map((v) => toBigInt(v, "baseFeePerGas"));
    if (values.length === 0) {
      windows.push({ offset, end, error: "eth_feeHistory returned no base fee values" });
      continue;
    }
    const distinct = [...new Set(values.map(String))].map(BigInt);
    for (const v of distinct) allValues.add(v);
    windows.push({
      offset,
      end,
      oldestBlock: toNumber(hist.oldestBlock),
      blocks: values.length,
      distinct: distinct.map(String),
      minWei: values.reduce((a, b) => (b < a ? b : a)).toString(),
      maxWei: values.reduce((a, b) => (b > a ? b : a)).toString(),
      // eth_feeHistory's `reward` is null on this node, so tips cannot come from here.
      rewardAvailable: Array.isArray(hist.reward),
    });
  }

  const distinctOverall = [...allValues].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const blocksObserved = windows.reduce((n, w) => n + (w.blocks || 0), 0);
  const latest = await rpc.call("eth_blockNumber").then(() => currentBaseFee(rpc));

  return {
    windows,
    blocksObserved,
    distinctCount: distinctOverall.length,
    distinctGwei: distinctOverall.map(formatGwei),
    minWei: distinctOverall.length ? distinctOverall[0].toString() : null,
    maxWei: distinctOverall.length ? distinctOverall[distinctOverall.length - 1].toString() : null,
    currentWei: latest,
    frozen: distinctOverall.length === 1,
    rewardAvailable: windows.some((w) => w.rewardAvailable),
  };
}

/** Base fee of the pending/head block, straight from the block header. */
export async function currentBaseFee(rpc) {
  const block = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  if (!block || !block.baseFeePerGas) return null;
  return toBigInt(block.baseFeePerGas, "baseFeePerGas").toString();
}

/** How full are blocks, i.e. is there any queue to bid against? */
export async function measureCapacity(rpc, { sampleBlocks = 64, step = 1 } = {}) {
  const head = await rpc.blockNumber();
  const ratios = [];
  let gasLimit = null;

  for (let i = 0; i < sampleBlocks; i++) {
    const n = head - i * step;
    if (n < 1) break;
    const block = await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
    if (!block) continue;
    const used = toBigInt(block.gasUsed, "gasUsed");
    const limit = toBigInt(block.gasLimit, "gasLimit");
    if (limit === 0n) continue;
    gasLimit = limit;
    ratios.push(Number(used) / Number(limit));
  }

  if (ratios.length === 0) {
    return { sampled: 0, gasLimitWei: null, mean: null, max: null, headroomX: null };
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const max = ratios.reduce((a, b) => (b > a ? b : a), 0);
  return {
    sampled: ratios.length,
    gasLimitWei: gasLimit.toString(),
    mean,
    max,
    // A block that is 0.1% full has 1000x headroom, so a fee bid buys nothing.
    headroomX: max > 0 ? Math.round(1 / max) : null,
  };
}

/**
 * Pull recent transactions with their receipts.
 *
 * Concurrency is bounded and failures are counted, not swallowed: a scan that
 * silently drops half its blocks reports statistics about a different sample
 * than the one it names.
 */
export async function sampleTransactions(rpc, { blocks = 300, concurrency = 16 } = {}) {
  const head = await rpc.blockNumber();
  const numbers = [];
  for (let i = 0; i < blocks; i++) {
    const n = head - i;
    if (n >= 1) numbers.push(n);
  }

  const failedBlocks = [];
  const blockData = [];
  let cursor = 0;

  async function worker() {
    while (cursor < numbers.length) {
      const n = numbers[cursor++];
      try {
        const b = await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]);
        if (b) blockData.push(b);
      } catch (err) {
        failedBlocks.push({ block: n, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, numbers.length) }, worker));

  const withTxs = blockData.filter((b) => (b.transactions || []).length > 0);
  const pending = [];
  for (const b of withTxs) {
    for (const tx of b.transactions) {
      pending.push({ blockNumber: toNumber(b.number), baseFeeWei: toBigInt(b.baseFeePerGas, "baseFeePerGas"), tx });
    }
  }

  const failedReceipts = [];
  const rows = [];
  let rc = 0;
  async function receiptWorker() {
    while (rc < pending.length) {
      const item = pending[rc++];
      let receipt;
      try {
        receipt = await rpc.call("eth_getTransactionReceipt", [item.tx.hash]);
      } catch (err) {
        failedReceipts.push({ hash: item.tx.hash, error: err.message });
        continue;
      }
      const row = buildPaymentRow(item, receipt);
      if (row) rows.push(row);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, receiptWorker));

  return {
    window: { from: head - blocks + 1, to: head, blocksRequested: blocks },
    blocksScanned: blockData.length,
    blocksWithTransactions: withTxs.length,
    transactionsFound: pending.length,
    rows,
    failedBlocks,
    failedReceipts,
  };
}

/** Turn (block, tx, receipt) into one comparable payment record. */
export function buildPaymentRow({ blockNumber, baseFeeWei, tx }, receipt) {
  if (!receipt || receipt.status !== "0x1") return null;
  const gasUsed = toBigInt(receipt.gasUsed, "gasUsed");
  const effectiveGasPrice = toBigInt(receipt.effectiveGasPrice ?? "0x0", "effectiveGasPrice");
  const gasLimit = tx.gasLimit ? toBigInt(tx.gasLimit, "gasLimit") : tx.gas ? toBigInt(tx.gas, "gas") : null;
  const maxFee = tx.maxFeePerGas ? toBigInt(tx.maxFeePerGas, "maxFeePerGas") : null;
  const declaredTip = tx.maxPriorityFeePerGas ? toBigInt(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas") : null;

  return {
    hash: tx.hash,
    blockNumber,
    type: tx.type ?? null,
    baseFeeWei,
    gasUsed,
    gasLimit,
    effectiveGasPrice,
    maxFee,
    declaredTip,
    // What was actually paid on top of the base fee.
    paidTip: effectiveGasPrice - baseFeeWei,
    paidWei: effectiveGasPrice * gasUsed,
    // Balance the wallet must reserve: maxFee × gasLimit (or the legacy price).
    lockedWei: (maxFee ?? effectiveGasPrice) * (gasLimit ?? gasUsed),
  };
}

/**
 * Summarise what a sample of transactions actually paid.
 *
 * Two separate wastes, because they cost different things:
 *  - a tip is money spent and gone;
 *  - an inflated maxFee only locks balance, but on a frozen base fee that lock
 *    is pure opportunity cost.
 */
export function analysePayments(rows, { baseFeeWei } = {}) {
  if (!rows || rows.length === 0) {
    return { transactions: 0, measured: false };
  }

  const base = baseFeeWei != null ? toBigInt(baseFeeWei, "baseFeeWei") : null;
  let paidTotal = 0n;
  let tipTotal = 0n;
  let lockedTotal = 0n;
  let lockExtra = 0n;
  let zeroTip = 0;
  const positiveTips = [];
  const overbidders = [];

  for (const row of rows) {
    paidTotal += row.paidWei;
    if (row.paidTip > 0n) {
      tipTotal += row.paidTip * row.gasUsed;
      positiveTips.push(row.paidTip);
    } else {
      zeroTip++;
    }
    lockedTotal += row.lockedWei;
    if (base != null) {
      const reference = (base) * (row.gasLimit ?? row.gasUsed);
      if (row.lockedWei > reference) {
        lockExtra += row.lockedWei - reference;
        overbidders.push(row);
      }
    }
  }

  positiveTips.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    measured: true,
    transactions: rows.length,
    blocks: new Set(rows.map((r) => r.blockNumber)).size,
    paidTotalWei: paidTotal.toString(),
    tipTotalWei: tipTotal.toString(),
    tipShareOfFees: percent(tipTotal, paidTotal),
    zeroTipCount: zeroTip,
    zeroTipShare: percent(BigInt(zeroTip), BigInt(rows.length)),
    positiveTipCount: positiveTips.length,
    medianPositiveTipWei: positiveTips.length
      ? positiveTips[Math.floor(positiveTips.length / 2)].toString()
      : null,
    maxTipWei: positiveTips.length ? positiveTips[positiveTips.length - 1].toString() : null,
    lockedTotalWei: lockedTotal.toString(),
    lockExtraWei: lockExtra.toString(),
    overbidders: overbidders.length,
    overbidShare: percent(BigInt(overbidders.length), BigInt(rows.length)),
    medianGasLimitOverGasUsed: medianRatio(rows),
  };
}

function medianRatio(rows) {
  const ratios = rows
    .filter((r) => r.gasLimit != null && r.gasUsed > 0n && r.gasLimit > 0n)
    .map((r) => Number(r.gasLimit) / Number(r.gasUsed))
    .sort((a, b) => a - b);
  if (ratios.length === 0) return null;
  return Number(ratios[Math.floor(ratios.length / 2)].toFixed(2));
}

/**
 * Can waiting for a cheaper window ever pay off?
 *
 * Answerable only from measurement. If the base fee never changed across every
 * window we looked at, and tip-free transactions are being included, then
 * "hold until the price drops" describes an event that does not happen — and a
 * scheduler built on it would simply delay every transaction forever.
 */
export function waitingVerdict({ baseFee, analyse }) {
  const reasons = [];
  if (!baseFee || baseFee.distinctCount == null) {
    return { canHelp: null, reasons: ["base fee history is unavailable, so no claim is made"] };
  }
  if (baseFee.distinctCount > 1) {
    reasons.push(`base fee took ${baseFee.distinctCount} distinct values (${baseFee.distinctGwei.join(", ")} gwei)`);
    return { canHelp: true, reasons };
  }
  reasons.push(`base fee held ${baseFee.distinctGwei[0]} gwei across ${baseFee.blocksObserved} blocks in ${baseFee.windows.length} windows`);

  if (analyse && analyse.measured) {
    const share = Number(analyse.zeroTipShare);
    if (share === 0) {
      reasons.push("every sampled transaction paid a tip, so inclusion without one is unproven");
      return { canHelp: null, reasons };
    }
    reasons.push(`${analyse.zeroTipShare}% of ${analyse.transactions} sampled transactions were included paying base fee only`);
  }
  return { canHelp: false, reasons };
}
