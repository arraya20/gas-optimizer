// API tests: the real Pages Function against a real local JSON-RPC server.
//
// The RPC travels over a socket, so the handler is tested through the same path
// it uses in production. Mocking fetch would skip the part most likely to break:
// the wire format.

import { createServer } from "node:http";
import { onRequestPost, onRequestGet, SAMPLE_STRIDE } from "../functions/api/analyze.js";
import { test, run, eq, setFile } from "./harness.mjs";

setFile("api");

const GWEI = 1_000_000_000n;
const BASE = 10n * GWEI;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

// ── synthetic chain ─────────────────────────────────────────────────────────
//
// The handler reads a strided window, so the stub chain has to be tall enough
// for that window to fit inside it. Blocks are spaced SAMPLE_STRIDE apart — the
// same spacing the handler samples at — so the fixture describes the shape of
// chain the code actually queries, instead of a contiguous one it no longer does.
const HEIGHT = SAMPLE_STRIDE * 70 + 5;
const BLOCK_A = HEIGHT - 2 * SAMPLE_STRIDE; // one tx, base fee only
const BLOCK_B = HEIGHT - 5 * SAMPLE_STRIDE; // one tx, tip + over-locked
const BLOCK_C = HEIGHT - 7 * SAMPLE_STRIDE; // one reverted tx: must not count

function makeTx(hash, gasLimit, maxFee, tip) {
  return {
    hash,
    type: "0x2",
    gas: hex(gasLimit),
    gasLimit: hex(gasLimit),
    maxFeePerGas: hex(maxFee),
    maxPriorityFeePerGas: hex(tip),
  };
}

const TX_A = makeTx("0xaa", 100_000n, 10n * GWEI, 0n); // base only
const TX_B = makeTx("0xbb", 100_000n, 20n * GWEI, 5n * GWEI); // tip + over-lock
const TX_C = makeTx("0xcc", 100_000n, 30n * GWEI, 9n * GWEI); // reverted: paid gas, no inclusion

const RECEIPTS = {
  "0xaa": { status: "0x1", gasUsed: hex(60_000n), effectiveGasPrice: hex(10n * GWEI) },
  "0xbb": { status: "0x1", gasUsed: hex(60_000n), effectiveGasPrice: hex(15n * GWEI) },
  "0xcc": { status: "0x0", gasUsed: hex(60_000n), effectiveGasPrice: hex(30n * GWEI) },
};

function blockAt(n) {
  const txs = n === BLOCK_A ? [TX_A] : n === BLOCK_B ? [TX_B] : n === BLOCK_C ? [TX_C] : [];
  return {
    number: hex(n),
    baseFeePerGas: hex(BASE),
    gasUsed: hex(txs.length ? 120_000n : 0n),
    gasLimit: hex(1_000_000_000n),
    transactions: txs,
  };
}

function rpcResult(method, params) {
  switch (method) {
    case "eth_chainId":
      return "0x688";
    case "eth_blockNumber":
      return hex(HEIGHT);
    case "eth_getBlockByNumber": {
      const tag = params[0];
      const n = tag === "latest" ? HEIGHT : Number(BigInt(tag));
      if (n < 0 || n > HEIGHT) return null;
      return blockAt(n);
    }
    case "eth_feeHistory": {
      const count = Number(BigInt(params[0]));
      const end = Number(BigInt(params[1]));
      if (end > HEIGHT) throw Object.assign(new Error("beyond head"), { rpcCode: -32000 });
      const oldest = Math.max(0, end - count + 1);
      const values = [];
      for (let i = oldest; i <= end; i++) values.push(hex(BASE));
      return { oldestBlock: hex(oldest), baseFeePerGas: values, gasUsedRatio: values.map(() => 0.0001), reward: null };
    }
    case "eth_getTransactionReceipt": {
      const r = RECEIPTS[params[0]];
      return r ? { ...r, transactionHash: params[0] } : null;
    }
    default: {
      const err = new Error(`method ${method} not found`);
      err.rpcCode = -32601;
      throw err;
    }
  }
}

let server;
let baseUrl;

