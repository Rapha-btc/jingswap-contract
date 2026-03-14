# Jing Swap

Blind batch auction for sBTC/STX swaps at synthetic oracle price. Zero slippage, zero MEV.

## The Problem

Large sBTC/STX swaps on AMM DEXes suffer from:
- **Slippage** that scales with order size
- **MEV extraction** — front-running and sandwich attacks
- **Price impact** that moves the market against you

## The Solution

Jing Swap is a **blind batch auction** that settles at the Pyth oracle spot price. Depositors commit funds before the settlement price is known, making front-running mathematically impossible. Settlement pushes tokens directly to depositors — no claim step.

### How It Works

```
DEPOSIT (open-ended, min 150 blocks / ~5 min)
  |
  someone calls close-deposits()     <-- only after 150 blocks
  |
BUFFER (30 blocks / ~1 min)
  |
SETTLE (open-ended until success)
  |
  settle() succeeds --> next cycle starts, deposit phase open
  |
  500+ blocks without settlement? --> anyone calls cancel-cycle()
  |                                   deposits roll to next cycle
  v                                   users can withdraw next deposit phase
```

1. **Deposit** — Lock sBTC or STX. Stays open until someone calls `close-deposits()` (min 150 blocks). More time = more liquidity. 50 slots per side — when full, larger deposits bump the smallest (bumped depositor is refunded instantly).
2. **Close deposits** — Anyone can call after 150 blocks. Transitions to buffer phase. No more deposits accepted.
3. **Buffer** — 30 blocks. No actions. Ensures Pyth prices are fresh by settle time.
4. **Settle** — Anyone calls `settle()`. Reads Pyth spot price, validates 3 safety gates, computes pro-rata fills, sends tokens directly to all depositors. Unfilled auto-rolls to next cycle.
5. **Cancel** — If settlement keeps failing (500+ blocks from cycle start), anyone can cancel. All deposits roll to next cycle. Users can individually withdraw during the next deposit phase.

### Anti-Gaming Properties

| Attack | Protection |
|--------|-----------|
| Front-running | Price unknown at deposit time |
| Sandwich | No sequential execution — uniform price for all |
| Oracle manipulation | Pyth confidence check + DEX sanity check |
| Stale prices | Pyth publish-time < 60s old |
| Dust spam | Admin-adjustable minimum deposits + priority queue bumping |

### Three Safety Gates

Settlement only proceeds if ALL three gates pass:

1. **Staleness** — Pyth `publish-time` must be within 60 seconds of `stacks-block-time`
2. **Confidence** — Pyth `conf` must be < 2% of price (sources agree)
3. **DEX sanity** — Oracle price vs BitFlow pool reserves must be within 10%

If any gate fails, settlement is blocked. Anyone can retry. Conditions usually normalize within minutes.

## Architecture

### State Machine

Every phase transition is explicit — someone must call a function. No automatic clock. No orphaned funds.

```
deposit phase (open-ended)
  --> close-deposits()        anyone, after 150 blocks
buffer (30 blocks)
  --> (automatic)
settle phase (open-ended)
  --> settle() succeeds       anyone, advance cycle, deposit phase starts
  --> cancel-cycle()          anyone after 500 blocks, roll deposits, advance cycle
```

### Settlement Flow

```
settle() / settle-with-refresh()
  |
  +-- Read Pyth BTC/USD + STX/USD from pyth-storage-v4 (free)
  |   (or refresh via pyth-oracle-v4 if stale, ~2 uSTX)
  |
  +-- Validate 3 safety gates
  |
  +-- Compute pro-rata fills (smaller side is binding)
  |
  +-- Fees (10 bps from BOTH sides) to treasury
  |
  +-- map distribute-to-stx-depositor  →  send sBTC to each
  +-- map distribute-to-sbtc-depositor →  send STX to each
  |
  +-- Auto-roll unfilled amounts + depositor lists to next cycle
  |
  +-- advance-cycle
```

### Settlement Math

```
oracle-price = (BTC/USD * 10^8) / STX/USD   (STX per sBTC, 8 decimal precision)

stx-value-of-sbtc = total-sbtc * oracle-price / 10^8

If stx-value-of-sbtc <= total-stx:
  sBTC side is binding — all sBTC clears, STX partially fills
  stx-clearing = stx-value-of-sbtc
  sbtc-clearing = total-sbtc

If stx-value-of-sbtc > total-stx:
  STX side is binding — all STX clears, sBTC partially fills
  stx-clearing = total-stx
  sbtc-clearing = total-stx * 10^8 / oracle-price

Per depositor (single division, no compounded rounding):
  your-sbtc-received = your-stx-deposit * sbtc-after-fee / total-stx
  your-stx-unfilled  = your-stx-deposit * (total-stx - stx-cleared) / total-stx

Fee = 10 bps from each side → treasury
```

### Priority Queue (50 Slots)

When all 50 slots on a side are taken:
- New deposit must be strictly larger than the smallest existing deposit
- Smallest depositor is refunded instantly
- New depositor takes their slot

This prevents dust spam while keeping the system permissionless.

### Two Settlement Paths

- **`settle()`** — Reads stored Pyth prices (free). Bot tries this first.
- **`settle-with-refresh()`** — Pushes fresh Pyth VAAs first (~2 uSTX fee). Fallback when stored prices are stale.

### DEX Sanity Check

Admin-switchable between two BitFlow pools:
- **XYK pool** (default) — `xyk-pool-sbtc-stx-v-1-1`, $1.46M TVL, price from reserves ratio
- **DLMM pool** — `dlmm-pool-stx-sbtc-v-1-bps-15`, concentrated liquidity, price from active bin

## Parameters

| Parameter | Value | Adjustable |
|-----------|-------|-----------|
| Min deposit window | 150 blocks (~5 min) | No |
| Buffer after close | 30 blocks (~1 min) | No |
| Cancel threshold | 500 blocks (~16 min) | No |
| Fee | 10 bps (0.10%) per side | No |
| Max depositors per side | 50 | No |
| Min STX deposit | 1 STX (default) | Admin |
| Min sBTC deposit | 0.00001 sBTC (default) | Admin |
| DEX source | XYK (default) | Admin |
| Price staleness | 60 seconds | No |
| Confidence gate | 2% | No |
| DEX divergence gate | 10% | No |

## Who Is This For?

- **Whales** swapping large sBTC/STX positions without moving the market
- **Treasuries** (Zest, BitFlow, ALEX) rebalancing between sBTC and STX
- **Yield protocols** converting accumulated sBTC fees to STX for operations
- **Anyone** who wants fair, predictable pricing without MEV risk

## Development

```bash
# Check contracts
clarinet check

# Run tests
npm test
```

## Inspired By

[CoW Protocol](https://cow.fi/) batch auctions, adapted for Bitcoin-secured Stacks. Same core insight — coincidence of wants at uniform clearing price — but simpler: single pair, oracle-priced, permissionless settlement.

---

Built on Stacks. Secured by Bitcoin.
