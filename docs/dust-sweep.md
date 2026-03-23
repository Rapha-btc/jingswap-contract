# Dust Sweep: Eliminating Rounding Residue from Settlement

## The Problem

After each batch auction settlement, tiny amounts of STX and sBTC (1 sat, a few µSTX) remain orphaned in the contract. Nobody can claim them, and they accumulate over time — one settlement's dust is small, but after thousands of cycles it adds up.

## Where Dust Comes From

After settlement, each token's total deposits split into three parts:

```
total-stx = stx-fee + stx-after-fee + stx-unfilled
             │           │                │
             │           │                └─ didn't match, rolled to STX depositors
             │           └─ swapped, paid out to sBTC depositors
             └─ sent to treasury
```

The fee transfer is exact — no dust there.

The other two pools (`stx-after-fee` and `stx-unfilled`) are distributed to depositors via pro-rata integer division:

```clarity
(/ (* my-deposit pool) total)
```

This truncates per depositor. With N depositors, the sum of all truncated shares can be up to N-1 units less than the pool. That gap is the dust.

Both pools truncate independently:

- `stx-after-fee` → divided among sBTC depositors → each gets a truncated share
- `stx-unfilled` → divided among STX depositors → each gets a truncated share

Same applies to the sBTC side.

## The Fix: Accumulators + Sweep

### Step 1: Track what's actually distributed

Four accumulator data-vars track the running total of what the distribute functions actually send out:

| Accumulator | What it tracks |
|---|---|
| `acc-stx-out` | STX paid to sBTC depositors (swap proceeds) |
| `acc-sbtc-out` | sBTC paid to STX depositors (swap proceeds) |
| `acc-stx-rolled` | Unfilled STX rolled to next cycle for STX depositors |
| `acc-sbtc-rolled` | Unfilled sBTC rolled to next cycle for sBTC depositors |

Each distribute function increments the relevant accumulators with the truncated amount it actually transferred or rolled.

### Step 2: Compute dust as the gap

```
stx-payout-dust  = stx-after-fee - acc-stx-out       (truncation from paying sBTC depositors)
stx-roll-dust    = stx-unfilled  - acc-stx-rolled     (truncation from rolling STX depositors)
stx-dust         = stx-payout-dust + stx-roll-dust

sbtc-payout-dust = sbtc-after-fee - acc-sbtc-out      (truncation from paying STX depositors)
sbtc-roll-dust   = sbtc-unfilled  - acc-sbtc-rolled   (truncation from rolling sBTC depositors)
sbtc-dust        = sbtc-payout-dust + sbtc-roll-dust
```

### Step 3: Sweep to treasury

If dust > 0 for either token, send it to treasury in the same settlement transaction. This reuses the same transfer pattern already used for fees.

### Result

Zero orphaned tokens. Every sat and every µSTX either goes to a depositor, gets rolled forward, goes to fees, or gets swept — nothing is left behind.
