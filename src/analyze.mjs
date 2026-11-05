// The analysis pipeline: request in, measurements out.
//
// The contract with the caller is deliberately narrow. You may describe your
// transaction — gas limit, measured gas, the fee you were about to set. You may
// not describe the market. Any field that looks like a fee the caller decided
// (baseFee, gasPrice, currentGasGwei, recommendation, verdict…) is rejected,
// because the inherited scaffold accepted those and would dutifully "optimise"
// whatever number you handed it.

import { toBigInt, formatGwei, formatPROS, percent, parseUnits, InputError } from "./numbers.mjs";
import { measureBaseFee, capacityFromBlocks, sampleTransactions, analysePayments, waitingVerdict, currentBaseFee } from "./fees.mjs";
import { advise } from "./cost.mjs";

/** Fields a caller is not allowed to supply, with the reason in the error. */
const FORBIDDEN = {
  basefee: "the base fee is read from the chain",
  basefeewei: "the base fee is read from the chain",
  basefeepergas: "the base fee is read from the chain",
  gasprice: "the gas price is read from the chain",
  gaspricegwei: "the gas price is read from the chain",
  currentgas: "the gas price is read from the chain",
  currentgasgwei: "the gas price is read from the chain",
  effectivegasprice: "the effective price is read from receipts",
  verdict: "a verdict is a measurement, not an input",
  recommendation: "a recommendation is a measurement, not an input",
  shouldexecute: "a decision is an output, not an input",
  decision: "a decision is an output, not an input",
  optimizedgas: "the optimised figure is an output, not an input",
  savings: "savings are computed, not supplied",
};

/**
 * @param {unknown} body
 * @returns {{gasLimit: bigint, gasUsed: bigint|null, maxFeeWei: bigint|null, tipWei: bigint|null}}
 */
export function validateRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new InputError("request body must be a JSON object", "body");
  }

  for (const [key, value] of Object.entries(body)) {
    const norm = key.toLowerCase().replace(/[^a-z]/g, "");
    if (norm in FORBIDDEN) {
      throw new InputError(`${key} may not be supplied: ${FORBIDDEN[norm]}`, key);
    }
    if (value === null || value === undefined) continue;
  }

  if (body.gasLimit === undefined || body.gasLimit === null || body.gasLimit === "") {
    throw new InputError("gasLimit is required", "gasLimit");
  }

  const gasLimit = toBigInt(body.gasLimit, "gasLimit");
  if (gasLimit <= 0n) throw new InputError("gasLimit must be positive", "gasLimit");
  if (gasLimit > 30_000_000n) {
    throw new InputError(`gasLimit ${gasLimit} exceeds any plausible block limit; refusing`, "gasLimit");
  }

  let gasUsed = null;
  if (body.gasUsed !== undefined && body.gasUsed !== null && body.gasUsed !== "") {
    gasUsed = toBigInt(body.gasUsed, "gasUsed");
    if (gasUsed <= 0n) throw new InputError("gasUsed must be positive", "gasUsed");
    if (gasUsed > gasLimit) throw new InputError("gasUsed cannot exceed gasLimit", "gasUsed");
  }

  const maxFeeWei = optionalWei(body, ["maxFeeGwei", "maxFeeWei"]);
  const tipWei = optionalWei(body, ["tipGwei", "maxPriorityFeeGwei", "tipWei"]);

  return { gasLimit, gasUsed, maxFeeWei, tipWei };
}

/**
 * Read a fee field given either in gwei or in wei.
 *
 * The gwei form accepts decimals: 11.25 gwei is a value this chain really uses,
 * and toBigInt would have rejected it as "not an integer".
 */
function optionalWei(body, keys) {
  for (const key of keys) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = key.endsWith("Wei") ? toBigInt(raw, key) : parseUnits(raw, 9);
    if (n < 0n) throw new InputError(`${key} cannot be negative`, key);
    return { wei: n, gwei: !key.endsWith("Wei") };
  }
  return null;
}

const unwrap = (v) => (v && typeof v === "object" && "wei" in v ? v.wei : v);

/**
 * Run the full analysis.
 *
 * @param {object} p
 * @param {ReturnType<import("./rpc.mjs").createRpc>} p.rpc
 * @param {object} p.request  already validated
 * @param {number} [p.sampleBlocks]
 */
