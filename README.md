# Jing Swap

Blind batch auction for sBTC/STX swaps at synthetic oracle price. Zero slippage, zero MEV, every 5 minutes.

## The Problem

Large sBTC/STX swaps on AMM DEXes suffer from:
- **Slippage** that scales with order size
- **MEV extraction** — front-running and sandwich attacks
- **Price impact** that moves the market against you

## The Solution

Jing Swap is a **blind batch auction** that settles at a synthetic oracle price derived from Pyth TWAP. Depositors commit funds before the settlement price is known, making front-running mathematically impossible.

### How It Works

```
Epoch N (5 min)              Epoch N+1 (5 min)           After N+1
┌─────────────────┐          ┌─────────────────┐         ┌──────────┐
│  Deposits lock   │          │  Price forms     │         │  Settle  │
│  STX ──► pool    │          │  Pyth samples    │         │  & Claim │
│  sBTC ──► pool   │          │  accumulate TWAP │         │          │
│                  │          │                  │         │          │
│  You DON'T know  │          │  New deposits    │         │  Everyone│
│  your fill price │          │  lock for N+2    │         │  same    │
│                  │          │                  │         │  price   │
└─────────────────┘          └─────────────────┘         └──────────┘
```

1. **Deposit** — Lock sBTC or STX into the current epoch. Your funds are committed to settle at the *next* epoch's price.
2. **Price forms** — During the next 5-minute window, Pyth oracle price samples are recorded on-chain. The TWAP (time-weighted average price) is computed.
3. **Settle** — Anyone triggers settlement. Pro-rata partial fills at the uniform TWAP price. Claim your swapped tokens.

### Anti-Gaming Properties

| Attack | Protection |
|--------|-----------|
| Front-running | Price unknown at deposit time |
| Sandwich | No sequential execution — uniform price for all |
| Oracle manipulation | TWAP over full epoch + minimum sample count |
| Last-second sniping | Deposits count for next epoch, not current |
| Stale prices | Pyth publish-time staleness check (60s max) |

## Architecture

### Contracts

| Contract | Purpose |
|----------|---------|
| `blind-auction.clar` | Core epoch engine — deposits, oracle TWAP, settlement, claims |
| `jing.clar` | Existing atomic swap: STX for FT |
| `cash.clar` | Existing atomic swap: FT for STX |
| `yin.clar` / `yang.clar` | Fee structures |

### Blind Auction Flow

```
deposit-stx / deposit-sbtc
  │
  ▼
record-price-sample (anyone, during next epoch)
  │  Pyth BTC/USD + STX/USD → sBTC/STX ratio
  │  Accumulated as TWAP (sum + count)
  ▼
settle (anyone, after price epoch ends)
  │  TWAP = price-sum / sample-count
  │  Pro-rata partial fill (smaller bucket is binding)
  │  Fee deducted → treasury
  ▼
claim-as-stx-depositor / claim-as-sbtc-depositor
  │  Receive swapped tokens + unfilled remainder
```

### Epoch Model

Epochs are 5-minute windows derived from `stacks-block-time` (Clarity 4):

```clarity
(define-constant EPOCH_LENGTH u300) ;; 300 seconds = 5 minutes

(define-read-only (get-current-epoch)
  (/ stacks-block-time EPOCH_LENGTH))
```

### Oracle: Pyth TWAP

Price is NOT a single oracle read. It's the **average** of all Pyth samples collected during the settlement epoch:

- Anyone can call `record-price-sample` to push a fresh Pyth VAA on-chain
- Each sample contributes to the epoch's TWAP
- Minimum 3 samples required for settlement
- Staleness check: `publish-time` must be within 60 seconds of `stacks-block-time`
- BTC/USD and STX/USD feeds are combined to derive the sBTC/STX exchange rate

### Settlement Math

```
TWAP = price-sum / sample-count  (STX per sBTC, 8 decimal precision)

If sBTC bucket is smaller (binding):
  All sBTC depositors fully filled
  STX depositors partially filled pro-rata

If STX bucket is smaller (binding):
  All STX depositors fully filled
  sBTC depositors partially filled pro-rata

Fee = cleared_volume * 10bps → treasury
```

### Cancellation

Deposits can only be cancelled during the same epoch they were made (before the epoch flips and locks them for settlement). Once the epoch advances, your funds are committed.

## Parameters

| Parameter | Value |
|-----------|-------|
| Epoch length | 300 seconds (5 min) |
| Fee | 10 bps (0.10%) |
| Min STX deposit | 1 STX |
| Min sBTC deposit | 0.00001 sBTC |
| Min price samples | 3 per epoch |
| Max price staleness | 60 seconds |
| Price precision | 8 decimals |

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

# Format
clarinet format
```

## Roadmap

- [ ] Core blind auction (v1)
- [ ] Pyth oracle integration (mainnet)
- [ ] Circuit breaker (TWAP vs DEX spot sanity check)
- [ ] Scheduler contract — whale TWAP execution over days/weeks (auto-drip per epoch)
- [ ] Frontend — deposit, monitor epochs, claim
- [ ] Incentivized price sampling (small reward for pushing Pyth VAAs)

## Inspired By

[CoW Protocol](https://cow.fi/) batch auctions, adapted for Bitcoin-secured Stacks. Same core insight — coincidence of wants at uniform clearing price — but simpler: single pair, oracle-priced, permissionless settlement.

---

Built on Stacks. Secured by Bitcoin.
