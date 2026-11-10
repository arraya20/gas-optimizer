// POST /api/analyze — Cloudflare Pages Function.
//
// Contract: the body describes a transaction, nothing else. Any field that looks
// like a market number the caller decided (baseFee, gasPrice) or a conclusion
// (verdict, recommendation) is rejected with 400 by validateRequest.
//
// Runtime notes (workerd):
//   · no `process`, no `node:fs` — everything here uses web APIs only
//   · subrequests are capped by the plan, so the sample window is bounded well
//     below the CLI default instead of silently failing partway through

import { validateRequest, analyze } from "../../src/analyze.mjs";
import { createRpc, RpcError } from "../../src/rpc.mjs";
import { InputError } from "../../src/numbers.mjs";

const MAX_SAMPLE = 60;
const DEFAULT_SAMPLE = 20;
const MAX_RECEIPTS = 18;

// Blocks between sampled headers. 60 blocks at this spacing covers ~47k blocks:
// wide enough that the sample is not one burst of activity, cheap enough that the
// analysis stays inside the worker subrequest budget.
const SAMPLE_STRIDE = 800;

const json = (body, status) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "body must be JSON", kind: "InputError" }, 400);
  }

  let tx;
  try {
    tx = validateRequest(payload);
  } catch (err) {
    if (err instanceof InputError) {
      return json({ error: err.message, kind: "InputError", field: err.field ?? null }, 400);
    }
    throw err;
  }

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("sample") ?? DEFAULT_SAMPLE);
  const sampleBlocks = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SAMPLE)
    : DEFAULT_SAMPLE;

  const rpc = createRpc({ url: env?.PHAROS_RPC || undefined, retries: 0, timeoutMs: 12000 });

  try {
    const report = await analyze({
      rpc,
      request: tx,
      sampleBlocks,
      stride: SAMPLE_STRIDE,
      maxReceipts: MAX_RECEIPTS,
    });
    return json(
      {
        ...report,
        limits: {
          sampleRequested: requested,
          sampleUsed: sampleBlocks,
          maxSample: MAX_SAMPLE,
          note:
            sampleBlocks < requested
              ? `sample capped at ${MAX_SAMPLE} blocks to stay inside the worker subrequest budget`
              : null,
        },
      },
      200,
    );
  } catch (err) {
    if (err instanceof InputError) {
      return json({ error: err.message, kind: "InputError", field: err.field ?? null }, 400);
    }
    if (err instanceof RpcError) {
      return json({ error: err.message, kind: "RpcError", method: err.method ?? null }, 502);
    }
    return json({ error: err?.message ?? "unexpected failure", kind: "Error" }, 500);
  }
}

export async function onRequestGet() {
  return json({ error: "use POST with a transaction description" }, 405);
}

// Exported for the test fixture: the stub chain has to place its transactions on
// the blocks this handler will actually ask for.
export { SAMPLE_STRIDE };
