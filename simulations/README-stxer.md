# Stxer Mainnet Fork Simulation

Full lifecycle test of the blind-auction contract on a mainnet fork using [stxer](https://stxer.xyz).

## How to run

```bash
npx tsx simulations/simul-blind-auction.js
```

## Contract variant

The simulation uses `contracts/blind-auction-stxer.clar` — identical to the mainnet contract except:

| Constant | Mainnet | Stxer |
|----------|---------|-------|
| `DEPOSIT_MIN_BLOCKS` | `u150` | `u0` |
| `BUFFER_BLOCKS` | `u30` | `u0` |
| `CANCEL_THRESHOLD` | `u500` | `u0` |
| `MAX_STALENESS` | `u60` | `u999999999` |

Stxer runs all steps at a single block height, so block-based phase gates are zeroed.
Staleness is relaxed because stored Pyth prices on mainnet may be minutes old.

## Mainnet addresses used

| Role | Address | Balance |
|------|---------|---------|
| Deployer | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22` | — |
| STX depositor | `SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3` | ~18k STX |
| sBTC depositor | `SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2` | ~40.5 BTC |

## Simulation steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy `blind-auction` (Clarity 4) | Success |
| 2 | STX depositor deposits 100 STX | `(ok u100000000)` |
| 3 | sBTC depositor deposits 100k sats (0.001 BTC) | `(ok u100000)` |
| 4 | Read current cycle | `u0` |
| 5 | Read cycle phase | `u0` (DEPOSIT) |
| 6 | Read cycle totals | `{ total-stx: u100000000, total-sbtc: u100000 }` |
| 7 | Read STX deposit | `u100000000` |
| 8 | Read sBTC deposit | `u100000` |
| 9 | Read STX depositors | `(list SPZSQ...)` |
| 10 | Read sBTC depositors | `(list SP2C7...)` |
| 11 | STX depositor top-up +50 STX | `(ok u50000000)` |
| 12 | Read STX deposit after top-up | `u150000000` (150 STX) |
| 13 | Read cycle totals after top-up | `{ total-stx: u150000000, total-sbtc: u100000 }` |
| 14 | Close deposits | `(ok true)` |
| 15 | Read cycle phase | `u2` (SETTLE — buffer=0) |
| 16 | **Settle** | `(ok true)` |
| 17 | Read settlement record | see below |
| 18 | Read current cycle | `u1` (advanced) |
| 19 | Read cycle phase | `u0` (DEPOSIT — new cycle) |
| 20 | Read DEX price | `u28076075197505` (~280,760 STX/BTC) |

## Price comparison: Pyth oracle vs BitFlow DEX

The contract settles at the **Pyth price** and uses BitFlow only as a sanity check (must be within 10%).

Raw values side by side:

| Simulation | Pyth Oracle (raw) | BitFlow DEX (raw) | Pyth (STX/BTC) | BitFlow (STX/BTC) | Divergence |
|------------|-------------------|-------------------|----------------|-------------------|------------|
| Lifecycle | `u28124867124657` | `u28076152809216` | 281,248 | 280,761 | 0.17% |
| Priority queue | `u28189016033372` | `u28076075197505` | 281,890 | 280,760 | 0.40% |

Both values use `PRICE_PRECISION` (1e8). Divide by 1e8 to get STX/BTC.

## Settlement details (step 16)

Oracle price: `u28124867124657` (~281,248 STX/BTC)

| Field | Value | Meaning |
|-------|-------|---------|
| binding-side | `"stx"` | STX side smaller, fully consumed |
| stx-cleared | `150,000,000` | All 150 STX matched |
| sbtc-cleared | `53,356` | 53,356 sats matched (~0.000534 BTC) |
| sbtc-unfilled | `46,644` | Rolled to cycle 1 |
| stx-fee | `150,000` | 0.15 STX (10 bps of 150 STX) → treasury |
| sbtc-fee | `53` | 53 sats (10 bps of 53,356) → treasury |

### Distributions

| Depositor | Received | Rolled |
|-----------|----------|--------|
| STX depositor (150 STX) | **53,303 sats sBTC** | 0 STX |
| sBTC depositor (100k sats) | **149,850,000 uSTX** (149.85 STX) | 46,644 sats to cycle 1 |

### Sanity checks

- 150 STX at 281,248 STX/BTC = 0.000533 BTC = 53,333 sats. Matches Bitflow quote (~0.00053 BTC for 150 STX).
- **Oracle vs DEX price gate**: oracle `u28124867124657` (~281,248) vs DEX `u28076152809216` (~280,761) = **0.17% divergence**, well within the 10% safety gate.

## Cycle 1 rollover verification (steps 21-25)

After settlement, unfilled deposits roll into the next cycle automatically.

| Step | Query | Result | Correct? |
|------|-------|--------|----------|
| 21 | `(get-cycle-totals u1)` | `{ total-sbtc: u46667, total-stx: u0 }` | STX fully consumed, unfilled sBTC rolled |
| 22 | `(get-sbtc-deposit u1 'SP2C7...)` | `u46667` | sBTC depositor's unfilled balance carried over |
| 23 | `(get-stx-deposit u1 'SPZSQ...)` | `u0` | STX depositor fully filled, nothing rolled |
| 24 | `(get-stx-depositors u1)` | `(list )` | Empty — no STX deposits in cycle 1 |
| 25 | `(get-sbtc-depositors u1)` | `(list SP2C7...)` | Only the unfilled sBTC depositor remains |

Rollover math: 100,000 sats deposited - 53,333 sats cleared = 46,667 sats unfilled → rolled to cycle 1.

## Simulation 2: Priority queue bumping (`simul-priority-queue.js`)

Tests the priority queue with `MAX_DEPOSITORS=5` (patched at runtime). Fills queue, then attempts to add a 6th depositor.

```bash
npx tsx simulations/simul-priority-queue.js
```

https://stxer.xyz/simulations/mainnet/ef432e857cc5192e770ed3516e9bdc17

### Queue fill + bumping (steps 18-34)

| Step | Action | Result |
|------|--------|--------|
| 18-21 | 4 depositors deposit 2 STX each | `(ok u2000000)` |
| 22 | 5th deposits 1 STX (smallest) | `(ok u1000000)` — queue full |
| 23-27 | 5 sBTC deposits (4×2000 + 1×1000 sats) | queue full |
| 28-29 | Queue length STX/sBTC | `u5` / `u5` |
| 30 | Totals | `{ total-stx: u9000000, total-sbtc: u9000 }` |
| 31 | **6th STX: 0.5 STX (too small)** | `(err u1001)` ERR_DEPOSIT_TOO_SMALL |
| 32 | **6th STX: 3 STX (bigger)** | `(ok u3000000)` — bumps `3JSC` (1 STX refunded) |
| 33 | **6th sBTC: 500 sats (too small)** | `(err u1001)` |
| 34 | **6th sBTC: 3000 sats (bigger)** | `(ok u3000)` — bumps `3JSC` (1000 sats refunded) |

### Post-bump verification (steps 35-41)

| Step | Query | Result |
|------|-------|--------|
| 35-36 | Queue length STX/sBTC | `u5` / `u5` (still 5 — replaced, not added) |
| 37 | Bumped depositor `3JSC` STX | `u0` (gone) |
| 38 | New depositor `3BM` STX | `u3000000` (3 STX) |
| 39 | Bumped depositor `3JSC` sBTC | `u0` (gone) |
| 40 | New depositor `3F` sBTC | `u3000` (3000 sats) |
| 41 | Updated totals | `{ total-stx: u11000000, total-sbtc: u11000 }` |

Totals after bump: 4×2 + 3 = 11 STX, 4×2000 + 3000 = 11,000 sats.

### Settlement with 5 depositors per side (steps 42-43)

Oracle price: `u28189016033372` (~281,890 STX/BTC)

| Field | Value | Meaning |
|-------|-------|---------|
| binding-side | `"stx"` | All 11 STX consumed |
| stx-cleared | `11,000,000` | 11 STX matched |
| sbtc-cleared | `3,902` | 11 STX / 281,890 = 3,902 sats |
| sbtc-unfilled | `7,098` | Rolled to cycle 1 |
| stx-fee | `11,000` | 0.011 STX → treasury |
| sbtc-fee | `3` | 3 sats → treasury |

### Pro-rata distributions (step 43 events)

| Depositor | Deposit | Received | Rolled |
|-----------|---------|----------|--------|
| 4 STX depositors (2 STX each) | 2,000,000 uSTX | 708 sats sBTC each | 0 |
| 1 STX depositor (3 STX) | 3,000,000 uSTX | 1,063 sats sBTC | 0 |
| 4 sBTC depositors (2000 sats each) | 2,000 sats | 1,998,000 uSTX each | 1,290 sats each |
| 1 sBTC depositor (3000 sats) | 3,000 sats | 2,997,000 uSTX | 1,935 sats |

### Cycle 1 rollover (steps 44-48)

| Step | Query | Result |
|------|-------|--------|
| 44 | Settlement record | price u28189016033372, cleared/fees as above |
| 45 | Current cycle | `u1` |
| 46 | Cycle 1 totals | `{ total-sbtc: u7098, total-stx: u0 }` |
| 47 | STX depositors cycle 1 | `(list )` — empty |
| 48 | sBTC depositors cycle 1 | 5 addresses (unfilled portions rolled) |

Rollover: 11,000 - 3,902 = 7,098 sats unfilled → rolled to cycle 1.

## Simulation 3: Cancel flows (`simul-cancel-flows.js`)

Tests cancel-deposit during deposit phase, cancel during settle phase (should fail), and cancel-cycle rollforward with cancellation in the new cycle.

```bash
npx tsx simulations/simul-cancel-flows.js
```

https://stxer.xyz/simulations/mainnet/d47cb53217f026b2dde9f7bc8cd8c86a

### Part A: Cancel during deposit phase (steps 2-10)

| Step | Action | Result |
|------|--------|--------|
| 2 | Deposit 100 STX | `(ok u100000000)` |
| 3 | Deposit 100k sats sBTC | `(ok u100000)` |
| 4 | Read totals | `{ total-stx: u100000000, total-sbtc: u100000 }` |
| 5 | **Cancel STX deposit** | `(ok u100000000)` — 100 STX refunded |
| 6 | **Cancel sBTC deposit** | `(ok u100000)` — 100k sats refunded |
| 7 | Read totals after cancel | `{ total-stx: u0, total-sbtc: u0 }` |
| 8-9 | Read depositor lists | `(list )` / `(list )` — both empty |
| 10 | **Cancel again (nothing)** | `(err u1008)` ERR_NOTHING_TO_WITHDRAW |

### Part B: Cancel during settle phase (steps 11-17)

| Step | Action | Result |
|------|--------|--------|
| 11 | Re-deposit 100 STX | `(ok u100000000)` |
| 12 | Re-deposit 100k sats | `(ok u100000)` |
| 13 | STX_USER_2 deposit 50 STX | `(err u1)` — insufficient STX on mainnet |
| 14 | Close deposits | `(ok true)` |
| 15 | Read phase | `u2` (SETTLE) |
| 16 | **Cancel STX during settle** | `(err u1002)` ERR_NOT_DEPOSIT_PHASE |
| 17 | **Cancel sBTC during settle** | `(err u1002)` ERR_NOT_DEPOSIT_PHASE |

### Part C: Cancel-cycle + rollforward (steps 18-33)

| Step | Action | Result |
|------|--------|--------|
| 18 | Read totals before cancel-cycle | `{ total-stx: u100000000, total-sbtc: u100000 }` |
| 19 | **Cancel-cycle** | `(ok true)` — rolls all deposits to cycle 1 |
| 20 | Current cycle | `u1` |
| 21 | Phase | `u0` (DEPOSIT — new cycle) |
| 22 | Cycle 1 totals | `{ total-stx: u100000000, total-sbtc: u100000 }` — fully rolled |
| 23 | STX deposit in cycle 1 | `u100000000` (100 STX rolled) |
| 24 | STX_USER_2 in cycle 1 | `u0` (their deposit failed originally) |
| 25 | sBTC deposit in cycle 1 | `u100000` (100k sats rolled) |
| 26 | STX depositors cycle 1 | `(list SPZSQ...)` |
| 27 | sBTC depositors cycle 1 | `(list SP2C7...)` |
| 28 | Cycle 0 totals | `{ total-stx: u0, total-sbtc: u0 }` — wiped clean |
| 29 | **Cancel rolled STX in new cycle** | `(ok u100000000)` — 100 STX refunded |
| 30 | **Cancel rolled sBTC in new cycle** | `(ok u100000)` — 100k sats refunded |
| 31 | Cycle 1 totals after cancels | `{ total-stx: u0, total-sbtc: u0 }` |
| 32-33 | Depositor lists | `(list )` / `(list )` — all empty |

All cancel flows behave correctly: succeed during deposit phase, fail during settle phase, and rolled deposits are cancellable in the new cycle after cancel-cycle.

## Simulation 4: settle-with-refresh (`simul-settle-refresh.js`)

Tests the production settlement path with live Pyth VAAs fetched from the Hermes API. Uses **real `MAX_STALENESS u60`** — proves that stored prices fail the staleness check and fresh VAAs pass it.

```bash
npx tsx simulations/simul-settle-refresh.js
```

https://stxer.xyz/simulations/mainnet/517812a247e579112459da110d9df64d

### Live Pyth prices fetched

| Feed | Price |
|------|-------|
| BTC/USD | $72,490.98 |
| STX/USD | $0.2569 |

### Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy (zeroed blocks, **real MAX_STALENESS u60**) | Success |
| 2 | Deposit 100 STX | `(ok u100000000)` |
| 3 | Deposit 100k sats | `(ok u100000)` |
| 4 | Close deposits | `(ok true)` |
| 5 | Read phase | `u2` (SETTLE) |
| 6 | **`settle` (stored prices)** | **`(err u1005)` ERR_STALE_PRICE** — stored Pyth prices too old |
| 7 | **`settle-with-refresh` (fresh VAA)** | **`(ok true)`** — fresh prices pass the 60s gate |
| 8 | Settlement record | see below |
| 9 | Current cycle | `u1` |
| 10 | Phase | `u0` (DEPOSIT) |
| 11 | Cycle 1 totals | `{ total-sbtc: u64563, total-stx: u0 }` |
| 12 | DEX price | `u28076191615152` |

### Pyth price update events (step 7)

The VAA updated both feeds on-chain before settlement:

| Feed | Price (raw) | Confidence | Publish time |
|------|-------------|------------|-------------|
| BTC/USD | `7249098000549` ($72,490.98) | `2348583184` | `1773614960` |
| STX/USD | `25688811` ($0.2569) | `40887` | `1773614960` |

Note: the ~2 uSTX Pyth fee is visible in step 7 event [2] (2 STX transfer to Pyth).

### Settlement details

Oracle price: `u28218892655440` (~282,188 STX/BTC) — derived from fresh Pyth prices.

| Field | Value | Meaning |
|-------|-------|---------|
| binding-side | `"stx"` | All 100 STX consumed |
| stx-cleared | `100,000,000` | 100 STX matched |
| sbtc-cleared | `35,437` | 100 STX / 282,188 = 35,437 sats |
| sbtc-unfilled | `64,563` | Rolled to cycle 1 |
| stx-fee | `100,000` | 0.1 STX → treasury |
| sbtc-fee | `35` | 35 sats → treasury |

### Distributions

| Depositor | Received | Rolled |
|-----------|----------|--------|
| STX depositor (100 STX) | **35,402 sats sBTC** | 0 STX |
| sBTC depositor (100k sats) | **99,900,000 uSTX** (99.9 STX) | 64,563 sats to cycle 1 |

### Price comparison

| Source | Raw | STX/BTC | Notes |
|--------|-----|---------|-------|
| Pyth (fresh VAA) | `u28218892655440` | 282,188 | Settlement price |
| BitFlow DEX | `u28076191615152` | 280,761 | Sanity check |
| Divergence | | | **0.51%** (within 10% gate) |

### Key takeaway

This proves the full production flow:
1. `settle` fails with `ERR_STALE_PRICE` when stored Pyth prices are >60s old
2. Bot fetches fresh VAA from `hermes.pyth.network`
3. `settle-with-refresh` updates on-chain prices and settles in one tx (~2 uSTX fee)

## Latest simulations

| Test | Link |
|------|------|
| Full lifecycle | https://stxer.xyz/simulations/mainnet/7ed4cc293651815ed7ded9ebf09cc2ca |
| Priority queue bumping | https://stxer.xyz/simulations/mainnet/ef432e857cc5192e770ed3516e9bdc17 |
| Cancel flows | https://stxer.xyz/simulations/mainnet/d47cb53217f026b2dde9f7bc8cd8c86a |
| settle-with-refresh | https://stxer.xyz/simulations/mainnet/517812a247e579112459da110d9df64d |

## Bugs found and fixed via stxer

1. **Decimal factor missing** — settlement math treated sats (8 decimals) as if STX also had 8 decimals. Result was 100x off. Fixed by adding `DECIMAL_FACTOR u100` (10^8/10^6) to `stx-value-of-sbtc` and `sbtc-clearing` formulas.

2. **MAX_STALENESS underflow** — setting `MAX_STALENESS` to `u9999999999` caused `(- stacks-block-time MAX_STALENESS)` to underflow since the unix timestamp (~1.74B) is smaller. Fixed by using `u999999999` (~31 years).

3. **distribute functions return type** — `distribute-to-stx-depositor` and `distribute-to-sbtc-depositor` used `try!` but returned `bool`. Changed to `(ok true)` for proper `(response bool uint)` return type.
