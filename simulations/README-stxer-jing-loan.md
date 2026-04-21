# Stxer Mainnet Fork Simulations — jing-loan-sbtc-stx-single

Full lifecycle tests of the single-borrower jing-loan PoC variant against a
mainnet fork using [stxer](https://stxer.xyz). Each simulation covers a
distinct branch of the loan state machine, exercising the real
`SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2` market contract.

## Contract variant

Simulations use `contracts/jing-loan-sbtc-stx-single-Stxer.clar` — identical
to the production contract except:

| Constant | Mainnet | Stxer |
|----------|---------|-------|
| `CLAWBACK-DELAY` | `u4200` (~29 days) | `u0` |
| `our-sbtc-in-jing` | `define-read-only` | `define-private` |

Stxer runs all steps at a single block height, so block-based deadline gates
are zeroed. `our-sbtc-in-jing` is made private because Clarity's read-only
analyzer rejects the function when it calls `JING-MARKET.get-sbtc-deposit`
across contract boundaries in this context.

## Mainnet addresses used

| Role | Address | Balance |
|------|---------|---------|
| LENDER (deployer) | `SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M` | ~0.2235 sBTC |
| BORROWER | `SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X` | ~1,209 sats |
| sBTC whale (borrower top-up) | `SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ` | — |

`LENDER` is immutable in the contract and must match the deployer so the
contract ID resolves to a principal that holds sBTC to `fund` the contract.

## Simulation 1: Happy path via cancel-swap (`simul-jing-loan-sbtc-stx-single.js`)

Proves the full state machine for a loan that's opened, deposited into Jing,
pulled back via `cancel-swap` (stxer-only substitute for Jing settlement),
and repaid.

```bash
npx tsx simulations/simul-jing-loan-sbtc-stx-single.js
```

https://stxer.xyz/simulations/mainnet/0d82afeda67e5e99ff236fc6419d7459

### Flow

```
LENDER.fund(22M)
  → BORROWER.borrow(22M)
  → BORROWER.swap-deposit(1, 31_152_648_000_000)   [real Jing deposit, cycle 3]
  → BORROWER.cancel-swap(1)                        [stxer-only: zeroes Jing position]
  → whale.sbtc-token.transfer(20M → BORROWER)      [covers interest shortfall]
  → BORROWER.repay(1)
```

### Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy `jing-loan-sbtc-stx-single` (Clarity 4) | Success |
| 2 | `fund(22_000_000)` | `(ok true)` — 22M sBTC transferred LENDER → contract |
| 3 | `(get-available-sbtc)` | `u22000000` |
| 4 | `borrow(22_000_000)` | `(ok u1)` — loan 1 created, deadline `u945975` |
| 5 | `(get-active-loan)` | `(some u1)` |
| 6 | `(get-loan u1)` | status `u0` (PRE-SWAP) |
| 7 | `(owed-on-loan u1)` | `(ok u24750000)` — 22M × 1.125 |
| 8 | `(get-available-sbtc)` | `u0` — fully borrowed |
| 9 | `swap-deposit(u1, u31152648000000)` | `(ok true)` — 22M deposited into Jing at cycle 3 |
| 10 | `(get-loan u1)` | status `u1` (SWAP-DEPOSITED), `jing-cycle u3` |
| 11 | Jing `get-sbtc-deposit(u3, contract)` | `u22000000` |
| 12 | `cancel-swap(u1)` | `(ok true)` — Jing refund-sbtc 22M back |
| 13 | Jing `get-sbtc-deposit(u3, contract)` | `u0` |
| 14 | Contract sBTC balance | `u22000000` (recovered principal) |
| 15 | Whale → BORROWER transfer 20M sBTC | `(ok true)` |
| 16 | BORROWER sBTC balance | `u20001209` |
| 17 | `repay(u1)` | `(ok true)` — see accounting below |
| 18 | `(get-loan u1)` | status `u2` (REPAID) |
| 19 | `(get-active-loan)` | `none` |
| 20 | `(get-available-sbtc)` | `u0` |
| 21 | Contract sBTC balance | `u0` |
| 22 | LENDER sBTC balance | `u25097353` |

### Repay accounting

Loan principal: 22,000,000 sats  
Interest: 22,000,000 × 1250 / 10000 = 2,750,000 sats (12.5% flat — see **calibration note**)  
Owed: 24,750,000 sats  
Contract sBTC at repay: 22,000,000 (recovered via cancel-swap)  
Excess-sbtc (contract − available): 22,000,000 − 0 = 22,000,000  
Shortfall (owed − excess-sbtc): 2,750,000 → BORROWER tops up  
Refund: 0  

Transfers in `repay`:
- BORROWER → Contract: 2,750,000 sats (shortfall)
- Contract → LENDER: 24,750,000 sats (full owed)
- Contract → BORROWER: 0 STX (no synthetic payout was injected)

### Net balance changes

| Actor | Start | End | Delta |
|-------|-------|-----|-------|
| LENDER | 22,347,353 | 25,097,353 | **+2,750,000** (interest earned) |
| BORROWER | 1,209 | 17,251,209 | +17,250,000 (whale 20M − shortfall 2.75M) |
| Contract | 0 | 0 | clean |
| Whale | — | — | −20,000,000 |

## Simulation 2: Seize / default path (`simul-jing-loan-seize.js`)

Proves the lender's unilateral-recovery flow: borrower takes a loan and
deposits into Jing, then defaults. LENDER cancels the swap post-deadline (here
immediately, since CLAWBACK-DELAY is `u0`) and seizes both any synthetic STX
payout and the recovered sBTC.

```bash
npx tsx simulations/simul-jing-loan-seize.js
```

https://stxer.xyz/simulations/mainnet/3f0f8e7f56dbabcbc5645ca5e400f068

### Flow

```
LENDER.fund(22M)
  → BORROWER.borrow(22M)
  → BORROWER.swap-deposit(1, 31_152_648_000_000)   [real Jing deposit, cycle 3]
  → LENDER.cancel-swap(1)                          [deadline=now, lender branch]
  → STX_WHALE.stx-transfer(5_000 STX → contract)   [simulates Jing STX payout]
  → LENDER.seize(1)
```

### Key steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy | Success |
| 2 | `fund(22M)` | `(ok true)` |
| 4 | `borrow(22M)` | `(ok u1)` — loan created, `interest-bps u100` |
| 7 | `swap-deposit(u1, u31152648000000)` | `(ok true)` — cycle 3 |
| 10 | `cancel-swap(u1)` called by **LENDER** | `(ok true)` — refund-sbtc 22M |
| 12 | Contract sBTC balance | `u22000000` (recovered) |
| 13 | STX whale → contract | 5,000 STX |
| 14 | Contract STX balance | `u5000000000` |
| 15 | `seize(u1)` by LENDER | `(ok true)` — both distributions fire |
| 16 | `(get-loan u1)` status | `u3` (SEIZED) |
| 17 | `(get-active-loan)` | `none` |
| 20 | LENDER sBTC balance | `u22347353` (restored to start) |
| 21 | LENDER STX balance | `u5001000000` (~5,001 STX) |

### Seize accounting

Contract at entry: `stx-out = 5_000 STX`, `excess-sbtc = 22M sats`.

Transfers in `seize`:
- Contract → LENDER: 5,000 STX (`stx-transfer?` branch)
- Contract → LENDER: 22,000,000 sats (`excess-sbtc` branch, partial principal recovery)
- Loan → status `u3`, active-loan → `none`

### Key assertion proved

`cancel-swap` by LENDER is only reachable when `(>= burn-block-height (get deadline loan))`.
With `CLAWBACK-DELAY u0`, this is immediately satisfied — exactly what the
mainnet behavior would look like ~29 days after borrow. If CLAWBACK-DELAY were
respected, LENDER would be unable to unilaterally cancel a fresh loan, so
this Stxer accommodation is also what enables the full default path in a
single-block fork.

## Simulation 3: Repay with STX release branch (`simul-jing-loan-repay-stx.js`)

Variant of Simulation 1 that injects a synthetic STX payout into the contract
before `repay`, so the `(if (> stx-out u0) ...)` branch releases STX to
BORROWER. Also captures the `stx-collateral` snapshot written on the loan at
repay.

```bash
npx tsx simulations/simul-jing-loan-repay-stx.js
```

https://stxer.xyz/simulations/mainnet/a204db5c0ccb71b64a2f311c44fdcc19

### Flow

```
LENDER.fund(22M)
  → BORROWER.borrow(22M)                          [interest-bps u100 — 1% flat]
  → BORROWER.swap-deposit(1, 31_152_648_000_000)  [Jing cycle 3]
  → BORROWER.cancel-swap(1)                       [zeroes Jing position]
  → STX_WHALE.stx-transfer(5_000 STX → contract)  [stands in for Jing payout]
  → sBTC_WHALE.transfer(20M → BORROWER)           [covers interest shortfall]
  → BORROWER.repay(1)
```

### Repay transfers (step 13)

| Direction | Asset | Amount | Branch |
|-----------|-------|--------|--------|
| BORROWER → Contract | sBTC | 220,000 sats | shortfall top-up |
| Contract → LENDER | sBTC | 22,220,000 sats | owed (`principal × 1.01`) |
| Contract → BORROWER | STX | 5,000 STX | **stx-transfer? release** |

### Final balances

| Actor | sBTC Δ | STX Δ |
|-------|--------|-------|
| LENDER | +220,000 (interest) | 0 |
| BORROWER | +19,780,000 (whale 20M − 220k interest) | +5,000 STX |
| Contract | 0 | 0 |
| sBTC whale | −20,000,000 | — |
| STX whale | — | −5,000 STX |

### What this proves

- `repay`'s STX release branch fires when `stx-out > 0` and routes to BORROWER
  (not LENDER — this is the "borrower reclaims STX collateral" scenario)
- `stx-collateral` field on the loan record is written at repay time as an
  audit snapshot: `(stx-collateral u5000000000)` visible on step 14
- `interest-bps u100` correctly produces 1% flat interest (220k on a 22M loan)

Together, simulations 1-3 cover every money-movement branch in the contract:
`fund`, `borrow`, `swap-deposit`, `cancel-swap` (both borrower and lender
callers), `repay` (with and without STX), `seize`.

## Simulation 4: TRUE happy path with live Jing settlement (`simul-jing-loan-true-happy-path.js`)

Exercises the complete real-world flow. Unlike simulations 1-3, this one does
**not** use `cancel-swap` as a stand-in for Jing settlement — it calls Jing
v2's `close-and-settle-with-refresh` directly with a live Pyth VAA fetched
from `hermes.pyth.network`, so STX lands in the contract via Jing's actual
`distribute-sbtc-depositor` logic.

```bash
npx tsx simulations/simul-jing-loan-true-happy-path.js
```

https://stxer.xyz/simulations/mainnet/90390c001300f56fcb30ea15e5bcf84c

### Flow

```
LENDER.fund(22M sBTC)
  → BORROWER.borrow(22M)
  → BORROWER.swap-deposit(1, 31_152_648_000_000)   [Jing cycle 3]
  → BORROWER.jing.close-and-settle-with-refresh(vaa, vaa, storage, decoder, core)
       [closes Jing, updates Pyth on-chain, settles, distributes, advances cycle]
  → SBTC_WHALE.transfer(50M → BORROWER)            [covers full owed — no excess-sbtc in contract]
  → BORROWER.repay(1)
```

### Live price fetched

| Feed | Price |
|------|-------|
| BTC/USD | $75,847.58 |
| STX/USD | $0.2240 |

Implied oracle: ~338,622 STX/BTC.

### Jing settlement (step 9)

| Field | Value |
|-------|-------|
| binding-side | `"sbtc"` — all of our 22M sats fully cleared |
| oracle-price | `u33862284773455` (~338,622 STX/BTC) |
| sbtc-cleared | `22,000,000` (our full deposit) |
| sbtc-fee | `22,000` → Jing treasury |
| sbtc-unfilled | `0` — no rollover |
| stx-cleared | `74,497,026,501` (~74,497 STX) |
| stx-fee | `74,497,026` → Jing treasury |
| stx-unfilled | `171,168,385,976` (~171,168 STX rolls to Jing cycle 4) |

Contract received directly from `distribute-sbtc-depositor`:
**74,422,529,475 µSTX** (≈74,422.53 STX, after fee deduction from cleared STX).

### Repay (step 15)

`owed = 22,000,000 × 1.01 = 22,220,000` sats.
Contract at repay: `stx-out = 74,422,529,475 µSTX`, `excess-sbtc = 0` (Jing
took all the sBTC).

| Direction | Asset | Amount |
|-----------|-------|--------|
| BORROWER → Contract | sBTC | 22,220,000 sats (full owed, shortfall = owed since excess-sbtc = 0) |
| Contract → LENDER | sBTC | 22,220,000 sats |
| Contract → BORROWER | STX | 74,422.53 STX |

`loan.stx-collateral` snapshot: `u74422529475`.

### Final balances

| Actor | sBTC Δ | STX Δ |
|-------|--------|-------|
| LENDER | +220,000 (1% interest) | 0 |
| BORROWER | +27,780,000 (whale 50M − 22.22M paid) | +74,422 STX net |
| Contract | 0 | 0 |
| sBTC whale | −50,000,000 | — |
| Jing treasury | +22,000 sats sBTC, +74.5 STX | — |

### What this proves

- **Full Jing v2 lifecycle is reachable from a stxer single-block fork** when:
  the fork block is ≥10 blocks past cycle open (`DEPOSIT_MIN_BLOCKS u10`), and
  a fresh Pyth VAA (<80s old) is supplied via `close-and-settle-with-refresh`.
- **sBTC-binding case**: when Jing's STX side is larger than the sBTC side, our
  sBTC is 100% cleared, no rollover, contract holds pure STX post-settle, and
  `cancel-swap` is not needed.
- **Borrower's full-owed top-up path**: when `excess-sbtc = 0`, BORROWER must
  cover the entire `owed` from their wallet. Whale topup must exceed
  `principal × (1 + interest-bps/BPS_PRECISION)`, not just the interest.
- **STX release to BORROWER** works on a real Jing payout (not just synthetic),
  with the `stx-collateral` snapshot correctly recorded on the loan record.

### STX-binding rollover case

When Jing's STX side is *smaller* than the sBTC side, the binding-side flips:
some sBTC remains unfilled and rolls to Jing's next cycle, putting a non-zero
`get-sbtc-deposit current-cycle contract` on the new cycle. In that case,
`repay` would fail its `our-sbtc-in-jing = u0` assertion — BORROWER must call
`cancel-swap(1)` first to pull the rolled portion back into the contract. The
contract handles that cleanly (recovered sBTC becomes `excess-sbtc` at repay,
reducing shortfall). A future simulation should construct that scenario by
swap-depositing an amount larger than the currently-available STX total on the
other side of the market.

## Simulation 5: TRUE happy path with STX-binding rollover (`simul-jing-loan-rollover.js`)

Flip side of Simulation 4. The loan principal (80M sats ≈ 0.8 BTC) is
deliberately larger than Jing's STX side can absorb, so STX becomes the
binding side: all STX is consumed, a portion of our sBTC rolls to Jing's next
cycle. BORROWER then calls `cancel-swap(1)` on the new cycle to pull the
rolled sBTC back. `repay` correctly folds the recovered amount into
`excess-sbtc`, reducing the borrower's shortfall.

```bash
npx tsx simulations/simul-jing-loan-rollover.js
```

https://stxer.xyz/simulations/mainnet/851896b82017fa5fb212971b95b82abf

### Flow

```
SBTC_WHALE → LENDER       (1 sBTC seed — LENDER mainnet balance is ~0.22)
SBTC_WHALE → BORROWER     (0.85 sBTC — covers full repay shortfall)
  → LENDER.fund(100M)
  → BORROWER.borrow(80M)
  → BORROWER.swap-deposit(1, 31_152_648_000_000)    [Jing cycle 3, 80M sats]
  → jing.close-and-settle-with-refresh(vaa, vaa, …)
       [STX binding: ~72.5M cleared, ~7.5M rolls to cycle 4]
  → BORROWER.cancel-swap(1)                          [pulls 7.5M back from cycle 4]
  → BORROWER.repay(1)
```

### Live price fetched

| Feed | Price |
|------|-------|
| BTC/USD | $75,792.53 |
| STX/USD | $0.2236 |

### Jing settlement (step 9)

| Field | Value |
|-------|-------|
| binding-side | `"stx"` — all STX consumed, sBTC partial |
| oracle-price | `u33890157813263` (~338,901 STX/BTC) |
| sbtc-cleared | `72,488,718` |
| sbtc-fee | `72,488` |
| sbtc-unfilled | `7,511,282` — **rolled to cycle 4** |
| stx-cleared | `245,665,412,477` (~245,665 STX) |
| stx-fee | `245,665,412` (~246 STX) |
| stx-unfilled | `0` |

Contract received: **245,419,747,065 µSTX** (≈245,419.75 STX, after fee).

### Cancel-swap on cycle 4 (step 13)

`cancel-sbtc-deposit` on the new cycle refunds our rolled sBTC:
- Jing → Contract: `7,511,282` sats
- Jing position in cycle 4 drops to `u0`

### Repay (step 16)

| Field | Value |
|-------|-------|
| owed | `80,800,000` (80M × 1.01) |
| contract sBTC at entry | `27,511,282` (20M available + 7.5M recovered) |
| excess-sbtc | `27,511,282 − 20,000,000 = 7,511,282` |
| shortfall | `80,800,000 − 7,511,282 = 73,288,718` |
| refund | `0` |
| stx-out | `245,419,747,065` |

Transfers:
- BORROWER → Contract: 73,288,718 sats (shortfall)
- Contract → LENDER: 80,800,000 sats (full owed)
- Contract → BORROWER: 245,419.75 STX

### Final balances

| Actor | sBTC Δ | STX Δ |
|-------|--------|-------|
| LENDER | +800,000 (1% of 80M principal) | 0 |
| BORROWER | 85M whale − 73.29M paid = +11,711,282 | +245,419 STX |
| Contract | +20M (unborrowed `available-sbtc`, unchanged) | 0 |
| sBTC whale | −185,000,000 | — |

### Effective borrower rate

245,419 STX / 0.73288718 BTC ≈ **334,863 STX/BTC** vs clearing `338,901 STX/BTC`.
The ~1.2% premium is the loan interest (1% flat + small rounding).

### What this proves

- **STX-binding rollover is handled correctly end-to-end.** Rolled sBTC sits
  on Jing's next cycle as `get-sbtc-deposit(current-cycle, contract)` > 0,
  which would trip `repay`'s `ERR-NOT-FULLY-RESOLVED` assertion. The
  borrower's recovery path is `cancel-swap(1)` on the new cycle, which calls
  Jing's `cancel-sbtc-deposit` (allowed since the new cycle is in
  `PHASE_DEPOSIT`).
