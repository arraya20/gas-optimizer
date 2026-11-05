import assert from "node:assert";
import { analyzeGasTrend, evaluateSubmissionTiming } from "../src/optimizer.mjs";

console.log("Running Gas Fee Optimizer tests...");

// Test 1: Trend analysis
const history = [12.5, 14.0, 11.2, 10.0, 10.5];
const trend = analyzeGasTrend(history);
assert.strictEqual(trend.recommendation, "OPTIMAL_LOW_GAS");

// Test 2: Submission Timing (Holding)
const hold = evaluateSubmissionTiming({ currentGasGwei: "25", targetMaxGasGwei: "15", deadlineTimestamp: Date.now() + 100000 });
assert.strictEqual(hold.shouldExecute, false);

// Test 3: Submission Timing (Deadline reached)
const expired = evaluateSubmissionTiming({ currentGasGwei: "25", targetMaxGasGwei: "15", deadlineTimestamp: Date.now() - 1000 });
assert.strictEqual(expired.shouldExecute, true);

console.log("✅ All Gas Fee Optimizer tests passed successfully!");
