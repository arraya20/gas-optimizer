// Decode a signed raw transaction into the fields that decide what it costs.
//
// This tool never signs and never holds a key. The caller signs elsewhere
// (cast, ethers, a wallet) and hands over the finished bytes; this module reads
// them so the scheduler can reason about the fee the caller already committed to.
//
// Not done here: signature verification and sender recovery. Both need
// secp256k1, and the node performs them on submit anyway. A bad signature
// surfaces as a rejected broadcast, which the scheduler reports as FAILED.

import { InputError } from "./numbers.mjs";
import { hexToBytes, bytesToHex, bytesToBigInt, decodeRlp } from "./rlp.mjs";
import { keccak256 } from "./keccak.mjs";

const bad = (msg) => new InputError(`rawTx: ${msg}`, "rawTx");

function asInt(item, name) {
  if (!(item instanceof Uint8Array)) throw bad(`${name} must be a byte string`);
  if (item.length > 1 && item[0] === 0) throw bad(`${name} has a leading zero`);
  return bytesToBigInt(item);
}

function expectList(payload, count, label) {
  if (!Array.isArray(payload)) throw bad(`${label} payload is not a list`);
  if (payload.length !== count) throw bad(`${label} needs ${count} fields, found ${payload.length}`);
  return payload;
}

function checkSignature(r, s) {
  if (!(r instanceof Uint8Array) || !(s instanceof Uint8Array) || bytesToBigInt(r) === 0n || bytesToBigInt(s) === 0n) {
    throw bad("signature is missing: this is an unsigned transaction");
  }
}

function toAddress(item) {
  if (!(item instanceof Uint8Array)) throw bad("to must be a byte string");
  if (item.length === 0) return null; // contract creation
  if (item.length !== 20) throw bad("to must be 20 bytes or empty");
  return bytesToHex(item);
}

/**
 * @param {string} rawHex 0x… signed transaction
 * @returns {{
 *   kind: "legacy"|"eip2930"|"eip1559", type: number, hash: string, chainId: bigint|null,
 *   nonce: bigint, gasLimit: bigint, to: string|null, value: bigint,
 *   maxFeeWei: bigint, tipWei: bigint, flatPrice: boolean
 * }}
 */
export function decodeRawTx(rawHex) {
  const bytes = hexToBytes(rawHex, "rawTx");
  if (bytes.length > 128 * 1024) throw bad("transaction is larger than 128 KiB");
  const hash = bytesToHex(keccak256(bytes));
  const first = bytes[0];

  if (first >= 0xc0) {
    const f = expectList(decodeRlp(bytes), 9, "legacy transaction");
    checkSignature(f[7], f[8]);
    const v = asInt(f[6], "v");
    const gasPrice = asInt(f[1], "gasPrice");
    return {
      kind: "legacy",
      type: 0,
      hash,
      chainId: v >= 35n ? (v - 35n) / 2n : null,
      nonce: asInt(f[0], "nonce"),
      gasLimit: asInt(f[2], "gasLimit"),
      to: toAddress(f[3]),
      value: asInt(f[4], "value"),
      maxFeeWei: gasPrice,
      tipWei: gasPrice,
      flatPrice: true,
    };
  }

  if (first === 0x01) {
    const f = expectList(decodeRlp(bytes.subarray(1)), 11, "EIP-2930 transaction");
    checkSignature(f[9], f[10]);
    const gasPrice = asInt(f[2], "gasPrice");
    return {
      kind: "eip2930",
      type: 1,
      hash,
      chainId: asInt(f[0], "chainId"),
      nonce: asInt(f[1], "nonce"),
      gasLimit: asInt(f[3], "gasLimit"),
      to: toAddress(f[4]),
      value: asInt(f[5], "value"),
      maxFeeWei: gasPrice,
      tipWei: gasPrice,
      flatPrice: true,
    };
  }

  if (first === 0x02) {
    const f = expectList(decodeRlp(bytes.subarray(1)), 12, "EIP-1559 transaction");
    checkSignature(f[10], f[11]);
    const tip = asInt(f[2], "maxPriorityFeePerGas");
    const maxFee = asInt(f[3], "maxFeePerGas");
    if (tip > maxFee) throw bad("maxPriorityFeePerGas is above maxFeePerGas: the node rejects this");
    return {
      kind: "eip1559",
      type: 2,
      hash,
      chainId: asInt(f[0], "chainId"),
      nonce: asInt(f[1], "nonce"),
      gasLimit: asInt(f[4], "gasLimit"),
      to: toAddress(f[5]),
      value: asInt(f[6], "value"),
      maxFeeWei: maxFee,
      tipWei: tip,
      flatPrice: false,
    };
  }

  throw bad(
    `transaction type 0x${first.toString(16).padStart(2, "0")} is not supported (legacy, 0x01 and 0x02 only)`,
  );
}

/**
 * Per-gas price this transaction pays when the base fee is `baseFeeWei`.
 * EIP-1559: min(maxFee, base + tip). Legacy/2930: the flat gasPrice, whatever the base.
 */
export function pricePerGas(tx, baseFeeWei) {
  if (tx.flatPrice) return tx.maxFeeWei;
  const bid = BigInt(baseFeeWei) + tx.tipWei;
  return bid > tx.maxFeeWei ? tx.maxFeeWei : bid;
}
