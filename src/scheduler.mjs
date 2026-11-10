// Deadline scheduler: hold a signed transaction until gas is favorable, and
// broadcast it no later than its deadline.
//
// The guarantee, stated exactly. The deadline guarantee is about *broadcast*:
// at `deadlineAt - deadlineMarginMs` the job stops waiting and sends, whatever
// the price. Inclusion is up to the chain. If the node is unreachable for the
// whole retry budget the job ends FAILED and says so; it never claims a
// submission that did not happen, and it marks a send that landed after the
// deadline as `late` instead of hiding it.
//
// "Favorable" is a rule the caller can read: the current base fee is at or
// below `targetBaseFeeWei` (default: the base fee when the job was created).
// The agent does not forecast price. On a chain whose base fee never moves,
// the rule is met at the first check and the job submits immediately, which is
// the correct outcome and is reported as such.
//
// Everything here is a function of (job, rpc, now). No timers, no storage:
// the Durable Object supplies the alarm and the storage, tests supply a clock.

import { toBigInt, formatGwei, formatPROS, parseUnits, InputError } from "./numbers.mjs";
import { decodeRawTx, pricePerGas } from "./rawtx.mjs";
import { currentBaseFee } from "./fees.mjs";
import { RpcError } from "./rpc.mjs";

export const DEFAULTS = {
  pollMs: 30_000, // how often a holding job re-reads the base fee
  deadlineMarginMs: 20_000, // stop waiting this long before the deadline, to leave room for retries
  minLeadMs: 30_000, // a deadline closer than this cannot be honoured honestly
  maxLeadMs: 7 * 24 * 3600_000,
  retryMs: 4_000,
  maxSendAttempts: 8,
  receiptPollMs: 5_000,
  receiptTimeoutMs: 10 * 60_000,
};

export const TERMINAL = new Set(["SETTLED", "REVERTED", "UNCONFIRMED", "SIMULATED", "FAILED", "CANCELLED"]);
export const isTerminal = (job) => TERMINAL.has(job.status);

/** Fields a caller must not supply: market observations and conclusions are produced here. */
const FORBIDDEN = [
  "baseFee", "baseFeeGwei", "baseFeeWei", "gasPrice", "currentGasGwei", "quotedPrice", "quote",
  "status", "verdict", "recommendation", "decision", "savings", "actualPaid", "settlement",
];

/** Pure validation of the request body. `now` is needed only for relative deadlines. */
export function validateJobRequest(body, now, config = DEFAULTS) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InputError("body must be a JSON object", "body");
  }
  for (const f of FORBIDDEN) {
    if (f in body) {
      throw new InputError(
        `${f} is not accepted: it is a market observation or a conclusion this service produces itself`,
        f,
      );
    }
  }
  if (typeof body.rawTx !== "string" || body.rawTx.trim() === "") {
    throw new InputError("rawTx is required: a signed transaction as 0x… hex", "rawTx");
  }
  if ("privateKey" in body || "mnemonic" in body || "seed" in body) {
    throw new InputError("never send a key: sign elsewhere and send only the signed transaction", "privateKey");
  }

  const forms = ["deadlineAt", "deadlineMinutes", "deadlineSeconds"].filter((k) => body[k] != null);
  if (forms.length !== 1) {
    throw new InputError("give exactly one of deadlineAt, deadlineMinutes, deadlineSeconds", "deadline");
  }
  let deadlineAt;
  if (body.deadlineAt != null) {
    deadlineAt = typeof body.deadlineAt === "number" ? body.deadlineAt : Date.parse(String(body.deadlineAt));
    if (!Number.isFinite(deadlineAt)) throw new InputError("deadlineAt is not a timestamp (ISO 8601 or epoch ms)", "deadlineAt");
  } else {
    const unit = body.deadlineMinutes != null ? 60_000 : 1000;
    const n = Number(body.deadlineMinutes ?? body.deadlineSeconds);
    if (!Number.isFinite(n) || n <= 0) throw new InputError(`${forms[0]} must be a positive number`, forms[0]);
    deadlineAt = now + Math.round(n * unit);
  }
  deadlineAt = Math.trunc(deadlineAt);
  if (deadlineAt - now < config.minLeadMs) {
    throw new InputError(
      `deadline is ${Math.max(0, Math.round((deadlineAt - now) / 1000))}s away; the minimum is ${Math.round(config.minLeadMs / 1000)}s, because a closer deadline cannot leave room to broadcast and retry`,
      "deadline",
    );
  }
  if (deadlineAt - now > config.maxLeadMs) {
    throw new InputError(`deadline is more than ${Math.round(config.maxLeadMs / 86_400_000)} days away`, "deadline");
  }

  let targetBaseFeeWei = null;
  if (body.targetBaseFeeGwei != null) {
    targetBaseFeeWei = parseUnits(String(body.targetBaseFeeGwei), 9);
    if (targetBaseFeeWei <= 0n) throw new InputError("targetBaseFeeGwei must be positive", "targetBaseFeeGwei");
  }
  if (body.dryRun != null && typeof body.dryRun !== "boolean") throw new InputError("dryRun must be true or false", "dryRun");

  return { rawTx: body.rawTx.trim(), deadlineAt, targetBaseFeeWei, dryRun: body.dryRun === true };
}

