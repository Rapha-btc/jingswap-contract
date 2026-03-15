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

## Settlement details (step 16)

Oracle price: `u28112756693774` (~281,127 STX/BTC)

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

### Sanity check

150 STX at 281,127 STX/BTC = 0.000533 BTC = 53,356 sats. Matches Bitflow quote (~0.00053 BTC for 150 STX).

## Latest simulation

https://stxer.xyz/simulations/mainnet/d41860818deb47134e8648a286229aba

## Bugs found and fixed via stxer

1. **Decimal factor missing** — settlement math treated sats (8 decimals) as if STX also had 8 decimals. Result was 100x off. Fixed by adding `DECIMAL_FACTOR u100` (10^8/10^6) to `stx-value-of-sbtc` and `sbtc-clearing` formulas.

2. **MAX_STALENESS underflow** — setting `MAX_STALENESS` to `u9999999999` caused `(- stacks-block-time MAX_STALENESS)` to underflow since the unix timestamp (~1.74B) is smaller. Fixed by using `u999999999` (~31 years).

3. **distribute functions return type** — `distribute-to-stx-depositor` and `distribute-to-sbtc-depositor` used `try!` but returned `bool`. Changed to `(ok true)` for proper `(response bool uint)` return type.
