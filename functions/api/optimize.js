import { evaluateSubmissionTiming, analyzeGasTrend } from "../../src/optimizer.mjs";

export async function onRequestPost({ request }) {
  const body = await request.json();
  const decision = evaluateSubmissionTiming(body);
  return new Response(JSON.stringify({ success: true, decision }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
