# Jing Loan Reserve + SNPL System

Two-contract setup for swap-now-pay-later (snpl) loans that draw against
a pooled sBTC reserve and execute on Jing v2 auctions.

## Contracts

- `loan-reserve.clar` — pooled sBTC funding layer, holds credit lines
  per snpl with cap-sbtc, interest-bps, outstanding-sbtc.
- `loan-sbtc-stx-0-jing.clar` — per-borrower snpl specialized for
  `sbtc-stx-0-jing-v2`. Draws once from reserve, swap-deposits on Jing,
  repays or gets seized after deadline.
- `snpl-trait.clar` — minimal interface (`get-borrower`) used by the
  reserve at credit-line opening to verify the snpl's configured
  borrower matches the principal the lender intended.

## Post-POC follow-ups

These were considered during the POC build but deferred to keep the
first version simple. Track them as upgrades for v2.

### 1. `BORROWER` as a one-time-settable var (instead of a constant)

**Today:** every snpl deployment hardcodes `BORROWER` as a constant, so
the bytecode hash differs per borrower. The lender must verify each
deployment's hash separately before opening a credit line.

**Proposed:** make `borrower` a `(define-data-var ... (optional principal) none)`,
captured `(define-constant DEPLOYER tx-sender)`, and add a one-time
`set-borrower` callable only by the DEPLOYER (errors if already set).
Source code becomes canonical across deployments — the lender verifies
**one** snpl source hash, and every snpl deployed from it is interchangeable
at the bytecode level. The trait check at `open-credit-line` already
verifies the post-init borrower matches what the lender intended.

Lifecycle: deploy snpl → deployer calls `set-borrower(P)` → lender opens
credit line for `P` (asserts via `get-borrower`).

Net win: lender audit goes from O(N) deployments to O(1) source.

### 2. `RESERVE` as a var (instead of a constant) → multi-reserve snpls

**Today:** `(define-constant RESERVE .loan-reserve)` ties each snpl to one
specific reserve at compile time. To swap reserves, deploy a new snpl.

**Proposed:** make `reserve` a `(define-data-var ... (optional principal) none)`
(or a list of approved reserves), settable by the DEPLOYER post-deploy
or by some governance path. Combined with #1, snpls become fully
generic: same bytecode, same source, parameterized at runtime for
borrower + reserve.

Open questions:
- Should an snpl be allowed to draw from *multiple* reserves (one
  active loan from reserve A, next from reserve B)? Or pinned to one
  at a time?
- How to handle in-flight loans when switching reserves (probably
  forbid switch while `active-loan` is some)?
- Trait shape — likely a `reserve-trait` with `draw` and
  `notify-return` signatures so any reserve implementation can plug in.

This unlocks competitive lending: the same borrower's snpl could shop
for the best rate by switching reserves between loans.

### 3. Underflow assertion in `notify-return`

Removed in the POC because Clarity's uint subtraction panics on
underflow anyway. If a future change introduces multiple in-flight
loans per snpl (or any path where outstanding could drift below
notional), reinstate `(asserts! (<= notional current) ERR-UNDERFLOW)`.

### 4. Permissionless withdraws

`withdraw-sbtc` and `withdraw-stx` on the reserve are permissionless
because funds always flow to the hardcoded LENDER (no theft). The DoS
angle: anyone can drain the reserve to LENDER's EOA, forcing a
re-`supply` before snpls can draw. Fine for POC; if it gets griefed
in production, re-add the LENDER-only assert.
