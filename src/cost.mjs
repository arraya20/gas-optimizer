// Cost model and the minimal-safe-fee advisor.
//
// Two different losses get conflated in most fee UIs, and they are not the same
// thing:
//
//   1. spent   — gasUsed × effectiveGasPrice. Gone. A tip is spent.
//   2. locked  — maxFee × gasLimit. Reserved while the transaction is pending,
//                refunded after. On a chain whose base fee does not move, a
//                maxFee above the base fee locks balance for no benefit at all.
//
// Under EIP-1559 you are charged min(maxFee, base + tip) per unit of gas used,
// so an inflated maxFee is not overspending — it is over-reserving. Reporting it
// as overspending would be wrong, and reporting it as free would also be wrong.

import { toBigInt, formatPROS, formatGwei, percent, InputError } from "./numbers.mjs";

/** The smallest maxFee a node will accept, and the tip it implies. */
export function minimalFees({ baseFeeWei, bufferWei = 0n, tipWei = 0n }) {
  const base = toBigInt(baseFeeWei, "baseFeeWei");
  const buffer = toBigInt(bufferWei, "bufferWei");
  const tip = toBigInt(tipWei, "tipWei");
  if (base <= 0n) throw new InputError("baseFeeWei must be positive", "baseFeeWei");
  if (buffer < 0n) throw new InputError("bufferWei cannot be negative", "bufferWei");
  if (tip < 0n) throw new InputError("tipWei cannot be negative", "tipWei");
  return {
    maxFeeWei: base + buffer + tip,
    tipWei: tip,
    baseFeeWei: base,
    bufferWei: buffer,
  };
}

/**
 * What a given fee setting actually costs, versus what it holds back.
 *
 * @param {object} p
 * @param {bigint|string} p.gasLimit      units the transaction may use
 * @param {bigint|string} [p.gasUsed]     measured units; defaults to gasLimit
 * @param {bigint|string} p.baseFeeWei
 * @param {bigint|string} p.maxFeeWei
 * @param {bigint|string} [p.tipWei]
 */
export function projectCost({ gasLimit, gasUsed, baseFeeWei, maxFeeWei, tipWei = 0n }) {
  const limit = toBigInt(gasLimit, "gasLimit");
  const used = gasUsed == null ? limit : toBigInt(gasUsed, "gasUsed");
  const base = toBigInt(baseFeeWei, "baseFeeWei");
  const maxFee = toBigInt(maxFeeWei, "maxFeeWei");
  const tip = toBigInt(tipWei, "tipWei");

  if (limit <= 0n) throw new InputError("gasLimit must be positive", "gasLimit");
  if (used > limit) throw new InputError("gasUsed cannot exceed gasLimit", "gasUsed");
  if (maxFee < base) {
    throw new InputError(
      `maxFeePerGas ${formatGwei(maxFee)} gwei is below the base fee ${formatGwei(base)} gwei: the node rejects this transaction`,
      "maxFeeWei",
    );
  }

  // min(maxFee, base + tip) — the cap binds when the tip would push past it.
  const bid = base + tip;
  const effectiveGasPrice = bid > maxFee ? maxFee : bid;
  const paidWei = effectiveGasPrice * used;

  return {
    gasLimit: limit,
    gasUsed: used,
    effectiveGasPriceWei: effectiveGasPrice,
    paidWei,
    // Charged if the transaction uses every unit it asked for.
    worstCasePaidWei: effectiveGasPrice * limit,
    lockedWei: maxFee * limit,
    // Refunded, but unavailable while pending.
    refundableWei: maxFee * limit - paidWei,
  };
}

/**
 * Compare a declared fee setting against the measured minimum.
 *
 * `tipPolicy` is passed in rather than assumed: recommending a zero tip is only
 * defensible when the sample shows zero-tip transactions being included.
 */
export function advise({
  gasLimit,
  gasUsed,
  baseFeeWei,
  declaredMaxFeeWei = null,
  declaredTipWei = null,
  slotPolicy = "zero-tip-proven",
}) {
  if (baseFeeWei == null) {
    return {
      verdict: "UNMEASURABLE",
      reasons: ["the base fee could not be read, so no fee advice is given"],
      recommended: null,
    };
  }

  const base = toBigInt(baseFeeWei, "baseFeeWei");
  const tip = slotPolicy === "zero-tip-proven" ? 0n : toBigInt(declaredTipWei ?? 0n, "declaredTipWei");
  const min = minimalFees({ baseFeeWei: base, tipWei: tip });

  const recommended = projectCost({
    gasLimit,
    gasUsed,
    baseFeeWei: base,
    maxFeeWei: min.maxFeeWei,
    tipWei: tip,
  });

  const reasons = [];
  let spentSaving = 0n;
  let lockSaving = 0n;

  if (declaredMaxFeeWei == null) {
    reasons.push(`no fee setting was supplied; the minimum is ${formatGwei(min.maxFeeWei)} gwei`);
    return {
      verdict: "NO_DECLARED_FEE",
      reasons,
      recommended,
      spentSavingWei: "0",
      lockSavingWei: "0",
    };
  }

  const declared = projectCost({
    gasLimit,
    gasUsed,
    baseFeeWei: base,
    maxFeeWei: toBigInt(declaredMaxFeeWei, "declaredMaxFeeWei"),
    tipWei: toBigInt(declaredTipWei ?? 0n, "declaredTipWei"),
  });

  spentSaving = declared.paidWei > recommended.paidWei ? declared.paidWei - recommended.paidWei : 0n;
  lockSaving = declared.lockedWei > recommended.lockedWei ? declared.lockedWei - recommended.lockedWei : 0n;

  const tipOverpay = declared.effectiveGasPriceWei > base;
  const overLocked = declared.lockedWei > recommended.lockedWei;

  let verdict;
  if (tipOverpay && overLocked) verdict = "OVERPAYING";
  else if (tipOverpay) verdict = "TIP_ABOVE_BASE";
  else if (overLocked) verdict = "OVER_LOCKED";
  else verdict = "ALREADY_MINIMAL";

  if (tipOverpay) {
    reasons.push(
      `effective price ${formatGwei(declared.effectiveGasPriceWei)} gwei is ${formatGwei(
        declared.effectiveGasPriceWei - base,
      )} gwei above the base fee, so that much is spent for nothing`,
    );
  }
  if (overLocked) {
    reasons.push(
      `maxFee ${formatGwei(toBigInt(declaredMaxFeeWei, "declaredMaxFeeWei"))} gwei × gasLimit ${declared.gasLimit} locks ${formatPROS(
        declared.lockedWei,
      )} PROS where ${formatPROS(recommended.lockedWei)} PROS is enough`,
    );
  }
  if (verdict === "ALREADY_MINIMAL") {
    reasons.push("the declared setting is already at the measured minimum");
  }

  return {
    verdict,
    reasons,
    recommended,
    declared,
    spentSavingWei: spentSaving.toString(),
    lockSavingWei: lockSaving.toString(),
    // Share of the current fee that is spent above base.
    spentOverBaseWei: (declared.effectiveGasPriceWei > base
      ? (declared.effectiveGasPriceWei - base) * declared.gasUsed
      : 0n
    ).toString(),
    tipShareOfDeclared: percent(
      declared.effectiveGasPriceWei > base ? (declared.effectiveGasPriceWei - base) * declared.gasUsed : 0n,
      declared.paidWei,
    ),
  };
}
