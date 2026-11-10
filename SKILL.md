---
name: pharos-gas-fee-optimizer
description: Advise whether a Pharos transaction's fee setting is minimal, from measured block headroom rather than a peak.
version: 2.0.0
---

# Pharos Gas Fee Optimizer

## Safety boundary

Two modes.

- **Advise** (`/api/analyze`, `gas-fee advise`): read-only. Answers whether a fee
  setting is minimal and stops there.
- **Hold** (`/api/jobs`, `gas-fee hold`): relays a transaction the caller already
  signed. It never signs, never holds or asks for a private key (`privateKey`,
  `mnemonic`, `seed` are rejected), and refuses a transaction signed for another
  chain. The only thing it ever broadcasts is the caller's own signed bytes, at the
  time the caller's deadline and target dictate.

The signed transaction is never returned by the API and is dropped from storage
once the job stops holding. The 128-bit job id is the only credential.

## Hold procedure

1. Validate: `rawTx` + exactly one deadline form (`deadlineAt`, `deadlineMinutes`,
   `deadlineSeconds`), optional `targetBaseFeeGwei`, optional `dryRun`. Reject
   market fields and conclusions (`baseFee`, `gasPrice`, `quotedPrice`, `verdict`,
   `savings`, `status`). Deadline must be 30 s to 7 days away.
2. Decode the signed transaction (legacy, type 1, type 2); check chain id; record
   the price at request time from the latest block.
3. Poll the base fee. Broadcast when it is at or below the target (`FAVORABLE`), or
   at `deadline - 20 s` at any price (`DEADLINE`). Retry transient failures; look the
   hash up before resending.
4. On the receipt, report gas actually paid against the same gas at the request-time
   price: `SAVED`, `EXTRA` or `SAME`.

The deadline guarantees broadcast, not inclusion. Report `FAILED`, `late` and
`UNCONFIRMED` as they are; never invent a hash or a paid figure. `dryRun` reports
worst-case figures only and says so.

CLI hold exit codes: `0` settled or simulated, `1` failed / reverted / unconfirmed,
`2` bad input. History: `GET /api/history`, sampled every 60 s by a Durable Object
alarm; `moved` is computed from the samples.

## Input

Provide the transaction the caller intends to send:

- `gasLimit` (decimal integer, required);
- `gasUsed` (optional decimal integer);
- the fee ceiling as `maxFeeGwei` or `maxFeeWei`;
- the priority tip as `tipGwei`, `maxPriorityFeeGwei`, or `tipWei`.

The caller may **not** supply `baseFee`, `gasPrice`, `verdict` or
`recommendation`. Those are market observations and conclusions produced here; a
caller that supplies them is a caller asking to be agreed with. `validateRequest`
rejects them with `400` and names the field.

## Procedure

1. Reject fee and verdict fields supplied by the caller (`validateRequest`).
2. Sample block headers on a stride of 800 blocks: 60 samples over HTTP
   (`?sample=` capped at 60, ~47k blocks), 250 by CLI. The window is bounded by
   the worker subrequest budget, and the cap is reported in `limits`, never
   applied silently.
3. Compute capacity from the headers already in hand (`capacityFromBlocks`) —
   a pure function of those blocks, not a second fetch.
4. Band headroom to a power of ten (`headroomBand`). The leading digits of a
   utilisation ratio are noise: a ratio of 13,599x becomes 10,000x and stays put
   between renders, where the raw ratio moved on every sample.
5. Read the current base fee, derive the minimal fee (`minimalFees` =
   base fee + buffer + tip), and project cost (`projectCost`) at the caller's
   `gasLimit`.
6. Report the comparison. Nothing is executed.

## Output requirement

Report base fee, minimal max fee, projected cost, the sampled window, the headroom
band, and the verdict. Wei values are exact integers carried as `BigInt`; do not
pass a quantity through JavaScript `Number`.

CLI exit codes are part of the contract: `0` nothing to fix, `1` actionable
(overpaying or over-locking), `2` unmeasurable — the chain could not be read, so
no advice is given.
