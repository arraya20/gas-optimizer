# gas-fee-optimizer

Measure what a Pharos transaction should pay, from the chain rather than from an
estimate.

```bash
node bin/gas-fee.mjs advise --gas-limit 162849 --gas-used 162849 \
  --max-fee-gwei 22.91779976 --tip-gwei 8.83464938
```

## Why this is not a price-timing tool

The inherited scaffold monitored a gas price, compared it against a target, and
held transactions until the price dropped. It took that price from the caller, so
whoever submitted the request chose the answer.

Two questions had to be answered before building anything:

**Does the gas price move on Pharos?** No. The base fee is 10 gwei in every block
header checked, spanning 8,000,000 blocks, and one value across four disjoint
`eth_feeHistory` windows. Distinct values observed: **1**.

**Is there a queue to bid against?** No. Block gas usage averages 0.000027% of a
1,000,000,000 gas limit; the busiest sampled block used 0.016%. There is roughly
6,000× headroom.

So "wait for a cheaper window" describes an event that does not occur. A tool
that implemented it would delay every transaction forever and call that
optimisation. This repo answers the question that does have an answer:

> the price is fixed, so the only thing you control is **what you set** and
> **how much balance you tie up doing it**.

## What it measures

| Measurement | Source |
|---|---|
| Current base fee | block header |
| Base fee history across disjoint windows | `eth_feeHistory`, 4 windows |
| Block utilisation and headroom | recent block headers |
| What recent transactions actually paid | receipts, `effectiveGasPrice` |
| Share of transactions paying base fee only | receipts |
| Gas limit vs gas used | transaction + receipt |

Nothing is accepted from the caller except a description of the caller's own
transaction. `baseFee`, `gasPrice`, `currentGasGwei`, `verdict`,
`recommendation`, `decision` and `savings` are rejected with HTTP 400 — supplying
one is the exact failure mode the scaffold had.

## Two costs, kept apart

Most fee UIs add these together, which is wrong in both directions.

**Spent** — `gasUsed × min(maxFee, base + tip)`. Money that is gone. A tip is
spent; on a chain where 74% of recent transactions were included paying base fee
only, a tip buys nothing.

**Locked** — `maxFee × gasLimit`. Reserved while the transaction is pending and
refunded after. An inflated maxFee or an inflated gas limit over-reserves; it is
not overspending, and calling it overspending would make the savings look larger
than the money actually at risk.

A median transaction in the sample declared a gas limit 4.3× what it consumed,
which multiplies whatever the maxFee reserves.

## Verdicts

| Verdict | Meaning |
|---|---|
| `ALREADY_MINIMAL` | maxFee sits on the base fee and no tip is set |
| `OVER_LOCKED` | maxFee above base fee with no tip — nothing extra is spent, but balance is tied up |
| `TIP_ABOVE_BASE` | effective price above base with a maxFee that does not over-reserve |
| `OVERPAYING` | both: money spent above base and balance over-reserved |
| `NO_DECLARED_FEE` | no fee setting supplied; the minimum is reported, no verdict invented |
| `UNMEASURABLE` | the base fee could not be read; no advice given |

Exit codes: `0` nothing to fix, `1` actionable, `2` could not measure.

## What it does not measure

Printed in every report, and the list never empties because the numbers looked
good:

- whether a zero-tip transaction **from your address** will be included — the
  sample is evidence about recent senders, not a guarantee for yours
- mempool contents or queue position — this node exposes no pending view
- future base fee — a protocol fee-parameter change invalidates the advice
- per-block tip statistics from `eth_feeHistory` — this node returns
  `reward: null`, so tips are reconstructed from receipts
- **gas units your transaction will use** — gas limit is taken as given; this
  tool does not simulate execution
- complete coverage when blocks or receipts fail to load; the count of failures
  is reported alongside the statistics

## Evidence

`npm run verify:chain` re-derives the claims from raw blocks and receipts without
importing `src/`, so it cannot prove the code agrees with itself. Sample output:

```
pass  one base fee value across 6 block headers spanning 8000000 blocks
      10 gwei at blocks 22141491, 22136491, 22091491, 21641491, 20141491, 14141491
pass  zero-tip transactions get included (81 of 136 successful tx)
      example: 0x275e2fc2…3604 in block 22141488 paid 10 gwei = base fee
pass  a zero-tip and a tipping transaction share a block
      block 22141471: tips present 0 gwei, 0 gwei, 8.1625 gwei
pass  21.54% of all fees paid went above the base fee
pass  91 of 136 transactions set maxFee above the base fee
      locking 0.922452 PROS more than needed across the sample
pass  median gas limit is 4.30x the gas actually used
```

The same-block line is the load-bearing one: two transactions with no tip
included beside one paying 8.16 gwei, so inclusion does not require a tip on this
chain.

## Tests

```bash
npm test            # 46 offline tests: 35 unit + 11 API
npm run test:live   # 13 tests against the real node, shape-only
npm run verify:chain
```

Offline tests use no network and no dependencies. The API tests start a real HTTP
JSON-RPC server on a socket rather than injecting a mock, because the wire format
is the part that breaks.

## Web dashboard

```bash
npx wrangler pages dev public --compatibility-date=2026-01-01
```

The dashboard does not compute a verdict. It posts a transaction description and
renders what `/api/analyze` returns, because a second implementation of the rules
is a second set of rules. The sample window is capped at 60 blocks server-side to
stay inside the worker subrequest budget, and the cap is reported in the response
when it binds.
