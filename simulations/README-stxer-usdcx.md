# Stxer Mainnet Fork Simulation — sBTC/USDCx

Full lifecycle tests of the sBTC/USDCx blind-auction contract on a mainnet fork using [stxer](https://stxer.xyz).

## Contract variant

The simulation uses `contracts/blind-auction-stxer-usdcx.clar` — identical to the mainnet contract except:

| Constant | Mainnet | Stxer |
|----------|---------|-------|
| `DEPOSIT_MIN_BLOCKS` | `u150` | `u0` |
| `BUFFER_BLOCKS` | `u30` | `u0` |
| `CANCEL_THRESHOLD` | `u500` | `u0` |
| `MAX_STALENESS` | `u60` | `u999999999` |
| `MAX_DEPOSITORS` | `u50` | `u5` |

Stxer runs all steps at a single block height, so block-based phase gates are zeroed.
Staleness is relaxed because stored Pyth prices on mainnet may be minutes old.

## Mainnet addresses used

| Role | Address | Balance |
|------|---------|---------|
| Deployer | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22` | — |
| USDCx depositor | `SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51` | ~28.6k USDCx |
| sBTC depositor | `SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2` | ~40.5 BTC |

## Key difference from sBTC/STX version

- **Settlement price**: `oracle-price = btc-price` (BTC/USD from Pyth directly, not a cross-rate)
- **DEX sanity check (XYK)**: reads sBTC/STX from XYK pool, multiplies by STX/USD Pyth price to get BTC/USD
- **DEX sanity check (DLMM)**: reads sBTC/USDCx from native DLMM pool directly
- **STX VAA**: only refreshed when dex-source is XYK; ignored for DLMM
- **Decimal math**: `DECIMAL_FACTOR u100` unchanged (sBTC 8 decimals / USDCx 6 decimals = 100)

## Simulation 1: Full lifecycle (`simul-blind-auction-usdcx.js`)

```bash
npx tsx simulations/simul-blind-auction-usdcx.js
```

https://stxer.xyz/simulations/mainnet/1bdafad9f6874aeebb62a9eab276da85

### Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy `blind-auction-usdcx` (Clarity 4) | Success |
| 2 | USDCx depositor deposits 100 USDCx | `(ok u100000000)` |
| 3 | sBTC depositor deposits 100k sats (0.001 BTC) | `(ok u100000)` |
| 4 | Read current cycle | `u0` |
| 5 | Read cycle phase | `u0` (DEPOSIT) |
| 6 | Read cycle totals | `{ total-usdcx: u100000000, total-sbtc: u100000 }` |
| 7 | Read USDCx deposit | `u100000000` |
| 8 | Read sBTC deposit | `u100000` |
| 9 | Read USDCx depositors | `(list SP9BP4...)` |
| 10 | Read sBTC depositors | `(list SP2C7...)` |
| 11 | USDCx depositor top-up +50 USDCx | `(ok u50000000)` |
| 12 | Read USDCx deposit after top-up | `u150000000` (150 USDCx) |
| 13 | Read cycle totals after top-up | `{ total-usdcx: u150000000, total-sbtc: u100000 }` |
| 14 | Close deposits | `(ok true)` |
| 15 | Read cycle phase | `u2` (SETTLE — buffer=0) |
| 16 | **Settle** | `(ok true)` |
| 17 | Read settlement record | see below |
| 18 | Read current cycle | `u1` (advanced) |
| 19 | Read cycle phase | `u0` (DEPOSIT — new cycle) |
| 20 | Read cycle 1 totals | `{ total-usdcx: u75252260, total-sbtc: u0 }` |
| 21 | sBTC deposit cycle 1 | `u0` (fully consumed) |
| 22 | USDCx deposit cycle 1 | `u75252260` (unfilled rolled) |
| 23 | USDCx depositors cycle 1 | `(list SP9BP4...)` |
| 24 | sBTC depositors cycle 1 | `(list )` — empty |

### Settlement details (step 16)

Oracle price: `u7474774020885` — this is raw Pyth BTC/USD. Divide by 1e8 = **$74,747.74/BTC**.

| Field | Value | Meaning |
|-------|-------|---------|
| binding-side | `"sbtc"` | sBTC side smaller, fully consumed |
| sbtc-cleared | `100,000` | All 100k sats matched |
| usdcx-cleared | `74,747,740` | 74.75 USDCx matched |
| usdcx-unfilled | `75,252,260` | 75.25 USDCx rolled to cycle 1 |
| sbtc-fee | `100` | 100 sats (10 bps of 100k) -> treasury |
| usdcx-fee | `74,747` | 0.075 USDCx (10 bps of 74.75) -> treasury |

### Distributions

| Depositor | Received | Rolled |
|-----------|----------|--------|
| USDCx depositor (150 USDCx) | **99,900 sats sBTC** | 75,252,260 micro-USDCx (~75.25 USDCx) |
| sBTC depositor (100k sats) | **74,672,993 micro-USDCx** (~74.67 USDCx) | 0 sats |

### Sanity checks

- 100k sats = 0.001 BTC x $74,748 = $74.75 USDCx. Matches `usdcx-cleared` (74,747,740 = 74.75 USDCx).
- Unfilled: 150 - 74.75 = 75.25 USDCx. Matches `usdcx-unfilled` (75,252,260).
- sBTC fee: 10 bps of 100k = 100 sats.
- USDCx fee: 10 bps of 74,747,740 = 74,747 micro-USDCx.
- USDCx depositor receives: 100,000 - 100 fee = 99,900 sats.
- sBTC depositor receives: 74,747,740 - 74,747 fee = 74,672,993 micro-USDCx.

All math checks out.

## Simulation 2: Cancel flows (`simul-cancel-flows-usdcx.js`)

```bash
npx tsx simulations/simul-cancel-flows-usdcx.js
```

https://stxer.xyz/simulations/mainnet/a9ec0e36592bcc47378346c5ae755c77

### Part A: Cancel during deposit phase (steps 2-10)

| Step | Action | Result |
|------|--------|--------|
| 2 | Deposit 100 USDCx | `(ok u100000000)` |
| 3 | Deposit 100k sats sBTC | `(ok u100000)` |
| 4 | Read totals | `{ total-usdcx: u100000000, total-sbtc: u100000 }` |
| 5 | **Cancel USDCx deposit** | `(ok u100000000)` — 100 USDCx refunded |
| 6 | **Cancel sBTC deposit** | `(ok u100000)` — 100k sats refunded |
| 7 | Read totals after cancel | `{ total-usdcx: u0, total-sbtc: u0 }` |
| 8-9 | Read depositor lists | `(list )` / `(list )` — both empty |
| 10 | **Cancel again (nothing)** | `(err u1008)` ERR_NOTHING_TO_WITHDRAW |

### Part B: Cancel during settle phase (steps 11-16)

| Step | Action | Result |
|------|--------|--------|
| 11 | Re-deposit 100 USDCx | `(ok u100000000)` |
| 12 | Re-deposit 100k sats | `(ok u100000)` |
| 13 | Close deposits | `(ok true)` |
| 14 | Read phase | `u2` (SETTLE) |
| 15 | **Cancel USDCx during settle** | `(err u1002)` ERR_NOT_DEPOSIT_PHASE |
| 16 | **Cancel sBTC during settle** | `(err u1002)` ERR_NOT_DEPOSIT_PHASE |

### Part C: Cancel-cycle + rollforward (steps 17-31)

| Step | Action | Result |
|------|--------|--------|
| 17 | Read totals before cancel-cycle | `{ total-usdcx: u100000000, total-sbtc: u100000 }` |
| 18 | **Cancel-cycle** | `(ok true)` — rolls all deposits to cycle 1 |
| 19 | Current cycle | `u1` |
| 20 | Phase | `u0` (DEPOSIT — new cycle) |
| 21 | Cycle 1 totals | `{ total-usdcx: u100000000, total-sbtc: u100000 }` — fully rolled |
| 22 | USDCx deposit in cycle 1 | `u100000000` (100 USDCx rolled) |
| 23 | sBTC deposit in cycle 1 | `u100000` (100k sats rolled) |
| 24 | USDCx depositors cycle 1 | `(list SP9BP4...)` |
| 25 | sBTC depositors cycle 1 | `(list SP2C7...)` |
| 26 | Cycle 0 totals | `{ total-usdcx: u0, total-sbtc: u0 }` — wiped clean |
| 27 | **Cancel rolled USDCx in new cycle** | `(ok u100000000)` — 100 USDCx refunded |
| 28 | **Cancel rolled sBTC in new cycle** | `(ok u100000)` — 100k sats refunded |
| 29 | Cycle 1 totals after cancels | `{ total-usdcx: u0, total-sbtc: u0 }` |
| 30-31 | Depositor lists | `(list )` / `(list )` — all empty |

All cancel flows behave correctly: succeed during deposit phase, fail during settle phase, and rolled deposits are cancellable in the new cycle after cancel-cycle.

## Simulation 3: settle-with-refresh (`simul-settle-refresh-usdcx.js`)

```bash
npx tsx simulations/simul-settle-refresh-usdcx.js
```

https://stxer.xyz/simulations/mainnet/30cb05572cd2106c53edf363a978e0ae

Tests the production settlement path with live Pyth VAAs fetched from the Hermes API. Uses **real `MAX_STALENESS u60`** to prove stored prices fail and fresh VAAs pass.

### Live Pyth prices fetched

| Feed | Price |
|------|-------|
| BTC/USD | $74,889.90 |
| STX/USD | $0.2686 |

### Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy (zeroed blocks, **real MAX_STALENESS u60**) | Success |
| 2 | Deposit 100 USDCx | `(ok u100000000)` |
| 3 | Deposit 100k sats | `(ok u100000)` |
| 4 | Close deposits | `(ok true)` |
| 5 | Read phase | `u2` (SETTLE) |
| 6 | **`settle` (stored prices)** | **`(err u1005)` ERR_STALE_PRICE** — stored Pyth prices too old |
| 7 | **`settle-with-refresh` (fresh VAA)** | **`(ok true)`** — fresh prices pass the 60s gate |
| 8 | Settlement record | see below |
| 9 | Current cycle | `u1` |
| 10 | Phase | `u0` (DEPOSIT) |
| 11 | Cycle 1 totals | `{ total-usdcx: u25110096, total-sbtc: u0 }` |

### Pyth price update events (step 7)

The VAA updated both feeds on-chain before settlement:

| Feed | Price (raw) | Confidence | Publish time |
|------|-------------|------------|-------------|
| BTC/USD | `7488990400000` ($74,889.90) | `1790862699` | `1773704770` |
| STX/USD | `26860890` ($0.2686) | `40971` | `1773704770` |

Note: the ~2 uSTX Pyth fee is visible in step 7 event [2] (2 STX transfer to Pyth).

### Settlement details

Oracle price: `u7488990400000` — raw Pyth BTC/USD. Divide by 1e8 = **$74,889.90/BTC**.

| Field | Value | Meaning |
|-------|-------|---------|
| binding-side | `"sbtc"` | All 100k sats consumed |
| sbtc-cleared | `100,000` | All 100k sats matched |
| usdcx-cleared | `74,889,904` | 74.89 USDCx matched |
| usdcx-unfilled | `25,110,096` | 25.11 USDCx rolled to cycle 1 |
| sbtc-fee | `100` | 100 sats -> treasury |
| usdcx-fee | `74,889` | 0.075 USDCx -> treasury |

### Distributions

| Depositor | Received | Rolled |
|-----------|----------|--------|
| USDCx depositor (100 USDCx) | **99,900 sats sBTC** | 25,110,096 micro-USDCx (~25.11 USDCx) |
| sBTC depositor (100k sats) | **74,815,015 micro-USDCx** (~74.82 USDCx) | 0 sats |

### Key takeaway

This proves the full production flow for sBTC/USDCx:
1. `settle` fails with `ERR_STALE_PRICE` when stored Pyth prices are >60s old
2. Bot fetches fresh VAA from `hermes.pyth.network` (both BTC/USD and STX/USD for XYK DEX check)
3. `settle-with-refresh` updates on-chain prices and settles in one tx (~2 uSTX Pyth fee)

## Simulation 4: Same depositor both sides (`simul-same-depositor-usdcx.js`)

```bash
npx tsx simulations/simul-same-depositor-usdcx.js
```

https://stxer.xyz/simulations/mainnet/b52724235a8990bf16b16a761c1fe324

### Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy | Success |
| 2 | Fund sBTC whale with 200 USDCx from USDCx whale | `(ok true)` — 200,000,000 micro-USDCx transferred |
| 3 | Same address deposits 100 USDCx | `(ok u100000000)` |
| 4 | Same address deposits 100k sats sBTC | `(ok u100000)` |
| 5 | Read totals | `{ total-usdcx: u100000000, total-sbtc: u100000 }` |
| 6 | Read USDCx depositors | `(list SP2C7...)` |
| 7 | Read sBTC depositors | `(list SP2C7...)` — same address on both sides |
| 8 | Close deposits | `(ok true)` |
| 9 | **Settle** | `(ok true)` |
| 10 | Settlement record | see below |
| 11 | Current cycle | `u1` |
| 12 | Cycle 1 totals | `{ total-usdcx: u25252260, total-sbtc: u0 }` |
| 13 | USDCx deposit cycle 1 | `u25252260` — unfilled rolled |
| 14 | sBTC deposit cycle 1 | `u0` — fully consumed |

### Settlement details (step 9)

Oracle price: `u7474774020885` (~$74,748/BTC)

| Field | Value | Meaning |
|-------|-------|---------|
| binding-side | `"sbtc"` | 100k sats fully consumed |
| sbtc-cleared | `100,000` | All 100k sats matched |
| usdcx-cleared | `74,747,740` | 74.75 USDCx matched |
| usdcx-unfilled | `25,252,260` | 25.25 USDCx rolled to cycle 1 |
| sbtc-fee | `100` | 100 sats -> treasury |
| usdcx-fee | `74,747` | 0.075 USDCx -> treasury |

### Distributions to same address

| Role | Received | Rolled |
|------|----------|--------|
| As USDCx depositor | **99,900 sats sBTC** | 25,252,260 micro-USDCx (~25.25 USDCx) |
| As sBTC depositor | **74,672,993 micro-USDCx** (~74.67 USDCx) | 0 sats |

**Net effect:** The depositor swapped 100 USDCx for 99,900 sats at oracle price, got 74.67 USDCx back from the sBTC side, and has 25.25 USDCx rolled to cycle 1. Treasury collected 0.075 USDCx + 100 sats in fees. The contract correctly handles a single address on both sides — each side is processed independently through the depositor lists.

## Latest simulations

| Test | Link |
|------|------|
| Full lifecycle | https://stxer.xyz/simulations/mainnet/1bdafad9f6874aeebb62a9eab276da85 |
| Cancel flows | https://stxer.xyz/simulations/mainnet/a9ec0e36592bcc47378346c5ae755c77 |
| settle-with-refresh | https://stxer.xyz/simulations/mainnet/30cb05572cd2106c53edf363a978e0ae |
| Same depositor both sides | https://stxer.xyz/simulations/mainnet/b52724235a8990bf16b16a761c1fe324 |

## v2 simulations — with dust sweep (`roll-and-sweep-dust`)

### USDCx simulations (v2)

| Test | Link | Status |
|------|------|--------|
| Full lifecycle | https://stxer.xyz/simulations/mainnet/7bb61203d4e6b22133625cae905276c4 | All green |
| Cancel flows | https://stxer.xyz/simulations/mainnet/ffa7bd95cbdbae7d5e84153f58be267e | All green |
| settle-with-refresh | https://stxer.xyz/simulations/mainnet/13a7ccfb90349b1c0c7ed6d9511e8522 | All green |
| Same depositor both sides | https://stxer.xyz/simulations/mainnet/240454b682839842537d625ae9c3c238 | All green |
| Dust sweep (3+3, sBTC side) | https://stxer.xyz/simulations/mainnet/13232cb32e81172b81de53b794523edd | All green |
| Dust sweep (3+3, USDCx side) | https://stxer.xyz/simulations/mainnet/0733d9974580142296e402777c8a3da5 | All green |

## Bugs found via stxer

1. **`if` arm type mismatch in `settle-with-refresh`** — the conditional STX VAA refresh used `(try! (contract-call? ... verify-and-update-price-feeds ...))` in one arm and `true` in the other. `try!` unwraps to a list of price feed tuples, not `bool`. Fixed by wrapping in `(begin ... true)` to discard the return value.
