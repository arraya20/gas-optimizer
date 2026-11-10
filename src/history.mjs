// Base-fee history kept by the agent itself.
//
// A snapshot says nothing about "over time". The Durable Object samples the
// chain head on a timer and appends here; the dashboard reads it back. On a
// chain whose base fee never moves this is a flat line, and it is shown as a
// flat line: `moved` is computed from the samples, never assumed.

import { toBigInt } from "./numbers.mjs";

export const HISTORY_CAP = 720; // 12 hours at one sample a minute; stays far below the 128 KiB value limit

/** Append one sample, newest last, dropping the oldest beyond `cap`. Pure. */
export function appendSample(samples, sample, cap = HISTORY_CAP) {
  const next = [...(samples ?? []), { t: sample.t, base: toBigInt(sample.base, "base").toString(), block: sample.block ?? null }];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Facts derivable from the samples alone. */
export function summarizeHistory(samples) {
  const rows = samples ?? [];
  if (rows.length === 0) {
    return { count: 0, firstAt: null, lastAt: null, minWei: null, maxWei: null, latestWei: null, distinct: 0, moved: null };
  }
  let min = toBigInt(rows[0].base);
  let max = min;
  const seen = new Set();
  for (const r of rows) {
    const v = toBigInt(r.base);
    seen.add(v.toString());
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    count: rows.length,
    firstAt: rows[0].t,
    lastAt: rows[rows.length - 1].t,
    minWei: min.toString(),
    maxWei: max.toString(),
    latestWei: rows[rows.length - 1].base,
    distinct: seen.size,
    // One sample cannot show movement, so a single point is "unknown", not "flat".
    moved: rows.length < 2 ? null : seen.size > 1,
  };
}
