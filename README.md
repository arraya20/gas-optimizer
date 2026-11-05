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

**Is there a queue to bid against?** No. Aggregate gas demand was 0.0048% of total
capacity across 200 blocks spanning 199,000 blocks; 144 of those blocks used no gas
at all, and the busiest single block was 0.049% full. Spare capacity is at least
**10,000×**.

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
| Aggregate gas demand and empty blocks | block headers, strided sample |
| What recent transactions actually paid | receipts, `effectiveGasPrice` |
| Share of transactions paying base fee only | receipts |
| Gas limit vs gas used | transaction + receipt |

Nothing is accepted from the caller except a description of the caller's own
transaction. `baseFee`, `gasPrice`, `currentGasGwei`, `verdict`,
`recommendation`, `decision` and `savings` are rejected with HTTP 400 — supplying
one is the exact failure mode the scaffold had.

## Why spare capacity is banded

The first version of this figure was `round(1 / peak)` over 32 consecutive blocks.
It is the kind of number that looks rigorous and is not. Rendered against this
chain at different moments it read **2,071×, 4,059×, 4,921×, 6,141×** and once
**359×** — the same claim, quoted to four digits, wrong by up to 17×, because a
peak is a single block and one busy block moves it.

Two changes, in this order:

1. **Measure demand, not the peak.** Aggregate demand is `Σ gasUsed / Σ gasLimit`
   over the sampled blocks. It is a mean, so it converges as the sample grows
   instead of jumping on one observation. The peak is still reported, with the
   block number it came from, so the claim stays checkable.
2. **Band the derived figure to a power of ten.** `1/aggregate` is a ratio of two
   tiny numbers; its leading digits are noise. Printing `13,599×` claims an
   accuracy the sample does not have. Both 13,599 and 22,153 now read
   **"at least 10,000×"**, which is true for both and stable between renders.

The empty-block count is reported separately, because *"144 of 200 blocks used no
gas at all"* is a direct observation, and it is the load-bearing fact behind
"there is no queue". It needs no extrapolation.

When nothing was used, the percentage is 0 and no multiplier is printed. The old
code returned `null` there and the dashboard rendered `n/a` — the emptiest
possible chain reading as "unknown", the worst available reading.

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
npm test            # 56 offline tests: 44 unit + 12 API
npm run test:live   # 15 tests against the real node, shape-only
npm run verify:chain  # 10 checks re-derived from raw blocks, no src/ imports
```

One of the live tests exists purely to catch the regression above: it samples two
independent strided windows and requires them to agree on the headroom band, not
on the digits. A figure that moves by 17× between renders passes no honest test.

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

Blocks are sampled at a stride rather than contiguously. This chain produces a
transaction every few hundred blocks, so 60 consecutive blocks is one short burst
of activity dressed up as a sample. 60 headers at a stride of 800 covers about
47,000 blocks for the same number of requests.
