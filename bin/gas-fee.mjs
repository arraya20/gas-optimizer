#!/usr/bin/env node
// CLI entry point.
//
// Exit codes are part of the contract:
//   0  nothing to fix — the fee setting is already minimal
//   1  actionable — the transaction is overpaying or over-locking
//   2  unmeasurable — the chain could not be read; no advice is given

import { createRpc } from "../src/rpc.mjs";
import { validateRequest, analyze } from "../src/analyze.mjs";
import { renderReport } from "../src/report.mjs";
import { InputError } from "../src/numbers.mjs";
import { RpcError } from "../src/rpc.mjs";
import { createJob, tick, isTerminal, DEFAULTS } from "../src/scheduler.mjs";
import { readFileSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { json: false, sample: 250, rpc: undefined, command: "advise", tx: {}, hold: {}, pollMs: undefined };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith("-")) opts.command = rest.shift();

  const takeValue = (name) => {
    const v = rest.shift();
    if (v === undefined) throw new InputError(`${name} needs a value`, name);
    return v;
  };

  while (rest.length) {
    const arg = rest.shift();
    switch (arg) {
      case "--json": opts.json = true; break;
      case "--gas-limit": opts.tx.gasLimit = takeValue("--gas-limit"); break;
      case "--gas-used": opts.tx.gasUsed = takeValue("--gas-used"); break;
      case "--max-fee-gwei": opts.tx.maxFeeGwei = takeValue("--max-fee-gwei"); break;
      case "--tip-gwei": opts.tx.tipGwei = takeValue("--tip-gwei"); break;
      case "--sample": opts.sample = Number(takeValue("--sample")); break;
      case "--raw-tx": opts.hold.rawTx = takeValue("--raw-tx"); break;
      case "--raw-tx-file": opts.hold.rawTx = readFileSync(takeValue("--raw-tx-file"), "utf8").trim(); break;
      case "--deadline-minutes": opts.hold.deadlineMinutes = takeValue("--deadline-minutes"); break;
      case "--deadline-seconds": opts.hold.deadlineSeconds = takeValue("--deadline-seconds"); break;
      case "--target-gwei": opts.hold.targetBaseFeeGwei = takeValue("--target-gwei"); break;
      case "--dry-run": opts.hold.dryRun = true; break;
      case "--poll-seconds": opts.pollMs = Number(takeValue("--poll-seconds")) * 1000; break;
      case "--rpc": opts.rpc = takeValue("--rpc"); break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new InputError(`unknown argument: ${arg}`, arg);
    }
  }
  return opts;
}

const HELP = `gas-fee — measure what a Pharos transaction should pay

  gas-fee advise --gas-limit N [--gas-used M]
                 [--max-fee-gwei X] [--tip-gwei Y]
  gas-fee scan [--sample BLOCKS]
  gas-fee hold --raw-tx 0x… | --raw-tx-file PATH
               (--deadline-minutes N | --deadline-seconds N)
               [--target-gwei X] [--poll-seconds S] [--dry-run]

Options
  --gas-limit N        gas limit the transaction will declare (required)
  --gas-used M         gas you expect to consume (defaults to the limit)
  --max-fee-gwei X     the fee you were about to set; decimals allowed (11.25)
  --tip-gwei Y         the priority fee you were about to set
  --sample BLOCKS      how many recent blocks to inspect (default 250)
  --rpc URL            override the Pharos endpoint
  --json               machine-readable output

hold: sign the transaction elsewhere (cast, ethers, a wallet) and pass the signed
bytes. This tool never sees a key. It holds the transaction until the base fee is
at or below --target-gwei (default: the base fee right now) and broadcasts it no
later than the deadline, then reports gas actually paid against the request-time
price. --dry-run broadcasts nothing and reports worst-case figures only.

Exit codes
  advise/scan: 0 already minimal   1 overpaying / over-locking   2 could not measure
  hold:        0 settled or simulated   1 failed, reverted or unconfirmed   2 bad input
`;

async function hold(opts) {
  const rpc = createRpc({ url: opts.rpc });
  const config = { ...DEFAULTS, ...(opts.pollMs ? { pollMs: opts.pollMs } : {}) };
  const startedAt = Date.now();
  let job = await createJob({ rpc, body: opts.hold, now: startedAt, id: "cli".padEnd(32, "0"), config });

  const seen = new Set();
  const flush = () => {
    for (const e of job.events) {
      const key = `${e.at}:${e.type}:${e.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`${new Date(e.at).toISOString()}  ${e.type.padEnd(11)} ${e.message}`);
    }
  };

  console.log(`tx ${job.tx.hash}`);
  console.log(`price at request time: ${job.quote.pricePerGasGwei} gwei (base fee ${job.quote.baseFeeGwei})`);
  for (const w of job.warnings) console.log(`warning: ${w}`);
  flush();

  while (!isTerminal(job)) {
    const wait = Math.max(0, (job.nextWakeAt ?? Date.now()) - Date.now());
    await sleep(wait);
    job = await tick(job, { rpc, now: Date.now(), config });
    flush();
  }

  const s = job.settlement;
  console.log("");
  console.log(`status       ${job.status}`);
  if (job.submit?.reason) console.log(`submitted by ${job.submit.reason}${job.submit.late ? " (late)" : ""}`);
  if (s?.simulated) {
    console.log(`simulated    worst case ${s.worstCasePROS} PROS at ${s.pricePerGasGwei} gwei (request-time quote ${s.quotedWorstCasePROS})`);
  } else if (s) {
    console.log(`paid         ${s.paidPROS} PROS  (${s.gasUsed} gas at ${s.effectiveGasPriceGwei} gwei)`);
    console.log(`request-time ${s.quotedCostPROS} PROS  (same gas at ${s.quotedPricePerGasGwei} gwei)`);
    console.log(`result       ${s.outcome} ${s.differencePROS} PROS${s.differencePct ? ` (${s.differencePct}%)` : ""}`);
  }
  if (opts.json) console.log(JSON.stringify(job, null, 2));
  return job.status === "SETTLED" || job.status === "SIMULATED" ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  if (opts.command === "hold") return hold(opts);

  const rpc = createRpc({ url: opts.rpc });

  // `scan` needs a gas limit too, but only to size the worked example.
  const request = validateRequest(
    opts.command === "scan" ? { gasLimit: opts.tx.gasLimit ?? 21000 } : opts.tx,
  );

  const report = await analyze({ rpc, request, sampleBlocks: opts.sample });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }

  const verdict = report.advice.verdict;
  if (verdict === "UNMEASURABLE") return 2;
  if (["OVERPAYING", "TIP_ABOVE_BASE", "OVER_LOCKED"].includes(verdict)) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const known = err instanceof InputError || err instanceof RpcError;
    console.error(`${known ? err.name : "error"}: ${err.message}`);
    if (err instanceof InputError && err.field) console.error(`  field: ${err.field}`);
    process.exit(2);
  });