export async function analyze({ rpc, request, sampleBlocks = 250, stride = 800 }) {
  const chainId = await rpc.chainId();
  const head = await rpc.blockNumber();

  const [baseFee, sample] = await Promise.all([
    measureBaseFee(rpc, { windowSize: 512 }),
    sampleTransactions(rpc, { blocks: sampleBlocks, stride, concurrency: 16 }),
  ]);

  // Capacity comes from the same blocks the payment sample used. One report, one
  // window — otherwise "blocks are empty" and "21% of fees went above base" would
  // be describing two different stretches of chain.
  const capacity = capacityFromBlocks(sample.blockSummaries, {
    failed: sample.failedBlocks.length,
  });

  const analyse = analysePayments(sample.rows, { baseFeeWei: baseFee.currentWei });
  const waiting = waitingVerdict({ baseFee, analyse, capacity });

  // A zero tip is only recommended when the sample proves it gets included.
  const zeroTipProven = analyse.measured && Number(analyse.zeroTipShare) > 0;
  const slotPolicy = zeroTipProven ? "zero-tip-proven" : "match-declared";

  const maxFeeWei = unwrap(request.maxFeeWei);
  const tipWei = unwrap(request.tipWei);

  const advice = advise({
    gasLimit: request.gasLimit,
    gasUsed: request.gasUsed ?? request.gasLimit,
    baseFeeWei: baseFee.currentWei,
    declaredMaxFeeWei: maxFeeWei,
    declaredTipWei: tipWei,
    slotPolicy,
  });

  return {
    chain: { id: chainId, head, name: chainId === 1672 ? "Pharos Pacific" : `chain ${chainId}` },
    market: {
      baseFeeWei: baseFee.currentWei,
      baseFeeGwei: baseFee.currentWei ? formatGwei(baseFee.currentWei) : null,
      frozen: baseFee.frozen,
      distinctCount: baseFee.distinctCount,
      distinctGwei: baseFee.distinctGwei,
      blocksObserved: baseFee.blocksObserved,
      // How much of the requested history actually answered. `frozen: null`
      // means "not enough windows", which is different from "it moved".
      windowsAttempted: baseFee.windowsAttempted,
      windowsSucceeded: baseFee.windowsSucceeded,
      windowsFailed: baseFee.windowsFailed,
      coverageComplete: baseFee.coverageComplete,
      windows: baseFee.windows.map((w) => ({
        end: w.end,
        blocks: w.blocks ?? 0,
        distinct: w.distinct ? w.distinct.map(formatGwei) : [],
        error: w.error ?? null,
      })),
      capacity: {
        blocksSampled: capacity.blocksSampled,
        failedBlocks: capacity.failedBlocks,
        spanBlocks: capacity.spanBlocks,
        emptyCount: capacity.emptyCount,
        emptyShare: capacity.emptyShare,
        aggregateUtilisation: capacity.aggregateUtilisation,
        peakUtilisation: capacity.peakUtilisation,
        peakBlock: capacity.peakBlock,
        peakUtilisationPct:
          capacity.peakGasLimit && BigInt(capacity.peakGasLimit) > 0n
            ? percent(BigInt(capacity.peakGasUsed), BigInt(capacity.peakGasLimit), 3)
            : null,
        gasUsedTotal: capacity.gasUsedTotal,
        gasLimitTotal: capacity.gasLimitTotal,
        // Formatted once, from exact integers. The text report and the dashboard
        // both print this string; before, each computed its own percentage and
        // they disagreed in the fourth decimal of the same figure.
        aggregateUtilisationPct:
          capacity.gasLimitTotal && BigInt(capacity.gasLimitTotal) > 0n
            ? percent(BigInt(capacity.gasUsedTotal), BigInt(capacity.gasLimitTotal), 4)
            : null,
        headroomAtLeastX: capacity.headroomAtLeastX,
        congestion: capacity.congestion,
      },
    },
    sample: {
      window: sample.window,
      blocksScanned: sample.blocksScanned,
      blocksWithTransactions: sample.blocksWithTransactions,
      transactions: analyse.measured ? analyse.transactions : 0,
      zeroTipShare: analyse.measured ? analyse.zeroTipShare : null,
      zeroTipCount: analyse.measured ? analyse.zeroTipCount : null,
      medianPositiveTipWei: analyse.measured ? analyse.medianPositiveTipWei : null,
      medianPositiveTipGwei:
        analyse.measured && analyse.medianPositiveTipWei ? formatGwei(analyse.medianPositiveTipWei) : null,
      maxTipGwei: analyse.measured && analyse.maxTipWei ? formatGwei(analyse.maxTipWei) : null,
      paidTotalWei: analyse.measured ? analyse.paidTotalWei : null,
      tipTotalWei: analyse.measured ? analyse.tipTotalWei : null,
      tipShareOfFees: analyse.measured ? analyse.tipShareOfFees : null,
      lockExtraWei: analyse.measured ? analyse.lockExtraWei : null,
      medianGasLimitOverGasUsed: analyse.measured ? analyse.medianGasLimitOverGasUsed : null,
      failedBlocks: sample.failedBlocks.length,
      failedReceipts: sample.failedReceipts.length,
    },
    waiting,
    advice: {
      ...advice,
      recommended: advice.recommended
        ? {
            maxFeeWei: advice.recommended.effectiveGasPriceWei.toString(),
            maxFeeGwei: formatGwei(advice.recommended.effectiveGasPriceWei),
            paidWei: advice.recommended.paidWei.toString(),
            paidPROS: formatPROS(advice.recommended.paidWei),
            lockedWei: advice.recommended.lockedWei.toString(),
            lockedPROS: formatPROS(advice.recommended.lockedWei),
          }
        : null,
      declared: advice.declared
        ? {
            effectiveGasPriceWei: advice.declared.effectiveGasPriceWei.toString(),
            effectiveGasPriceGwei: formatGwei(advice.declared.effectiveGasPriceWei),
            paidWei: advice.declared.paidWei.toString(),
            paidPROS: formatPROS(advice.declared.paidWei),
            lockedWei: advice.declared.lockedWei.toString(),
            lockedPROS: formatPROS(advice.declared.lockedWei),
          }
        : null,
      spentSavingPROS: formatPROS(advice.spentSavingWei ?? "0"),
      lockSavingPROS: formatPROS(advice.lockSavingWei ?? "0"),
    },
    notMeasured: buildNotMeasured({ baseFee, analyse, waiting, sample }),
  };
}

