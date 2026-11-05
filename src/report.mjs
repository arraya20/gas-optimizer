// Human-readable rendering. No colour codes, no box drawing: this is read in a
// terminal next to numbers that matter, and the numbers should be the loud part.

import { formatGwei, formatPROS, groupDigits } from "./numbers.mjs";

const line = (s = "") => s;

export function renderReport(report) {
  const out = [];
  const { chain, market, sample, waiting, advice, notMeasured } = report;

  out.push(line(`chain        ${chain.name} (${chain.id}), head ${groupDigits(chain.head)}`));
  out.push(line(""));

  out.push(line("fee market"));
  out.push(line(`  base fee     ${market.baseFeeGwei ?? "unreadable"} gwei`));
  out.push(
    line(
      `  history      ${market.distinctCount} distinct value(s) over ${groupDigits(
        market.blocksObserved,
      )} blocks in ${market.windows.length} windows${market.frozen ? " — never moved" : ""}`,
    ),
  );
  out.push(
    line(
      `  capacity     ${market.capacity.aggregateUtilisationPct ?? "n/a"}% of total gas capacity over ${groupDigits(
        market.capacity.blocksSampled,
      )} blocks`,
    ),
  );
  out.push(
    line(
      `               ${groupDigits(market.capacity.emptyCount)} of them used no gas; busiest used ${pct(
        market.capacity.peakUtilisation,
        3,
      )} (block ${market.capacity.peakBlock ?? "—"})`,
    ),
  );
  out.push(
    line(
      `               ${
        market.capacity.headroomAtLeastX
          ? `at least ${groupDigits(market.capacity.headroomAtLeastX)}x spare capacity`
          : market.capacity.aggregateUtilisation === 0
            ? "no gas used at all in the sampled blocks"
            : "headroom below an order of magnitude"
      } — queue state: ${market.capacity.congestion}`,
    ),
  );
  out.push(
    line(
      `  waiting      ${
        waiting.canHelp === false
          ? "cannot lower the fee — the price is flat and blocks are empty"
          : waiting.canHelp === true
            ? "a cheaper window exists in the measured history"
            : "unproven"
      }`,
    ),
  );
  for (const reason of waiting.reasons) out.push(line(`               · ${reason}`));
  out.push(line(""));

  out.push(
    line(
      `sample       ${groupDigits(sample.window.blocksRequested)} blocks over ${groupDigits(
        sample.window.spanBlocks,
      )} → ${sample.blocksWithTransactions} with transactions`,
    ),
  );
  if (sample.transactions > 0) {
    out.push(
      line(
        `  payments     ${sample.transactions} successful tx: ${sample.zeroTipShare}% paid base fee only, median tip ${
          sample.medianPositiveTipGwei ?? "none"
        } gwei when they paid one`,
      ),
    );
    out.push(
      line(
        `  waste        ${sample.tipShareOfFees}% of all fees were paid above base; ${formatPROS(
          sample.lockExtraWei,
        )} PROS of balance was locked above what the base fee requires`,
      ),
    );
    out.push(line(`  gas limits   median limit is ${sample.medianGasLimitOverGasUsed}x the gas actually used`));
  } else {
    out.push(line("  payments     no successful transaction in the sampled window"));
  }
  out.push(line(""));

  out.push(line(`verdict      ${advice.verdict}`));
  for (const reason of advice.reasons) out.push(line(`  · ${reason}`));
  if (advice.recommended) {
    out.push(
      line(
        `  set maxFee ${advice.recommended.maxFeeGwei} gwei, tip 0 → costs ${advice.recommended.paidPROS} PROS, locks ${advice.recommended.lockedPROS} PROS`,
      ),
    );
  }
  if (advice.declared) {
    out.push(
      line(
        `  declared      costs ${advice.declared.paidPROS} PROS, locks ${advice.declared.lockedPROS} PROS`,
      ),
    );
    if (advice.declared.paidWei !== advice.recommended.paidWei) {
      out.push(line(`  spent saving  ${advice.spentSavingPROS} PROS (gone, not refunded)`));
    }
    if (advice.declared.lockedWei !== advice.recommended.lockedWei) {
      out.push(line(`  lock saving   ${advice.lockSavingPROS} PROS (refunded after, unavailable while pending)`));
    }
  }
  out.push(line(""));

  out.push(line(`not measured (${notMeasured.length})`));
  for (const item of notMeasured) out.push(line(`  - ${wrap(item, 74, "    ")}`));

  return out.join("\n");
}

const pct = (v, digits = 3) => (v == null ? "n/a" : `${(v * 100).toFixed(digits)}%`);

function wrap(text, width, indent) {
  const words = text.split(/\s+/);
  const rows = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > width && cur !== "") {
      rows.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) rows.push(cur);
  return rows.join(`\n${indent}`);
}
