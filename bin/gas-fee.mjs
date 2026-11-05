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

function parseArgs(argv) {
  const opts = { json: false, sample: 250, rpc: undefined, command: "advise", tx: {} };
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

Options
  --gas-limit N        gas limit the transaction will declare (required)
  --gas-used M         gas you expect to consume (defaults to the limit)
  --max-fee-gwei X     the fee you were about to set; decimals allowed (11.25)
  --tip-gwei Y         the priority fee you were about to set
  --sample BLOCKS      how many recent blocks to inspect (default 250)
  --rpc URL            override the Pharos endpoint
  --json               machine-readable output

Exit codes
  0 already minimal   1 overpaying / over-locking   2 could not measure
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

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
