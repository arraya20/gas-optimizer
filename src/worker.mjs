// Worker entry: routes the API, serves static assets, hosts the Durable Object.
//
// One Durable Object instance owns all jobs and the price history. It holds the
// alarm, which is what makes the deadline reliable: an alarm fires whether or
// not anyone has the dashboard open, and a Pages Function cannot do that.

import { onRequestPost as analyzePost } from "../functions/api/analyze.js";
import { createRpc, RpcError } from "./rpc.mjs";
import { createOptimizer } from "./optimizer.mjs";
import { InputError } from "./numbers.mjs";

const MAX_BODY_BYTES = 16 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function errorResponse(err) {
  if (err instanceof InputError) return json({ error: err.message, kind: "InputError", field: err.field ?? null }, 400);
  if (err instanceof RpcError) return json({ error: err.message, kind: "RpcError", method: err.method ?? null }, 502);
  return json({ error: err?.message ?? "unexpected failure", kind: "Error" }, 500);
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new InputError(`body is larger than ${MAX_BODY_BYTES} bytes`, "body");
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("body must be JSON", "body");
  }
}

export class Optimizer {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.engine = createOptimizer({
      storage: state.storage,
      rpc: deps.rpc ?? createRpc({ url: env?.PHAROS_RPC || undefined, retries: 1, timeoutMs: 12000 }),
      clock: deps.clock ?? Date.now,
    });
    this.clock = deps.clock ?? Date.now;
  }

  /** Keep the earliest of the existing alarm and `at`; never schedule in the past. */
  async wakeBy(at) {
    const floor = this.clock() + 1000;
    const target = Math.max(at, floor);
    const existing = await this.state.storage.getAlarm();
    if (existing == null || target < existing) await this.state.storage.setAlarm(target);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // Sampling must start on first contact even if nobody ever submits a job.
      await this.wakeBy(this.clock() + 1000);

      if (path === "/api/history" && request.method === "GET") {
        return json(await this.engine.history());
      }
      if (path === "/api/jobs" && request.method === "POST") {
        const { job, nextWakeAt } = await this.engine.create(await readJson(request));
        await this.wakeBy(nextWakeAt);
        return json(job, 201);
      }
      const m = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (m && request.method === "GET") {
        const job = await this.engine.get(m[1]);
        return job ? json(job) : json({ error: "no such job", kind: "NotFound" }, 404);
      }
      if (m && request.method === "DELETE") {
        const r = await this.engine.cancel(m[1]);
        if (!r) return json({ error: "no such job", kind: "NotFound" }, 404);
        return r.ok ? json(r.job) : json({ error: r.reason, kind: "Conflict", job: r.job }, 409);
      }
      return json({ error: "not found", kind: "NotFound" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  }

  async alarm() {
    const { nextWakeAt } = await this.engine.runDue();
    await this.state.storage.deleteAlarm();
    await this.wakeBy(nextWakeAt);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/analyze") {
      return request.method === "POST"
        ? analyzePost({ request, env })
        : json({ error: "use POST with a transaction description" }, 405);
    }
    if (pathname === "/api/history" || pathname === "/api/jobs" || pathname.startsWith("/api/jobs/")) {
      const stub = env.OPTIMIZER.get(env.OPTIMIZER.idFromName("global"));
      return stub.fetch(request);
    }
    if (pathname.startsWith("/api/")) return json({ error: "not found", kind: "NotFound" }, 404);
    return env.ASSETS.fetch(request);
  },
};
