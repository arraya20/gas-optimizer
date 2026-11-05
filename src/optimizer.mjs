// Gas Fee Monitor & Timing Scheduler
export function analyzeGasTrend(history) {
  if (!history || history.length === 0) return { averageGwei: "0", minGwei: "0", maxGwei: "0", recommendation: "NEUTRAL" };

  const values = history.map(h => Number(h.gasPriceGwei || h));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const latest = values[values.length - 1];

  let recommendation = "NORMAL";
  if (latest <= min * 1.1) recommendation = "OPTIMAL_LOW_GAS";
  else if (latest >= max * 0.9) recommendation = "SPIKE_WAIT";

  return {
    latestGwei: latest.toFixed(2),
    averageGwei: avg.toFixed(2),
    minGwei: min.toFixed(2),
    maxGwei: max.toFixed(2),
    recommendation
  };
}

export function evaluateSubmissionTiming({ currentGasGwei, targetMaxGasGwei, deadlineTimestamp, now = Date.now() }) {
  const current = Number(currentGasGwei);
  const target = Number(targetMaxGasGwei);

  if (current <= target) {
    return { shouldExecute: true, reason: `Current gas (${current} Gwei) is below or equal to target (${target} Gwei).` };
  }

  if (now >= deadlineTimestamp) {
    return { shouldExecute: true, reason: `Deadline reached. Executing despite higher gas (${current} Gwei).` };
  }

  return {
    shouldExecute: false,
    reason: `Current gas (${current} Gwei) exceeds target (${target} Gwei). Holding until lower fee or deadline.`
  };
}
