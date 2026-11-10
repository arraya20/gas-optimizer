// Keccak-256 (the pre-NIST padding Ethereum uses, not SHA3-256).
//
// Why it is here: a signed transaction's hash is keccak256(rawTx). Knowing the
// hash before broadcasting lets the scheduler recover from the one failure that
// cannot be told apart from success: a submit that times out after the node
// already accepted the transaction. Without the hash, the retry would see
// "already known" and the job could not find its own transaction.
//
// Verified against published vectors in test/hold.test.mjs.

const MASK = (1n << 64n) - 1n;
const rol = (v, n) => {
  const s = BigInt(n % 64);
  return s === 0n ? v : ((v << s) | (v >> (64n - s))) & MASK;
};

function keccakF(lanes) {
  let R = 1;
  for (let round = 0; round < 24; round++) {
    const C = [];
    for (let x = 0; x < 5; x++) C[x] = lanes[x][0] ^ lanes[x][1] ^ lanes[x][2] ^ lanes[x][3] ^ lanes[x][4];
    const D = [];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) lanes[x][y] ^= D[x];

    let x = 1;
    let y = 0;
    let current = lanes[x][y];
    for (let t = 0; t < 24; t++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const next = lanes[x][y];
      lanes[x][y] = rol(current, ((t + 1) * (t + 2)) / 2);
      current = next;
    }

    for (let yy = 0; yy < 5; yy++) {
      const T = [];
      for (let xx = 0; xx < 5; xx++) T[xx] = lanes[xx][yy];
      for (let xx = 0; xx < 5; xx++) lanes[xx][yy] = T[xx] ^ (~T[(xx + 1) % 5] & MASK & T[(xx + 2) % 5]);
    }

    for (let j = 0; j < 7; j++) {
      R = ((R << 1) ^ ((R >> 7) * 0x71)) % 256;
      if (R & 2) lanes[0][0] ^= 1n << BigInt((1 << j) - 1);
    }
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {{domain?: number}} [opts] padding byte: 0x01 is Keccak (Ethereum), 0x06 is NIST SHA3.
 *   The permutation is identical; tests use 0x06 to check multi-block input against node:crypto.
 * @returns {Uint8Array} 32 bytes
 */
export function keccak256(bytes, { domain = 0x01 } = {}) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= domain;
  padded[padded.length - 1] ^= 0x80;

  const lanes = Array.from({ length: 5 }, () => Array(5).fill(0n));
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      lanes[i % 5][Math.floor(i / 5)] ^= lane;
    }
    keccakF(lanes);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = lanes[i % 5][Math.floor(i / 5)];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}
