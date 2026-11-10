// Optimizer: jobs + price history on top of any key/value storage.
//
// `storage` has the Durable Object storage shape (get/put/delete/list), so the
// Durable Object passes its own storage straight in and tests pass a Map-backed
// fake. All time comes from `clock`, so a test can run a 10-minute deadline in
// milliseconds.

import { createJob, tick, cancel, isTerminal, DEFAULTS } from "./scheduler.mjs";
import { appendSample, summarizeHistory } from "./history.mjs";
import { toNumber } from "./rpc.mjs";
import { toBigInt, formatGwei, InputError } from "./numbers.mjs";

export const SAMPLE_EVERY_MS = 60_000;
export const MAX_ACTIVE_JOBS = 100;
export const KEEP_FINISHED_MS = 24 * 3600_000;
const JOB_PREFIX = "job:";
const ID_RE = /^[0-9a-f]{32}$/;

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the API returns: the job without the signed transaction, with readable units. */
export function jobView(job) {
  const { rawTx, ...rest } = job;
  return {
    ...rest,
    hasRawTx: rawTx != null,
    maxFeeGwei: formatGwei(job.tx.maxFeeWei),
    tipGwei: formatGwei(job.tx.tipWei),
    lastBaseFeeGwei: formatGwei(job.lastBaseFeeWei),
    deadlineIso: new Date(job.deadlineAt).toISOString(),
    guarantee:
      "broadcast no later than the deadline regardless of price; inclusion on chain is up to the network",
  };
}

export function createOptimizer({ storage, rpc, clock = Date.now, config = DEFAULTS, newId = randomId }) {
  async function loadJobs() {
    const map = await storage.list({ prefix: JOB_PREFIX });
    return [...map.values()];
  }

  async function sampleHead(now) {
    const meta = (await storage.get("meta")) ?? {};
    if (meta.lastSampleAt != null && now - meta.lastSampleAt < SAMPLE_EVERY_MS) return meta;

    const next = { ...meta, lastSampleAt: now };
    try {
      const block = await rpc.call("eth_getBlockByNumber", ["latest", false]);
      if (!block?.baseFeePerGas) throw new Error("latest block has no baseFeePerGas");
      const samples = appendSample(
        await storage.get("history"),
        { t: now, base: toBigInt(block.baseFeePerGas).toString(), block: toNumber(block.number) },
      );
      await storage.put("history", samples);
      next.lastError = null;
    } catch (err) {
      next.lastError = String(err?.message ?? err).slice(0, 200);
      next.failedSamples = (meta.failedSamples ?? 0) + 1;
    }
    await storage.put("meta", next);
    return next;
  }

  return {
    async create(body) {
      const now = clock();
      const active = (await loadJobs()).filter((j) => !isTerminal(j)).length;
      if (active >= MAX_ACTIVE_JOBS) {
        throw new InputError(`too many jobs are holding (${MAX_ACTIVE_JOBS}); try again after some finish`, "capacity");
      }
      const job = await createJob({ rpc, body, now, id: newId(), config });
      await storage.put(JOB_PREFIX + job.id, job);
      return { job: jobView(job), nextWakeAt: job.nextWakeAt };
    },

    async get(id) {
      if (!ID_RE.test(id)) return null;
      const job = await storage.get(JOB_PREFIX + id);
      return job ? jobView(job) : null;
    },

    async cancel(id) {
      if (!ID_RE.test(id)) return null;
      const job = await storage.get(JOB_PREFIX + id);
      if (!job) return null;
      const r = cancel(job, clock());
      if (!r.ok) return { ok: false, reason: r.reason, job: jobView(job) };
      await storage.put(JOB_PREFIX + id, r.job);
      return { ok: true, job: jobView(r.job) };
    },

    async history() {
      const samples = (await storage.get("history")) ?? [];
      const meta = (await storage.get("meta")) ?? {};
      const s = summarizeHistory(samples);
      return {
        samples,
        summary: {
          ...s,
          minGwei: s.minWei && formatGwei(s.minWei),
          maxGwei: s.maxWei && formatGwei(s.maxWei),
          latestGwei: s.latestWei && formatGwei(s.latestWei),
        },
        sampling: {
          everyMs: SAMPLE_EVERY_MS,
          lastSampleAt: meta.lastSampleAt ?? null,
          failedSamples: meta.failedSamples ?? 0,
          lastError: meta.lastError ?? null,
        },
        note:
          s.moved === false
            ? "the base fee did not change across every sample: a flat line is the measurement, not a missing chart"
            : s.moved === true
              ? "the base fee changed within the sampled period"
              : "not enough samples yet to say whether the base fee moves",
      };
    },

    /**
     * Alarm handler: take a price sample if one is due, advance every job whose
     * wake time has come, prune old finished jobs. Returns when to wake next.
     */
    async runDue() {
      const now = clock();
      const meta = await sampleHead(now);
      let wake = (meta.lastSampleAt ?? now) + SAMPLE_EVERY_MS;

      for (const job of await loadJobs()) {
        if (isTerminal(job)) {
          if (job.finishedAt != null && now - job.finishedAt > KEEP_FINISHED_MS) {
            await storage.delete(JOB_PREFIX + job.id);
          }
          continue;
        }
        let current = job;
        if (current.nextWakeAt != null && current.nextWakeAt <= now) {
          try {
            current = await tick(job, { rpc, now, config });
          } catch (err) {
            // One broken job must not stop the others, and must not hot-loop.
            current = structuredClone(job);
            current.lastError = String(err?.message ?? err).slice(0, 300);
            current.nextWakeAt = now + config.retryMs;
          }
          await storage.put(JOB_PREFIX + job.id, current);
        }
        if (current.nextWakeAt != null) wake = Math.min(wake, current.nextWakeAt);
      }
      return { nextWakeAt: wake };
    },
  };
}
