// Strict RLP, enough to read and (in tests) build Ethereum transactions.
//
// Strict means non-canonical encodings are rejected instead of tolerated: a
// transaction this tool reads differently from the node is a transaction whose
// fee the tool would misreport.

import { InputError } from "./numbers.mjs";

export function hexToBytes(hex, field = "rawTx") {
  if (typeof hex !== "string") throw new InputError(`${field}: expected a hex string`, field);
  const s = /^0x/i.test(hex.trim()) ? hex.trim().slice(2) : hex.trim();
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new InputError(`${field}: not valid hex bytes`, field);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export function bytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

const bad = (msg) => new InputError(`rawTx: malformed RLP (${msg})`, "rawTx");

function readLength(b, pos, n) {
  if (pos + n > b.length) throw bad("length runs past the end");
  if (b[pos] === 0) throw bad("length has a leading zero");
  const len = Number(bytesToBigInt(b.subarray(pos, pos + n)));
  if (!Number.isSafeInteger(len) || len > b.length) throw bad("length exceeds the payload");
  return len;
}

function readItem(b, pos) {
  if (pos >= b.length) throw bad("unexpected end");
  const p = b[pos];
  if (p < 0x80) return { item: b.subarray(pos, pos + 1), end: pos + 1 };

  if (p <= 0xb7) {
    const len = p - 0x80;
    if (pos + 1 + len > b.length) throw bad("string runs past the end");
    if (len === 1 && b[pos + 1] < 0x80) throw bad("single byte should not be prefixed");
    return { item: b.subarray(pos + 1, pos + 1 + len), end: pos + 1 + len };
  }
  if (p <= 0xbf) {
    const ll = p - 0xb7;
    const len = readLength(b, pos + 1, ll);
    if (len < 56) throw bad("long form used for a short string");
    const start = pos + 1 + ll;
    if (start + len > b.length) throw bad("string runs past the end");
    return { item: b.subarray(start, start + len), end: start + len };
  }

  let len;
  let start;
  if (p <= 0xf7) {
    len = p - 0xc0;
    start = pos + 1;
  } else {
    const ll = p - 0xf7;
    len = readLength(b, pos + 1, ll);
    if (len < 56) throw bad("long form used for a short list");
    start = pos + 1 + ll;
  }
  const end = start + len;
  if (end > b.length) throw bad("list runs past the end");
  const items = [];
  let cursor = start;
  while (cursor < end) {
    const r = readItem(b, cursor);
    if (r.end > end) throw bad("item crosses its list boundary");
    items.push(r.item);
    cursor = r.end;
  }
  return { item: items, end };
}

/** @returns {Uint8Array | Array} a byte string, or a (nested) list of them */
export function decodeRlp(bytes) {
  const { item, end } = readItem(bytes, 0);
  if (end !== bytes.length) throw bad("trailing bytes after the item");
  return item;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const lengthPrefix = (len, short) => {
  if (len < 56) return Uint8Array.of(short + len);
  const lenBytes = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) lenBytes.unshift(n % 256);
  return Uint8Array.of(short + 55 + lenBytes.length, ...lenBytes);
};

/** @param {Uint8Array | Array} item */
export function encodeRlp(item) {
  if (Array.isArray(item)) {
    const body = concat(item.map(encodeRlp));
    return concat([lengthPrefix(body.length, 0xc0), body]);
  }
  if (item.length === 1 && item[0] < 0x80) return item;
  return concat([lengthPrefix(item.length, 0x80), item]);
}

/** Minimal big-endian bytes for a non-negative integer; zero is the empty string. */
export function rlpInt(value) {
  let v = BigInt(value);
  const out = [];
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Uint8Array.from(out);
}