const pushEvent = (job, now, type, message) => {
  job.events.push({ at: now, type, message });
  if (job.events.length > 40) job.events.splice(1, job.events.length - 40); // keep the first event (creation)
};

/**
 * Build a job from a signed transaction. Reads the chain twice: the chain id,
 * so a transaction signed for another network is refused rather than relayed,
 * and the base fee, which becomes the "price at request time".
 */
export async function createJob({ rpc, body, now, id, config = DEFAULTS }) {
  const req = validateJobRequest(body, now, config);
  const tx = decodeRawTx(req.rawTx);

  if (tx.chainId == null) {
    throw new InputError("rawTx is a pre-EIP-155 transaction with no chain id; it could replay on another network", "rawTx");
  }
  const chainId = BigInt(await rpc.chainId());
  if (tx.chainId !== chainId) {
    throw new InputError(`rawTx was signed for chain ${tx.chainId}, this node is chain ${chainId}`, "rawTx");
  }
  if (tx.gasLimit <= 0n) throw new InputError("rawTx has a zero gas limit", "rawTx");

  const baseStr = await currentBaseFee(rpc);
  if (baseStr == null) throw new RpcError("the base fee could not be read, so no price at request time can be recorded");
  const base = BigInt(baseStr);

  const quotePrice = pricePerGas(tx, base);
  const target = req.targetBaseFeeWei ?? base;

  const warnings = [];
  if (!tx.flatPrice && tx.maxFeeWei < base) {
    warnings.push(
      `maxFeePerGas ${formatGwei(tx.maxFeeWei)} gwei is below the current base fee ${formatGwei(base)} gwei: the transaction cannot be included until the base fee falls to it`,
    );
  }
  if (tx.flatPrice) {
    warnings.push("legacy/type-1 transaction: the price is the fixed gasPrice, so the base fee cannot change what it pays");
  }
  if (base <= target && !(!tx.flatPrice && tx.maxFeeWei < base)) {
    warnings.push("the current base fee already meets the target, so the first check will submit");
  }

  const job = {
    id,
    createdAt: now,
    deadlineAt: req.deadlineAt,
    status: "HOLDING",
    mode: req.dryRun ? "dryRun" : "live",
    rawTx: req.rawTx,
    tx: {
      hash: tx.hash,
      kind: tx.kind,
      chainId: tx.chainId.toString(),
      nonce: tx.nonce.toString(),
      gasLimit: tx.gasLimit.toString(),
      to: tx.to,
      maxFeeWei: tx.maxFeeWei.toString(),
      tipWei: tx.tipWei.toString(),
      flatPrice: tx.flatPrice,
    },
    quote: {
      at: now,
      baseFeeWei: base.toString(),
      baseFeeGwei: formatGwei(base),
      pricePerGasWei: quotePrice.toString(),
      pricePerGasGwei: formatGwei(quotePrice),
    },
    policy: {
      targetBaseFeeWei: target.toString(),
      targetBaseFeeGwei: formatGwei(target),
      targetSource: req.targetBaseFeeWei == null ? "price at request time" : "caller",
    },
    warnings,
    checks: 0,
    lastBaseFeeWei: base.toString(),
    lastCheckAt: now,
    lastError: null,
    nextWakeAt: now,
    submit: null,
    settlement: null,
    finishedAt: null,
    events: [],
  };
  pushEvent(job, now, "CREATED", `holding until base fee <= ${formatGwei(target)} gwei or deadline ${new Date(req.deadlineAt).toISOString()}`);
  return job;
}

