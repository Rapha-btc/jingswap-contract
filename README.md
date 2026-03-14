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
BUFFER (30 blocks / ~60s)            <-- no actions, stale prices expire
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
2. **Close deposits** — Anyone can call after 150 blocks. No more deposits or cancellations accepted.
3. **Buffer** — 30 blocks (~60 seconds). No actions allowed. This is a security feature: any Pyth price that was visible during the deposit phase becomes stale (>60s old) by the time settlement opens. This prevents depositors from gaming a known settlement price. The buffer duration matches `MAX_STALENESS` so the settler MUST push a fresh price.
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

### Fair Information Symmetry

Depositors can see the current Pyth price during the deposit phase. This is not an exploit — it's fair:

- **Early depositors** can cancel anytime during the deposit phase if the price moves against them
- **Late depositors** have more price certainty but get the same settlement price as everyone else
- **No one gets a better price** — everyone settles at the same uniform oracle price

The "blind" protection is not about hiding the price. It's that no one can sandwich, front-run, or get a different price through transaction ordering.

**Why the buffer matters:** Without a buffer, someone could deposit at minute 4, see the current Pyth price, call `close-deposits()` then `settle()` in the next block using that same stale price — they'd know their exact fill price before committing. The 60-second buffer ensures any price visible during deposits is stale by settle time, forcing a fresh price push. The settlement price is always unknown at deposit time.

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
buffer (30 blocks)            stale prices expire, no actions
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
| Buffer after close | 30 blocks (~60s, matches staleness) | No |
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

## Premium: Automated Swap Strategies

**A dedicated contract instance deployable by whales who want hands-off execution.**

The blind auction is a public shared pool. But for serious players — treasuries, funds, large holders — we offer a premium tier: a private contract deployed on their behalf, paired with an off-chain keeper that executes a custom swap strategy over time.

### How It Works

1. Whale defines their strategy off-chain: direction (sBTC to STX or vice versa), total amount, timeframe (1 day, 1 week, 1 month+), and optional conditions (e.g. only below a target price).
2. A dedicated contract is deployed — only the whale's address can withdraw. The keeper can only swap (sBTC to STX or STX to sBTC), never withdraw to itself.
3. The keeper participates in blind auction cycles on the whale's behalf, dripping the position across many cycles according to the strategy parameters.
4. The whale withdraws their accumulated swapped tokens at any time.

### What's On-Chain vs Off-Chain

| On-chain | Off-chain |
|----------|-----------|
| Deposits into blind auction cycles | Strategy parameters (timeframe, conditions) |
| Swaps at oracle price (same safety gates) | Target price triggers |
| Withdrawal to whale's address only | Drip scheduling and cycle participation |
| Keeper can only swap, never withdraw | Monitoring and retry logic |

### Why Premium

- **Set and forget** — define your strategy once, the keeper executes over days/weeks
- **No market impact** — small drips across many cycles, each at oracle price
- **Trustless custody** — the contract enforces that only the whale can withdraw
- **Off-chain flexibility** — strategy logic (timing, price conditions, amounts per cycle) lives off-chain and can be adjusted without redeploying

This is the on-chain equivalent of a CEX TWAP algo order, but self-custodied and MEV-free.

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