- **`excess-sbtc` correctly discounts shortfall** by the recovered portion,
  so borrowers only top up the "real" missing amount (cleared principal +
  interest, minus rolled-and-recovered).
- **`available-sbtc` is preserved across the loan lifecycle.** The 20M sats
  lender kept in reserve (unborrowed) stays in the contract untouched,
  confirming the accounting boundary between lender-owned and
  borrower-collateral funds.

## Simulation 6: Withdraw-funds paths and guards (`simul-jing-loan-withdraw-funds.js`)

Exhaustive test of `fund` / `withdraw-funds`, including the two guards
(`ERR-NOT-LENDER`, `ERR-INSUFFICIENT-FUNDS`) and the key invariant:
**borrowed principal cannot be withdrawn by the lender**.

```bash
npx tsx simulations/simul-jing-loan-withdraw-funds.js
```

https://stxer.xyz/simulations/mainnet/422e5b3a62724e5c029224a8df66ccc1

### Flow

```
SBTC_WHALE → LENDER                              (1 sBTC seed)
  → LENDER.fund(50M)           available=50M
  → LENDER.withdraw-funds(20M) available=30M
  → LENDER.withdraw-funds(30M) available=0       [drain test]
  → LENDER.fund(40M)           available=40M
  → BORROWER.borrow(30M)       available=10M     [30M now sealed]
  → LENDER.withdraw-funds(25M)                   [err u103 — over-withdraw guard]
  → BORROWER.withdraw-funds(10M)                 [err u100 — auth guard]
  → LENDER.withdraw-funds(10M) available=0       [legitimate pull]
```