async function startChain() {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      try {
        const result = rpcResult(msg.method, msg.params ?? []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: err.rpcCode ?? -32000, message: err.message } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

function req(body, { sample = 10, url = "http://localhost/api/analyze" } = {}) {
  const u = new URL(url);
  if (sample != null) u.searchParams.set("sample", String(sample));
  return {
    request: new Request(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env: { PHAROS_RPC: baseUrl },
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

test("the handler analyses a transaction and returns a verdict measured from the node", async () => {
  const res = await onRequestPost(req({ gasLimit: 100000, maxFeeGwei: "20", tipGwei: "0" }));
  const body = await res.json();

  eq(res.status, 200);
  eq(body.market.baseFeeGwei, "10", "base fee came from the stub chain");
  eq(body.market.frozen, true);
  eq(body.advice.verdict, "OVER_LOCKED", "maxFee above base with no tip");
  eq(body.advice.recommended.maxFeeGwei, "10");
});

test("the report is JSON-serialisable — no BigInt reaches the wire", async () => {
  const res = await onRequestPost(req({ gasLimit: 100000 }));
  const text = await res.text();
  eq(/:\s*-?\d+n[,\s}]/.test(text), false, "no BigInt literal in the payload");
  const parsed = JSON.parse(text);
  eq(typeof parsed, "object", "payload parses as JSON");
  eq(typeof parsed.advice.recommended.paidWei, "string", "wei is a string, not a number");
});

test("the not-measured list is present and non-empty even when everything looks fine", async () => {
  const res = await onRequestPost(req({ gasLimit: 21000 }));
  const body = await res.json();
  eq(Array.isArray(body.notMeasured), true);
  eq(body.notMeasured.length > 0, true);
  eq(
    body.notMeasured.some((s) => s.includes("does not simulate execution")),
    true,
    "the tool must say it does not measure gas units",
  );
});

test("a caller-supplied base fee is refused with 400, not quietly used", async () => {
  const res = await onRequestPost(req({ gasLimit: 100000, baseFee: 1 }));
  const body = await res.json();
  eq(res.status, 400);
  eq(body.kind, "InputError");
  eq(body.error.includes("may not be supplied"), true);
});

test("a caller-supplied verdict is refused with 400", async () => {
  const res = await onRequestPost(req({ gasLimit: 100000, verdict: "ALREADY_MINIMAL" }));
  eq(res.status, 400);
  eq((await res.json()).error.includes("may not be supplied"), true);
});

test("malformed JSON is 400 with a JSON body, never an unhandled 500", async () => {
  const res = await onRequestPost(req("{not json"));
  eq(res.status, 400);
  eq((await res.json()).kind, "InputError");
});

test("a missing gas limit is 400 and names the field", async () => {
  const res = await onRequestPost(req({ maxFeeGwei: "10" }));
  const body = await res.json();
  eq(res.status, 400);
  eq(body.field, "gasLimit");
});

test("the sample window is capped and the cap is reported", async () => {
  const res = await onRequestPost(req({ gasLimit: 21000 }, { sample: 5000 }));
  const body = await res.json();
  eq(res.status, 200);
  eq(body.limits.sampleUsed, 60);
  eq(body.limits.sampleRequested, 5000);
  eq(typeof body.limits.note, "string");
});

test("GET is refused with 405 instead of running an analysis", async () => {
  const res = await onRequestGet();
  eq(res.status, 405);
});

test("an unreachable node is 502, not a fabricated report", async () => {
  const u = new URL("http://localhost/api/analyze");
  u.searchParams.set("sample", "5");
  const res = await onRequestPost({
    request: new Request(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gasLimit: 21000 }),
    }),
    env: { PHAROS_RPC: "http://127.0.0.1:1" },
  });
  const body = await res.json();
  eq(res.status, 502);
  eq(body.kind, "RpcError");
});

test("a reverted transaction is excluded from the payment statistics", async () => {
  const res = await onRequestPost(req({ gasLimit: 21000 }, { sample: 20 }));
  const body = await res.json();
  // Three stub transactions landed in the window; one reverted. A revert paid gas
  // but was not included, so counting it would inflate the sample with a payment
  // that did not buy what the sample claims to measure.
  eq(body.sample.transactions, 2, `only the two successful txs count, got ${body.sample.transactions}`);
  eq(typeof body.sample.paidTotalWei, "string", "quantities cross the wire as strings");
});

test("capacity in the report describes the strided window, not a contiguous tail", async () => {
  const res = await onRequestPost(req({ gasLimit: 21000 }, { sample: 20 }));
  const body = await res.json();
  eq(body.market.capacity.blocksSampled, 20, "every requested header was read");
  eq(body.market.capacity.spanBlocks > 20 * SAMPLE_STRIDE * 0.9, true, `span covers the strides: ${body.market.capacity.spanBlocks}`);
  eq(body.market.capacity.emptyCount, 17, "only three blocks carried transactions");
  eq(["no-queue", "light", "contended"].includes(body.market.capacity.congestion), true);
});

// Start the server, run every test, then close — in that order.
await startChain();
let failures;
try {
  failures = await run();
} finally {
  await new Promise((resolve) => server.close(resolve));
}
process.exit(failures === 0 ? 0 : 1);
