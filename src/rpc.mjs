// Minimal JSON-RPC client.
//
// Only what this tool needs, and every failure keeps its cause. A fee tool that
// reports "0 gwei" because the node did not answer is worse than one that
// refuses to answer at all.

export class RpcError extends Error {
  constructor(message, { method, code, data, cause } = {}) {
    super(message);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
    this.data = data;
    if (cause) this.cause = cause;
  }
}

export const PHAROS = {
  chainId: 1672,
  name: "Pharos Pacific",
  rpc: "https://rpc.pharos.xyz",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} [opts.url]
 * @param {number} [opts.retries]  attempts after the first failure
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]  injected in tests
 */
export function createRpc({ url = PHAROS.rpc, retries = 2, timeoutMs = 20000, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new RpcError("no fetch implementation available");
  }

  async function callOnce(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new RpcError(`${method}: transport failed (${cause.message})`, { method, cause });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The body often explains why (range limits, unsupported method). Keep it.
      const text = await res.text().catch(() => "");
      throw new RpcError(`${method}: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`, {
        method,
        code: res.status,
      });
    }

    const body = await res.json().catch(() => null);
    if (!body) throw new RpcError(`${method}: response was not JSON`, { method });
    if (body.error) {
      throw new RpcError(`${method}: ${body.error.message}`, {
        method,
        code: body.error.code,
        data: body.error.data,
      });
    }
    return body.result;
  }

  async function call(method, params = []) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await callOnce(method, params);
      } catch (err) {
        last = err;
        // A method the node does not have will not appear on retry.
        const permanent = err.code === -32601 || err.code === -32602;
        if (permanent || attempt === retries) break;
        await sleep(250 * (attempt + 1));
      }
    }
    throw last;
  }

  return {
    url,
    call,
    blockNumber: async () => toNumber(await call("eth_blockNumber")),
    chainId: async () => toNumber(await call("eth_chainId")),
  };
}

/** Hex quantity → Number. Only for values that are safely small (block heights). */
export function toNumber(hex) {
  const n = Number(BigInt(hex));
  if (!Number.isSafeInteger(n)) throw new RpcError(`quantity too large for Number: ${hex}`);
  return n;
}
