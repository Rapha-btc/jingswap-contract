# V2 Settlement Edge Cases

## Limit Filter Can Cause Settlement Failure

### The Flow

`close-and-settle-with-refresh` does two things atomically:

1. **close-deposits** — applies small-share filter (rolls deposits < 0.2% of side total), checks minimum deposits on both sides
2. **settle-with-refresh** — fetches fresh oracle price, then:
   - Computes clearing price (oracle +/- premium)
   - Runs `filter-limit-violating-stx-depositor` on every STX depositor
   - Runs `filter-limit-violating-sbtc-depositor` on every sBTC depositor
   - Each violating depositor is removed from the current cycle, their amount decremented from `cycle-totals`, and rolled to the next cycle
   - Reads the **updated** `cycle-totals`
   - Asserts both sides still meet minimum deposit (`ERR_NOTHING_TO_SETTLE`)

### The Edge Case

If depositors set tight limit prices that don't match the clearing price, the limit filter removes them. If enough are removed, a side drops below the minimum and `execute-settlement` fails with `ERR_NOTHING_TO_SETTLE`.

**Example:** 3 STX depositors totaling 50 STX, but all set limits at 350 sats/STX. Oracle settles at 300 sats/STX. All 3 are rolled (clearing price in STX/BTC exceeds their limit). STX side drops to 0. Settlement fails.

### Why This Is Safe

**Bundled call (frontend path):** The frontend only exposes `close-and-settle-with-refresh`. Since both operations are wrapped in `try!`, if `settle-with-refresh` fails, the entire transaction reverts. Deposits stay open, nothing changes on-chain. The user just pays a failed tx fee.

**Separate calls (direct contract interaction):** If someone calls `close-deposits` separately and then `settle` fails, the cycle is stuck in SETTLE phase. After `CANCEL_THRESHOLD` (42 blocks, ~84 seconds), anyone can call `cancel-cycle` which rolls all deposits to the next cycle. No funds are stranded.

### Frontend Mitigation

To avoid wasting tx fees on doomed settlements:

1. **Off-chain prediction:** Before the user clicks Settle, the frontend reads all depositors and their limit prices from the backend, simulates the limit filter against the current oracle price, and computes the projected post-filter totals.

2. **Warning:** If the predicted totals drop below minimum on either side, the Settle button shows a warning instead of broadcasting: e.g. "Not enough volume clears at current price — limits are too spread apart."

3. **Projected clearing display:** The auction page shows the projected clearing amount (in $ terms) so users can see how much will actually settle before depositing.

## Limit Price Persistence

Limit prices are stored in maps keyed by principal only (no cycle key):

```clarity
(define-map stx-deposit-limits principal uint)
(define-map sbtc-deposit-limits principal uint)
```

This means limits persist across cycles. If a depositor is rolled to the next cycle (due to limit violation, small-share filter, or partial fill), their limit carries forward. They can update it during the next deposit phase via `set-stx-limit` / `set-sbtc-limit` without re-depositing.

## Related Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `DEPOSIT_MIN_BLOCKS` | 10 | ~20 seconds before close is callable |
| `CANCEL_THRESHOLD` | 42 | ~84 seconds after close before cancel is callable |
| `MIN_SHARE_BPS` | 20 | Deposits < 0.2% of side total are rolled (small-share filter) |
| `PREMIUM_BPS` | 0 or 20 | Clearing price adjustment (0% or 0.20% STX bonus) |
| `PRICE_PRECISION` | 100,000,000 | 1e8 — limit prices are STX-per-BTC * this |
