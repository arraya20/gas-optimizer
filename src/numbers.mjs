// Small numeric/hex helpers.
//
// We stay in BigInt for every quantity that can exceed 2^53: wei, gas, and the
// products of the two. A float here silently loses precision on exactly the
// numbers a fee tool exists to report.

export class InputError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "InputError";
    this.field = field;
  }
}

/** Parse a JSON-RPC quantity (0x…) or a decimal string into BigInt. */
export function toBigInt(value, field = "value") {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new InputError(`${field}: ${value} is not a safe integer; pass a string`, field);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") throw new InputError(`${field}: empty string`, field);
    try {
      return s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s);
    } catch {
      throw new InputError(`${field}: not an integer: ${value}`, field);
    }
  }
  throw new InputError(`${field}: expected integer, got ${typeof value}`, field);
}

/**
 * Format a base-unit integer as a decimal string.
 *
 * The rule that matters: truncation must never erase the value. An earlier
 * version of this idea sliced the fraction to six places, so 1000 wei rendered
 * as "0" and a fee report could read "cost: 0 PROS" for a real charge.
 */
export function formatUnits(value, decimals = 18, maxFractionDigits = decimals) {
  const v = toBigInt(value, "value");
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return `${negative ? "-" : ""}${whole}`;

  const full = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  let shown = full.slice(0, Math.max(1, maxFractionDigits)).replace(/0+$/, "");
  if (shown === "" && full !== "") shown = full;
  return `${negative ? "-" : ""}${whole}.${shown}`;
}

/**
 * Parse a decimal string like "12.5" into base units.
 *
 * Gas prices on this chain are genuinely fractional — maxFeePerGas values of
 * 11.25 and 22.91779976 gwei appear in real receipts — so a fee field that only
 * accepts integers cannot describe what the chain actually produces.
 */
export function parseUnits(text, decimals = 18) {
  const s = String(text).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "." || s === "-") {
    throw new InputError(`not a decimal number: ${text}`, "value");
  }
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [whole, frac = ""] = body.split(".");
  if (frac.length > decimals) {
    // Extra digits cannot be represented; refusing beats silently rounding.
    throw new InputError(`too many decimals for ${decimals}-decimal units: ${text}`, "value");
  }
  const digits = `${whole || "0"}${frac.padEnd(decimals, "0")}`;
  const v = BigInt(digits);
  return negative ? -v : v;
}

/** wei → PROS string (the native unit on Pharos, 18 decimals). */
export const formatPROS = (wei) => formatUnits(wei, 18);

/** wei → gwei string (9 decimals), used for every fee/gas-price figure. */
export const formatGwei = (wei) => formatUnits(wei, 9);

/** Group an integer with separators, for gas counts. */
export function groupDigits(value) {
  const s = toBigInt(value, "value").toString();
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Percentage of `part` in `whole`, as a string with `digits` places.
 *
 * Returns the percentage, not the fraction: percent(26n, 44n) is "59.09". An
 * earlier revision returned 0.59 while every caller appended "%", so a report
 * printed "0.59% of transactions" for a majority.
 */
export function percent(part, whole, digits = 2) {
  const p = toBigInt(part, "part");
  const w = toBigInt(whole, "whole");
  if (w === 0n) return "n/a";
  // ×100 for percent, ×10^digits to keep the decimals, all in integer math.
  const scale = 100n * 10n ** BigInt(digits);
  const scaled = (p * scale) / w;
  return formatUnits(scaled, digits, digits);
}

/** Compare two hex quantities for equality without going through Number. */
export const sameQuantity = (a, b) => toBigInt(a, "a") === toBigInt(b, "b");
