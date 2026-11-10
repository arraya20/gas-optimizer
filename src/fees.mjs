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
export async function measureBaseFee(
  rpc,
  { offsets = [0, 200_000, 1_000_000, 5_000_000], windowSize = 1024, head: givenHead } = {},
) {
  const head = givenHead ?? (await rpc.blockNumber());
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
  const latest = await currentBaseFee(rpc);

  // "The fee never moves" is a claim about the whole chain, so it can only be
  // made from windows that actually answered. Before this, one surviving window
  // out of four was enough to declare the market frozen, which turned a
  // throttled node into a market conclusion.
  const windowsFailed = windows.filter((w) => w.error).length;
  const windowsSucceeded = windows.length - windowsFailed;
  const coverageComplete = windows.length > 0 && windowsFailed === 0;

  return {
    windows,
    blocksObserved,
    distinctCount: distinctOverall.length,
    distinctGwei: distinctOverall.map(formatGwei),
    minWei: distinctOverall.length ? distinctOverall[0].toString() : null,
    maxWei: distinctOverall.length ? distinctOverall[distinctOverall.length - 1].toString() : null,
    currentWei: latest,
    windowsAttempted: windows.length,
    windowsSucceeded,
    windowsFailed,
    coverageComplete,
    // true = measured flat everywhere, false = measured to move, null = not enough
    // windows answered to say either way.
    frozen: distinctOverall.length === 0 ? null : coverageComplete ? distinctOverall.length === 1 : null,
    rewardAvailable: windows.some((w) => w.rewardAvailable),
  };
}

/** Base fee of the pending/head block, straight from the block header. */
export async function currentBaseFee(rpc) {
  const block = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  if (!block || !block.baseFeePerGas) return null;
  return toBigInt(block.baseFeePerGas, "baseFeePerGas").toString();
}

/**
 * Gas capacity, computed from block headers we already fetched.
 *
 * Two design notes, both from watching this number misbehave.
 *
 * 1. It is a pure function of the blocks. Previously capacity fetched its own 32
 *    consecutive blocks while the transaction sample fetched a different window,
 *    so one report described two different sets of blocks. Anything that says
 *    "blocks are mostly empty" and "21% of fees went above base" should be
 *    talking about the same blocks.
 *
 * 2. Headroom is banded to a power of ten, because the leading digits are noise.
 *    Six renders of this chain produced 2,071x, 2,629x, 4,065x, 4,284x, 4,921x,
 *    6,141x and once 359x — a 17x spread on a figure quoted to four digits. The
 *    band says "at least 10,000x" and stays put; the ratio said "13,599x" and
 *    was wrong by a factor of two in either direction.
 */
export function capacityFromBlocks(blocks, { failed = 0 } = {}) {
  const rows = blocks.filter((b) => b && b.gasLimit > 0n);
  if (rows.length === 0) {
    return {
      blocksSampled: 0,
      failedBlocks: failed,
      spanBlocks: 0,
      emptyCount: 0,
      emptyShare: null,
      aggregateUtilisation: null,
      peakUtilisation: null,
      peakBlock: null,
      headroomAtLeastX: null,
      congestion: "unknown",
    };
  }

  let sumUsed = 0n;
  let sumLimit = 0n;
  let emptyCount = 0;
  let peak = 0;
  let peakBlock = null;
  let peakUsed = 0n;
  let peakLimit = 0n;
  let minBlock = Infinity;
  let maxBlock = -Infinity;

  for (const b of rows) {
    sumUsed += b.gasUsed;
    sumLimit += b.gasLimit;
    if (b.gasUsed === 0n) emptyCount++;
    const u = Number(b.gasUsed) / Number(b.gasLimit);
    if (u > peak) {
      peak = u;
      peakBlock = b.number;
      peakUsed = b.gasUsed;
      peakLimit = b.gasLimit;
    }
    if (b.number < minBlock) minBlock = b.number;
    if (b.number > maxBlock) maxBlock = b.number;
  }

  // Aggregate, not mean-of-ratios: a block with a large gas limit should carry
  // more weight than a small one, and this is exactly total demand over total
  // capacity. It is also far steadier than a peak, which rests on one block.
  const aggregate = sumLimit > 0n ? Number(sumUsed) / Number(sumLimit) : null;

  return {
    blocksSampled: rows.length,
    failedBlocks: failed,
    spanBlocks: maxBlock >= minBlock ? maxBlock - minBlock + 1 : 0,
    emptyCount,
    emptyShare: emptyCount / rows.length,
    // Raw totals kept alongside the float: percentages derived from these are
    // exact, instead of a float that was rounded and then parsed back.
    gasUsedTotal: sumUsed.toString(),
    gasLimitTotal: sumLimit.toString(),
    aggregateUtilisation: aggregate,
    peakUtilisation: peak,
    peakBlock,
    peakGasUsed: peakBlock == null ? null : peakUsed.toString(),
    peakGasLimit: peakBlock == null ? null : peakLimit.toString(),
    headroomAtLeastX: headroomBand(aggregate),
    congestion: congestionLevel(aggregate),
  };
}

/**
 * Largest power of ten that fits inside 1/utilisation, or null when the claim
 * would be weaker than an order of magnitude.
 *
 * Zero utilisation is not "infinite headroom" as a number to print — it means no
 * gas was used in any sampled block, which is a different sentence and the
 * report says that instead of inventing a figure.
 */
