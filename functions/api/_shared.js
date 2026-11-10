// Shared runtime helper for Cloudflare Pages Functions (/api/history, /api/jobs, /api/jobs/:id).
//
// If a Durable Object binding (`env.OPTIMIZER`) is configured, requests are routed
// to the single global Durable Object. On standard Cloudflare Pages deployments
// where Durable Object bindings are not attached, a per-isolate storage backed by
// `globalThis` is used together with client-assisted state rehydration (`x-job-state`)
// and on-chain `eth_feeHistory` seeding so neither isolate rotation nor cold starts
// lose jobs or leave the history chart empty.

import { createRpc, RpcError, toNumber } from "../../src/rpc.mjs";
import { createOptimizer, SAMPLE_EVERY_MS } from "../../src/optimizer.mjs";
import { InputError, toBigInt } from "../../src/numbers.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const ID_RE = /^[0-9a-f]{32}$/;

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export function errorResponse(err) {
  if (err instanceof InputError) return json({ error: err.message, kind: "InputError", field: err.field ?? null }, 400);
  if (err instanceof RpcError) return json({ error: err.message, kind: "RpcError", method: err.method ?? null }, 502);
  return json({ error: err?.message ?? "unexpected failure", kind: "Error" }, 500);
}

export async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new InputError(`body is larger than ${MAX_BODY_BYTES} bytes`, "body");
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("body must be JSON", "body");
  }
}

function getPagesStorage() {
  if (!globalThis.__pharosPagesStorage) {
    const map = new Map();
    globalThis.__pharosPagesStorage = {
      async get(k) {
        const v = map.get(k);
        return v === undefined ? undefined : structuredClone(v);
      },
      async put(k, v) {
        map.set(k, structuredClone(v));
      },
      async delete(k) {
        map.delete(k);
      },
      async list({ prefix = "" } = {}) {
        const out = new Map();
        for (const [k, v] of map) {
          if (k.startsWith(prefix)) out.set(k, structuredClone(v));
        }
        return out;
      },
    };
  }
  return globalThis.__pharosPagesStorage;
}

export function getEngine(env) {
  const storage = getPagesStorage();
  const rpc = createRpc({ url: env?.PHAROS_RPC || undefined, retries: 1, timeoutMs: 12000 });
  const engine = createOptimizer({ storage, rpc });
  return { storage, rpc, engine };
}

export async function seedHistoryIfNeeded(storage, rpc) {
  const existing = (await storage.get("history")) ?? [];
  if (existing.length >= 2) return;
  try {
    const fh = await rpc.call("eth_feeHistory", ["0x14", "latest", []]);
    const bases = fh?.baseFeePerGas ?? [];
    if (bases.length < 2) return;
    const oldest = toNumber(fh.oldestBlock);
    const now = Date.now();
    // Use the N reported blocks (excluding the pending next-block entry at the end).
    const count = Math.max(2, bases.length - 1);
    const seeded = [];
    for (let i = 0; i < count; i++) {
      seeded.push({
        t: now - (count - i) * SAMPLE_EVERY_MS,
        base: toBigInt(bases[i]).toString(),
        block: oldest + i,
      });
    }
    await storage.put("history", seeded);
    await storage.put("meta", { lastSampleAt: now - SAMPLE_EVERY_MS, lastError: null, failedSamples: 0 });
  } catch {
    // Non-fatal: runDue() will still attempt to sample the head block.
  }
}

export async function rehydrateJobIfMissing(storage, id, request) {
  if (!ID_RE.test(id)) return;
  const existing = await storage.get(`job:${id}`);
  if (existing) return;
  const header = request.headers.get("x-job-state");
  if (!header) return;
  try {
    const parsed = JSON.parse(decodeURIComponent(header));
    if (!parsed || parsed.id !== id || !parsed.tx || !parsed.quote || !parsed.policy) return;
    const restored = {
      id: parsed.id,
      createdAt: Number(parsed.createdAt) || Date.now(),
      deadlineAt: Number(parsed.deadlineAt) || Date.now() + 60_000,
      status: parsed.status || "HOLDING",
      mode: parsed.mode || "live",
      rawTx: typeof parsed.rawTx === "string" ? parsed.rawTx : null,
      tx: parsed.tx,
      quote: parsed.quote,
      policy: parsed.policy,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      checks: Number(parsed.checks) || 0,
      lastBaseFeeWei: String(parsed.lastBaseFeeWei ?? parsed.quote.baseFeeWei),
      lastCheckAt: Number(parsed.lastCheckAt) || Date.now(),
      lastError: parsed.lastError ?? null,
      nextWakeAt: parsed.nextWakeAt !== undefined ? parsed.nextWakeAt : Date.now(),
      submit: parsed.submit ?? null,
      settlement: parsed.settlement ?? null,
      finishedAt: parsed.finishedAt ?? null,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
    await storage.put(`job:${id}`, restored);
  } catch {
    // Ignore malformed client cache header.
  }
}
