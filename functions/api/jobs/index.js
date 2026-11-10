// POST /api/jobs — Cloudflare Pages Function.

import { getEngine, readJson, json, errorResponse } from "../_shared.js";

export async function onRequestPost({ request, env }) {
  if (env?.OPTIMIZER) {
    const stub = env.OPTIMIZER.get(env.OPTIMIZER.idFromName("global"));
    return stub.fetch(request);
  }
  try {
    const { engine } = getEngine(env);
    const body = await readJson(request);
    const { job } = await engine.create(body);
    return json(job, 201);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function onRequestGet() {
  return json({ error: "use POST to create a job", kind: "MethodNotAllowed" }, 405);
}
