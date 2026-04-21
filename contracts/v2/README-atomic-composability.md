# Atomic Composability & the Deposit Buffer

## What changed

Two coupled changes in `sbtc-usdcx-v2.clar`:

1. **`DEPOSIT_MIN_BLOCKS` lowered from `u10` to `u0`.** A cycle can now be
   closed the same block it opened, as long as both sides meet their
   minimum deposit.
2. **`settle`, `settle-with-refresh`, and `close-and-settle-with-refresh`
   return the caller's fill** — a tuple of
   `{ usdcx-cleared, sbtc-received, usdcx-rolled, sbtc-cleared, usdcx-received, sbtc-rolled }` —
   instead of `(ok true)`. The numbers are collected via six
   `caller-*` data-vars that get set inside `distribute-to-*-depositor`
   whenever the iterated depositor matches `tx-sender`, and reset at the
   top of each settle call.

## Why the buffer went to zero

The buffer was originally meant as a "cancel window" so a user could back
out if they changed their mind after depositing. In practice that's
redundant with the **limit price**:

- A USDCx-side depositor sets an upper-bound clearing price. If the
  settlement lands above it, they get rolled, not filled. They never
  pay more than they signed up for.
- An sBTC-side depositor sets a lower-bound clearing price with the same
  protection on the sell side.

So the buffer wasn't protecting users from a bad fill — the limit was.
What the buffer *did* provide was **batch aggregation**: several
depositors on the same side piling into one cycle and sharing a clearing.
But depositors who genuinely want to pool can just wait to trigger
`close-deposits` — the function is permissionless and there's no rule
that says the first eligible caller has to win.

The downside of keeping the buffer is concrete: contracts that want to
compose with jingswap cannot do it in a single transaction. They deposit,
then have to wait wall-clock blocks before anyone can settle. That
breaks atomic flows (treasury ops, arb legs, DCA, intents, loan
repayments routed through jingswap).

## Why "sandwich" concerns don't apply

Clearing price is **oracle-fixed** (Pyth BTC/USD), not pool-determined.
An attacker depositing on the opposite side cannot move anyone's
execution price. The worst they can do is share the clearing pro-rata
within their own limit — which is just "also being a participant."

The standard DeFi sandwich vector (front-run to push price, back-run to
profit from the victim's slippage) does not exist here because there is
no price-impact function to exploit.

## Late joiners

A depositor who shows up after a cycle has already closed simply lands
in the next cycle. No money lost, no bad fill, just latency. It all
works out.

## What the caller-outcome helpers are for

Returning the fill in the response tuple makes jingswap atomically
composable. Another contract can now:

```clarity
(let ((result (try! (contract-call? .sbtc-usdcx-v2 settle-with-refresh ...))))
  ;; result is { usdcx-cleared, sbtc-received, usdcx-rolled,
  ;;             sbtc-cleared, usdcx-received, sbtc-rolled }
  ;; chain into the next leg: swap, repay, re-deposit, etc.
  ...)
```

The six `caller-*` data-vars are a buffer: each `distribute-to-*` pass
writes the matching depositor's numbers into them, and settle reads
them out at the end. They are reset to zero on every settle so a
non-participating caller sees all zeros, and they work correctly for a
caller who deposited on **both** sides (the two distribute fns populate
their respective trio independently).

## Non-changes worth noting

- The `DEPOSIT_MIN_BLOCKS` constant is still there — raising it later is
  a one-line change if product requirements shift.
- `CANCEL_THRESHOLD u42` (the stuck-cycle recovery window for
  `cancel-cycle`) is unchanged. That's a separate concern from the
  batch-open window.
- Cancel is still permissionless for the depositor (`cancel-usdcx-deposit`,
  `cancel-sbtc-deposit`) during PHASE_DEPOSIT. It just can't be used to
  bail out once someone has triggered `close-deposits` in the same
  block — which, given limit-price safety, is a non-issue.