export function headroomBand(utilisation) {
  if (utilisation == null || !(utilisation > 0)) return null;
  const headroom = 1 / utilisation;
  if (!Number.isFinite(headroom) || headroom < 10) return null;
  return 10 ** Math.floor(Math.log10(headroom));
}

/**
 * Qualitative queue state. Thresholds are wide on purpose: the decision they
 * support ("does a higher bid buy inclusion?") is not sensitive to the
 * difference between 0.004% and 0.008%.
 */
export function congestionLevel(utilisation) {
  if (utilisation == null) return "unknown";
  if (utilisation >= 0.5) return "contended";
  if (utilisation >= 0.1) return "light";
  return "no-queue";
}

/** Gas capacity over a fresh window of headers. Used by the CLI standalone path. */
export async function measureCapacity(rpc, { sampleBlocks = 192, stride = 800 } = {}) {
  const head = await rpc.blockNumber();
  const blocks = [];
  let failed = 0;

  for (let i = 0; i < sampleBlocks; i++) {
    const n = head - i * stride;
    if (n < 1) break;
    try {
      const b = await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
      if (b) {
        blocks.push({
          number: toNumber(b.number),
          gasUsed: toBigInt(b.gasUsed, "gasUsed"),
          gasLimit: toBigInt(b.gasLimit, "gasLimit"),
        });
      }
    } catch {
      failed++;
    }
  }

  return capacityFromBlocks(blocks, { failed });
}

/**
 * Pull transactions with their receipts from a strided window of blocks.
 *
 * Strided, not contiguous: this chain produces a transaction every few hundred
 * blocks, so 250 consecutive blocks is mostly one short burst of activity. A
 * stride spreads the same number of reads over a much wider span, which is
 * better evidence for "how do senders behave" and costs the same.
 *
 * Concurrency is bounded and failures are counted, not swallowed: a scan that
 * silently drops half its blocks reports statistics about a different sample
 * than the one it names.
 */
export async function sampleTransactions(
  rpc,
  { blocks = 250, stride = 800, concurrency = 16, head: givenHead, maxReceipts = Infinity } = {},
) {
  const head = givenHead ?? (await rpc.blockNumber());
  const numbers = [];
  for (let i = 0; i < blocks; i++) {
    const n = head - i * stride;
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

  const receiptsToFetch = Number.isFinite(maxReceipts) ? pending.slice(0, Math.max(0, maxReceipts)) : pending;
  const failedReceipts = [];
  const rows = [];
  let rc = 0;
  async function receiptWorker() {
    while (rc < receiptsToFetch.length) {
      const item = receiptsToFetch[rc++];
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
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, receiptsToFetch.length)) }, receiptWorker));

  return {
    window: {
      to: head,
      from: head - (blocks - 1) * stride,
      blocksRequested: blocks,
      stride,
      spanBlocks: (blocks - 1) * stride + 1,
    },
    blocksScanned: blockData.length,
    blocksWithTransactions: withTxs.length,
    transactionsFound: pending.length,
    rows,
    // Headers already in hand: capacity is computed from these rather than from
    // a second fetch of a different window.
    blockSummaries: blockData.map((b) => ({
      number: toNumber(b.number),
      gasUsed: toBigInt(b.gasUsed, "gasUsed"),
      gasLimit: toBigInt(b.gasLimit, "gasLimit"),
    })),
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
export function waitingVerdict({ baseFee, analyse, capacity }) {
  const reasons = [];
  if (!baseFee || baseFee.distinctCount == null) {
    return { canHelp: null, reasons: ["base fee history is unavailable, so no claim is made"] };
  }
  // Zero distinct values means every window failed — there is no history to
  // quote, and distinctGwei[0] would have rendered as "undefined gwei".
  if (baseFee.distinctCount === 0) {
    return {
      canHelp: null,
      reasons: [
        `none of the ${baseFee.windowsAttempted ?? baseFee.windows.length} fee-history windows returned data, so nothing can be said about waiting`,
      ],
    };
  }
  if (baseFee.distinctCount > 1) {
    reasons.push(`base fee took ${baseFee.distinctCount} distinct values (${baseFee.distinctGwei.join(", ")} gwei)`);
    return { canHelp: true, reasons };
  }
  reasons.push(`base fee held ${baseFee.distinctGwei[0]} gwei across ${baseFee.blocksObserved} blocks in ${baseFee.windows.length} windows`);

  // A single surviving window cannot distinguish a frozen market from a run of
  // failed queries. "Waiting ends" is a strong claim; it needs full coverage.
  if (baseFee.coverageComplete === false) {
    reasons.push(
      `only ${baseFee.windowsSucceeded ?? baseFee.windows.length} of ${baseFee.windowsAttempted ?? baseFee.windows.length} requested windows answered, so "the fee never moves" is unproven`,
    );
    return { canHelp: null, reasons };
  }

  // Demand side. A flat price only means "waiting cannot help" if there is also
  // nothing to bid against; a flat price with full blocks would still make
  // inclusion timing matter.
  if (capacity && capacity.blocksSampled > 0 && capacity.gasLimitTotal) {
    const pctText = percent(BigInt(capacity.gasUsedTotal), BigInt(capacity.gasLimitTotal), 4);
    reasons.push(
      `aggregate gas demand was ${pctText}% of capacity across ${capacity.blocksSampled} blocks` +
        (capacity.emptyCount > 0
          ? `, with ${capacity.emptyCount} of them using no gas at all`
          : ""),
    );
  }

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