/** What to do now. Pure. `baseFeeWei` is null when the chain could not be read. */
export function decide(job, baseFeeWei, now, config = DEFAULTS) {
  if (job.submit?.reason) return { action: "SUBMIT", reason: job.submit.reason }; // already committed; this is a retry
  if (now >= job.deadlineAt - config.deadlineMarginMs) return { action: "SUBMIT", reason: "DEADLINE" };
  if (baseFeeWei == null) return { action: "HOLD", why: "base fee unreadable; waiting, the deadline will still fire" };

  const base = toBigInt(baseFeeWei);
  const target = BigInt(job.policy.targetBaseFeeWei);
  const maxFee = BigInt(job.tx.maxFeeWei);
  if (!job.tx.flatPrice && maxFee < base) {
    return { action: "HOLD", why: "base fee is above the transaction's maxFeePerGas; it could not be included yet" };
  }
  if (base <= target) return { action: "SUBMIT", reason: "FAVORABLE" };
  return { action: "HOLD", why: `base fee ${formatGwei(base)} gwei is above target ${formatGwei(target)} gwei` };
}

const finish = (job, now, status) => {
  job.status = status;
  job.finishedAt = now;
  job.nextWakeAt = null;
  job.rawTx = null; // a signed transaction is a bearer instrument; do not keep it once it has no use
};

async function lookupByHash(rpc, hash) {
  try {
    return (await rpc.call("eth_getTransactionByHash", [hash])) != null;
  } catch {
    return false;
  }
}

function markSubmitted(job, now, baseFeeWei, txHash, config = DEFAULTS) {
  job.status = "SUBMITTED";
  job.submit.at = now;
  job.submit.txHash = txHash;
  job.submit.baseFeeWei = baseFeeWei;
  job.submit.late = now > job.deadlineAt;
  job.rawTx = null;
  job.nextWakeAt = now + config.receiptPollMs;
  if (job.submit.late) pushEvent(job, now, "LATE", "broadcast landed after the deadline");
}

async function doSubmit(job, rpc, baseFeeWei, now, config, reason) {
  job.submit = job.submit ?? { reason, attempts: 0 };
  job.submit.attempts += 1;
  const attempt = job.submit.attempts;

  if (attempt > 1 && (await lookupByHash(rpc, job.tx.hash))) {
    // An earlier attempt timed out after the node accepted it.
    markSubmitted(job, now, baseFeeWei, job.tx.hash, config);
    pushEvent(job, now, "SUBMITTED", `found on chain by hash after a failed attempt: ${job.tx.hash}`);
    return;
  }

  if (job.mode === "dryRun") {
    const price = pricePerGas(
      { flatPrice: job.tx.flatPrice, maxFeeWei: BigInt(job.tx.maxFeeWei), tipWei: BigInt(job.tx.tipWei) },
      baseFeeWei ?? job.quote.baseFeeWei,
    );
    const gasLimit = BigInt(job.tx.gasLimit);
    const quotePrice = BigInt(job.quote.pricePerGasWei);
    job.submit.at = now;
    job.submit.baseFeeWei = baseFeeWei;
    job.submit.late = now > job.deadlineAt;
    job.settlement = {
      simulated: true,
      note: "dry run: nothing was broadcast, so there is no gas actually paid; these are worst-case figures at the gas limit",
      pricePerGasWei: price.toString(),
      pricePerGasGwei: formatGwei(price),
      quotedPricePerGasGwei: job.quote.pricePerGasGwei,
      worstCaseWei: (price * gasLimit).toString(),
      worstCasePROS: formatPROS(price * gasLimit),
      quotedWorstCasePROS: formatPROS(quotePrice * gasLimit),
    };
    finish(job, now, "SIMULATED");
    pushEvent(job, now, "SIMULATED", `would have broadcast (${reason})`);
    return;
  }

  try {
    const returned = await rpc.call("eth_sendRawTransaction", [job.rawTx]);
    const hash = typeof returned === "string" ? returned : job.tx.hash;
    if (hash.toLowerCase() !== job.tx.hash.toLowerCase()) {
      pushEvent(job, now, "HASH_MISMATCH", `node returned ${hash}, decoded hash was ${job.tx.hash}; tracking the node's hash`);
    }
    markSubmitted(job, now, baseFeeWei, hash, config);
    pushEvent(job, now, "SUBMITTED", `broadcast (${reason}, attempt ${attempt}): ${hash}`);
  } catch (err) {
    job.lastError = String(err?.message ?? err).slice(0, 300);
    const exhausted = attempt >= config.maxSendAttempts;
    if (err?.transient === true && !exhausted) {
      job.nextWakeAt = now + config.retryMs;
      pushEvent(job, now, "RETRY", `attempt ${attempt} failed (${job.lastError}); retrying`);
      return;
    }
    // Permanent rejection, or retries spent. "already known" and "nonce too low" land here too:
    // a transaction that is on chain under our hash is a success, anything else is a failure.
    if (await lookupByHash(rpc, job.tx.hash)) {
      markSubmitted(job, now, baseFeeWei, job.tx.hash, config);
      pushEvent(job, now, "SUBMITTED", `node refused the resend but the transaction is on chain: ${job.tx.hash}`);
      return;
    }
    finish(job, now, "FAILED");
    pushEvent(
      job,
      now,
      "FAILED",
      err?.transient === true
        ? `could not broadcast after ${attempt} attempts: ${job.lastError}`
        : `node rejected the transaction: ${job.lastError}`,
    );
  }
}