### Key results

| Step | Call | Result |
|------|------|--------|
| 3 | `fund(50M)` | `(ok true)`, available = 50M |
| 5 | `withdraw-funds(20M)` | `(ok true)`, available = 30M |
| 7 | `withdraw-funds(30M)` (drain) | `(ok true)`, available = 0 |
| 9 | `fund(40M)` | `(ok true)`, available = 40M |
| 11 | `borrow(30M)` | `(ok u1)`, available = 10M |
| 14 | `withdraw-funds(25M)` (LENDER) | **`(err u103)`** ERR-INSUFFICIENT-FUNDS |
| 16 | `withdraw-funds(10M)` (BORROWER) | **`(err u100)`** ERR-NOT-LENDER |
| 19 | `withdraw-funds(10M)` (LENDER) | `(ok true)`, available = 0 |
| 21 | Contract sBTC balance | **`u30000000`** — exactly the active loan's principal |

### What this proves

- **Lender lock-out on borrowed funds.** After `borrow(30M)`, the guard
  `(asserts! (<= amount liquid) ERR-INSUFFICIENT-FUNDS)` uses `available-sbtc`
  (not the contract's full sBTC balance), so the 30M principal sealed in the
  active loan is **untouchable** by `withdraw-funds`. The lender can only
  reach it through `repay` (borrower cooperation) or `seize` (post-deadline
  default) — exactly the intended trust model.
- **Authorization guard.** `(asserts! (is-eq caller LENDER) ERR-NOT-LENDER)`
  blocks any other caller from draining the pool, including BORROWER.
- **Over-withdraw guard preserves state.** Both failed `withdraw-funds`
  attempts left `available-sbtc` intact (step 15, 17, 18 all show `u10000000`
  and `(some u1)`), proving assertion failures revert cleanly without
  corrupting state.

## Simulation 7: Error cases bundle (`simul-jing-loan-errors.js`)

Single simulation that fires every reachable assertion guard in sequence and
confirms each one errors with the expected code while leaving state intact.

```bash
npx tsx simulations/simul-jing-loan-errors.js
```

https://stxer.xyz/simulations/mainnet/5d26202b393b788c7832561bc3870777

### Guards exercised

| Step | Call | Sender | Expected | Why it errors |
|------|------|--------|----------|---------------|
| 4 | `fund(1M)` | BORROWER | `err u100` | ERR-NOT-LENDER — fund is lender-only |
| 5 | `borrow(500k)` | BORROWER | `err u102` | ERR-AMOUNT-TOO-LOW — below min-sbtc-borrow u1000000 |
| 6 | `borrow(20M)` | LENDER | `err u101` | ERR-NOT-BORROWER — borrow is borrower-only |
| 7 | `borrow(20M)` | BORROWER | `(ok u1)` | valid — creates active loan |
| 9 | `borrow(10M)` | BORROWER | `err u104` | ERR-ACTIVE-LOAN-EXISTS — one-loan invariant |
| 10 | `repay(999)` | BORROWER | `err u105` | ERR-LOAN-NOT-FOUND |
| 11 | `repay(1)` (PRE-SWAP) | BORROWER | `err u106` | ERR-BAD-STATUS — repay needs SWAP-DEPOSITED |
| 12 | `cancel-swap(1)` (PRE-SWAP) | BORROWER | `err u106` | ERR-BAD-STATUS — cancel-swap needs SWAP-DEPOSITED |
| 13 | `set-interest-bps(500)` | BORROWER | `err u100` | ERR-NOT-LENDER |
| 14 | `set-min-sbtc-borrow(2M)` | BORROWER | `err u100` | ERR-NOT-LENDER |

### State unchanged by failed calls

After the full sequence of errors:

| Read | Result |
|------|--------|
| `(get-loan u1)` | status `u0`, principal 20M, interest-bps `u100` — intact |
| `(get-active-loan)` | `(some u1)` — still the one legitimate loan |
| `(get-available-sbtc)` | `u30000000` — 50M funded − 20M borrowed |
| `(get-interest-bps)` | `u100` — unchanged by failed setter |
| `(get-min-sbtc-borrow)` | `u1000000` — unchanged |

### Guard NOT exercised here

- **`ERR-DEADLINE-NOT-REACHED (u108)` on `seize`** — unreachable in the Stxer
  clone since `CLAWBACK-DELAY u0` makes the deadline immediately satisfiable.
  Must be tested against the production contract (with `CLAWBACK-DELAY u4200`)
  in a Clarinet test.

### Note on `cancel-swap` assertion order

`cancel-swap` checks `(is-eq (get status loan) SWAP-DEPOSITED)` before the
caller authorization check. So a non-borrower calling on a PRE-SWAP loan will
err with `u106` (BAD-STATUS), not `u101` (NOT-BORROWER). Order matters for
fuzzers and downstream callers — don't assume these errors are interchangeable.

## Calibration note: `interest-bps` is flat, not annualized

The contract stores `interest-bps` as a **flat fee on principal**, applied once
per loan at borrow time. A loan runs ~29 days (CLAWBACK-DELAY u4200 BTC blocks).
Annualized: `bps × (52560 / 4200) / 100 ≈ bps × 12.5 / 100 % APR`.

| `interest-bps` | Flat fee | Annualized APR |
|----------------|----------|----------------|
| `u1250` (current default) | 12.5% | ~156% |
| `u100` (README PoC default) | 1% | ~12.5% |
| `u32` | 0.32% | ~4% (Zest parity) |

The `u1250` default is an off-by-10x bug in both the production contract and
the Stxer clone. It does not affect the flow logic proven above, but must be
lowered to `u100` before deployment.

## Stxer-specific accommodations

- **`CLAWBACK-DELAY u0`** — single-block forks can't advance burn-block-height,
  so the deadline must be immediately satisfied for `cancel-swap` (lender
  path) and `seize` to be exercisable.
- **`cancel-swap` stands in for Jing settlement** — stxer cannot wait for Jing
  to close deposits, settle against Pyth, and distribute. The fastest way to
  zero `our-sbtc-in-jing` (required by `repay`/`seize`) is `cancel-swap`. On
  mainnet, natural cycle settlement produces the same zero via a different
  path (depositor's sBTC cleared, STX received).
- **No synthetic STX payout in this simulation** — `repay`'s STX release
  branch is thus exercised with `stx-out = 0`. Future simulations should
  impersonate an STX whale transferring STX to the contract before `repay` to
  prove the `stx-transfer?` path end-to-end.
