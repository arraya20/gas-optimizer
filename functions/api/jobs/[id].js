// GET / DELETE /api/jobs/:id — Cloudflare Pages Function.

import { getEngine, rehydrateJobIfMissing, json, errorResponse } from "../_shared.js";

export async function onRequestGet({ request, env, params }) {
  if (env?.OPTIMIZER) {
    const stub = env.OPTIMIZER.get(env.OPTIMIZER.idFromName("global"));
    return stub.fetch(request);
  }
  try {
    const id = String(params?.id ?? "");
    const { storage, engine } = getEngine(env);
    await rehydrateJobIfMissing(storage, id, request);
    await engine.runDue();
    const job = await engine.get(id);
    return job ? json(job) : json({ error: "no such job", kind: "NotFound" }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function onRequestDelete({ request, env, params }) {
  if (env?.OPTIMIZER) {
    const stub = env.OPTIMIZER.get(env.OPTIMIZER.idFromName("global"));
    return stub.fetch(request);
  }
  try {
    const id = String(params?.id ?? "");
    const { storage, engine } = getEngine(env);
    await rehydrateJobIfMissing(storage, id, request);
    const r = await engine.cancel(id);
    if (!r) return json({ error: "no such job", kind: "NotFound" }, 404);
    return r.ok ? json(r.job) : json({ error: r.reason, kind: "Conflict", job: r.job }, 409);
  } catch (err) {
    return errorResponse(err);
  }
}