function settle(job, receipt, now) {
  const gasUsed = BigInt(receipt.gasUsed);
  const effective = BigInt(receipt.effectiveGasPrice ?? "0x0");
  const quoted = BigInt(job.quote.pricePerGasWei);
  const paid = gasUsed * effective;
  const quotedCost = gasUsed * quoted; // same gas, priced at request time: like for like
  const diff = quotedCost - paid;
  const abs = diff < 0n ? -diff : diff;

  job.settlement = {
    simulated: false,
    executed: receipt.status === "0x1",
    blockNumber: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: effective.toString(),
    effectiveGasPriceGwei: formatGwei(effective),
    paidWei: paid.toString(),
    paidPROS: formatPROS(paid),
    quotedPricePerGasGwei: job.quote.pricePerGasGwei,
    quotedCostWei: quotedCost.toString(),
    quotedCostPROS: formatPROS(quotedCost),
    outcome: diff > 0n ? "SAVED" : diff < 0n ? "EXTRA" : "SAME",
    differenceWei: abs.toString(),
    differencePROS: formatPROS(abs),
    differencePct: quotedCost === 0n ? null : `${((Number(abs) / Number(quotedCost)) * 100).toFixed(2)}`,
    submittedBy: job.submit?.reason ?? null,
  };
  finish(job, now, receipt.status === "0x1" ? "SETTLED" : "REVERTED");
  pushEvent(job, now, job.status, `${job.settlement.outcome} ${job.settlement.differencePROS} PROS vs request-time price`);
}

/** Advance one job by one step. Returns a new job object; the input is not mutated. */
export async function tick(input, { rpc, now, config = DEFAULTS }) {
  const job = structuredClone(input);
  if (isTerminal(job)) return job;

  if (job.status === "SUBMITTED") {
    let receipt = null;
    try {
      receipt = await rpc.call("eth_getTransactionReceipt", [job.submit.txHash]);
    } catch (err) {
      job.lastError = String(err?.message ?? err).slice(0, 300);
    }
    if (receipt) settle(job, receipt, now);
    else if (now - job.submit.at > config.receiptTimeoutMs) {
      finish(job, now, "UNCONFIRMED");
      pushEvent(job, now, "UNCONFIRMED", `no receipt ${Math.round(config.receiptTimeoutMs / 60000)} min after broadcast; it may still be pending, so no paid figure is reported`);
    } else job.nextWakeAt = now + config.receiptPollMs;
    return job;
  }

  // HOLDING
  let baseFeeWei = null;
  try {
    baseFeeWei = await currentBaseFee(rpc);
    job.lastError = null;
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 300);
    if (message !== job.lastError) pushEvent(job, now, "READ_FAILED", message);
    job.lastError = message;
  }
  job.checks += 1;
  job.lastCheckAt = now;
  if (baseFeeWei != null) job.lastBaseFeeWei = baseFeeWei;

  const d = decide(job, baseFeeWei, now, config);
  if (d.action === "SUBMIT") {
    if (!job.submit) {
      pushEvent(
        job,
        now,
        d.reason,
        d.reason === "DEADLINE"
          ? `deadline reached; broadcasting at ${baseFeeWei == null ? "an unreadable base fee" : `${formatGwei(baseFeeWei)} gwei`} regardless of price`
          : `base fee ${formatGwei(baseFeeWei)} gwei is at or below target; broadcasting`,
      );
    }
    await doSubmit(job, rpc, baseFeeWei, now, config, d.reason);
    return job;
  }

  job.nextWakeAt = Math.min(now + config.pollMs, job.deadlineAt - config.deadlineMarginMs);
  return job;
}

/** Cancel a job that has not been broadcast. Anything later cannot be recalled. */
export function cancel(input, now) {
  if (input.status !== "HOLDING") {
    return { ok: false, reason: `job is ${input.status}; only a job still holding can be cancelled` };
  }
  if (input.submit?.attempts > 0) {
    return { ok: false, reason: "a broadcast attempt is already in progress" };
  }
  const job = structuredClone(input);
  finish(job, now, "CANCELLED");
  pushEvent(job, now, "CANCELLED", "cancelled before broadcast");
  return { ok: true, job };
}