/** This list is never empty, and never shrinks because the numbers looked good. */
function buildNotMeasured({ baseFee, analyse, waiting, sample }) {
  const items = [];

  items.push(
    "whether a zero-tip transaction from *your* address will be included: the sample shows base-fee-only transactions in recent blocks, which is evidence, not a guarantee for a specific sender",
  );
  items.push(
    "mempool contents and queue position: this node exposes no pending-transaction view, so competition for the next block cannot be observed",
  );
  items.push(
    "future base fee: the recommendation assumes the measured history continues, and a protocol fee-parameter change would invalidate it",
  );

  if (!baseFee.rewardAvailable) {
    items.push(
      "per-block priority-fee statistics from eth_feeHistory: this node returns reward=null, so tips are reconstructed from receipts instead",
    );
  }
  if (sample.failedBlocks.length || sample.failedReceipts.length) {
    items.push(
      `complete coverage of the sample: ${sample.failedBlocks.length} block(s) and ${sample.failedReceipts.length} receipt(s) failed to load and are excluded from the statistics`,
    );
  }
  if (!analyse.measured) {
    items.push("payment behaviour of recent transactions: no successful receipt was available in the sampled window");
  }
  if (baseFee.windowsFailed > 0) {
    items.push(
      `base-fee history for ${baseFee.windowsFailed} of ${baseFee.windowsAttempted} windows: those queries failed, so the price is described only by the ${baseFee.windowsSucceeded} window(s) that answered`,
    );
  }
  if (waiting.canHelp === null) {
    items.push("whether waiting could ever lower the fee: the measurement was inconclusive");
  }
  items.push(
    "gas units your transaction will actually use: this tool takes your gas limit as given and does not simulate execution",
  );
  return items;
}

export { percent };
