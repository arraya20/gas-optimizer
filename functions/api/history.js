// GET /api/history — Cloudflare Pages Function.

import { getEngine, seedHistoryIfNeeded, json, errorResponse } from "./_shared.js";

export async function onRequestGet({ request, env }) {
  if (env?.OPTIMIZER) {
    const stub = env.OPTIMIZER.get(env.OPTIMIZER.idFromName("global"));
    return stub.fetch(request);
  }
  try {
    const { storage, rpc, engine } = getEngine(env);
    await seedHistoryIfNeeded(storage, rpc);
    await engine.runDue();
    return json(await engine.history());
  } catch (err) {
    return errorResponse(err);
  }
}
