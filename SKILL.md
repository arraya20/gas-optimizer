---
name: pharos-gas-fee-optimizer
description: Advise whether a Pharos transaction's fee setting is minimal, from measured block headroom rather than a peak.
version: 2.0.0
---

# Pharos Gas Fee Optimizer

## Safety boundary

Read-only advisor. It never signs, never broadcasts, and never asks for a private
key. It answers one question — is this fee setting minimal for this transaction —
and stops there.

## Input

Provide the transaction the caller intends to send:

- `gasLimit` (decimal integer, required);
- `gasUsed`, `maxFeePerGasWei`, `maxPriorityFeePerGasWei` when already decided.

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
