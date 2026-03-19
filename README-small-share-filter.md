# Small-Share Filter

Replaces the old dust filter in `close-deposits`. Instead of refunding depositors whose pro-rata share would round to zero, we roll small depositors to the next cycle based on a simple percentage threshold.

## The problem

The old dust filter checked whether a depositor's pro-rata reward would round to zero due to integer division:

```
amount * sbtc-reward < total-stx   (STX depositor receives 0 sbtc)
amount * stx-reward  < total-sbtc  (sBTC depositor receives 0 stx)
```

This had two issues:

1. **Price drift between close and settle.** The dust filter runs at `close-deposits` with price P1, but settlement uses a fresh price P2. A depositor who barely passed the filter at P1 could have their reward round to zero at P2. Their deposit gets consumed but they receive nothing.

2. **Unnecessary complexity.** The filter required computing clearing amounts, binding side, and fees — all of which depend on oracle prices — just to decide who's too small. This made `close-deposits` expensive, required Pyth VAA parameters, and coupled the filter to price math.

## The solution

Replace the reward-based check with a percentage-of-total check:

```
amount * 10000 < total * 20   →   amount < 0.2% of total
```

If a depositor's amount is less than 0.2% (20 bps) of their side's total, they are rolled to the next cycle. No price needed.

## Why 0.2% makes the old dust check impossible

The old dust condition for an STX depositor is `amount * sbtc-reward < total-stx`. If we guarantee `amount >= 0.002 * total-stx` (the 0.2% threshold), then:

```
0.002 * total-stx * sbtc-reward < total-stx
→ sbtc-reward < 500
```

For this to trigger, the entire sBTC reward pool (after fees) would need to be under 500 sats. But the minimum sBTC deposit is 1,000 sats, and after the 10 bps fee the reward is at least 999 sats. **999 > 500, so the condition is always false.**

Same logic for sBTC depositors:

```
0.002 * total-sbtc * stx-reward < total-sbtc
→ stx-reward < 500
```

The minimum STX deposit is 1,000,000 uSTX (1 STX). After 10 bps fee, the reward is at least 999,000 uSTX (0.999 STX). **999,000 > 500, so the condition is always false.**

Both sides have massive headroom. The percentage filter makes the old integer-rounding dust scenario mathematically impossible.

## Roll instead of refund

Small depositors are rolled to the next cycle rather than refunded. This is better UX — a small fish doesn't have to re-deposit if a whale shows up next cycle. Their deposit stays in the pool automatically.

The distribute functions also always roll unfilled amounts (no min-deposit refund check). The small-share filter at close-deposits is the single protection point — if a rolled amount is still too small next cycle, it gets rolled again until either it's big enough or the depositor withdraws manually.

## No price needed at close-deposits

Since the filter is purely `amount vs total` on the same side, `close-deposits` no longer needs Pyth VAA parameters, price feeds, or freshness checks. The function signature is now just `(close-deposits)` with no arguments. This makes it cheaper to call and removes an entire class of failure modes (stale VAAs, failed Pyth updates).

Settlement retains its own 60s freshness gate (`MAX_STALENESS`) for the actual price used in matching.

## Settlement rollover fix

The old `execute-settlement` overwrote next-cycle totals with just the unfilled amounts:

```clarity
(map-set cycle-totals (+ cycle u1)
  { total-stx: stx-unfilled, total-sbtc: sbtc-unfilled })
```

This wiped out any deposits that the small-share filter had already rolled into the next cycle. Fixed to add unfilled amounts on top of existing totals:

```clarity
(map-set cycle-totals (+ cycle u1)
  { total-stx: (+ (get total-stx totals-next) stx-unfilled),
    total-sbtc: (+ (get total-sbtc totals-next) sbtc-unfilled) })
```

## Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `MIN_SHARE_BPS` | 20 | 0.20% minimum share of side total |

## Stxer simulation results

All 8 existing simulations pass (green) with the new contracts. Two new simulations verify the full small-share filter lifecycle across 3 cycles:

### STX pair: `simul-small-share-filter.js`

https://stxer.xyz/simulations/mainnet/d44c0a4b3bf9e8707dd5abbfa09a51c6

| Cycle | What happens |
|-------|-------------|
| 0 | Whale deposits 1000 STX, 3 fish deposit 1 STX each (~0.1%). Close-deposits rolls all 3 fish to cycle 1. Whale settles with 100k sats sBTC. |
| 1 | sBTC whale deposits 3 BTC, clears all whale STX. Fish rolled again (still <0.2% of 714M uSTX). Settlement preserves fish's 3M uSTX in cycle 2 totals. |
| 2 | Small sBTC deposit. Fish are now 33% each of 3M total — pass filter, stay, and settle. Each receives 345 sats. |

### USDCx pair: `simul-small-share-filter-usdcx.js`

https://stxer.xyz/simulations/mainnet/a79794728e8cf5f63a7582929c84af41

Same pattern with USDCx instead of STX.

## Summary

| | Old (dust filter) | New (small-share filter) |
|---|---|---|
| Check | `amount * reward < total` | `amount < 0.2% of total` |
| Needs price | Yes (Pyth VAAs, clearing math) | No |
| close-deposits args | btc-vaa, stx-vaa, pyth-storage, pyth-decoder, wormhole-core | None |
| Action | Refund to depositor | Roll to next cycle |
| Price drift risk | Depositor consumed, receives nothing | Impossible (filtered before matching) |
| close-deposits complexity | Clearing amounts, binding side, fees | Pure arithmetic on one side |
| Settlement rollover | Overwrites next-cycle totals | Adds to existing next-cycle totals |
