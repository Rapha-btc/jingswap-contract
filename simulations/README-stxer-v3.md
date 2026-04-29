# Stxer Mainnet Fork Simulation — v3 Generic Auction (sBTC/USDCx instance)

Full lifecycle tests of the **v3 generic blind-auction template**
(`contracts/v3/token-x-token-y-jing-v3.clar`) on a mainnet fork using
[stxer](https://stxer.xyz). All sims initialize the contract for the
sBTC ↔ USDCx pair against the Pyth BTC/USD feed.

## Contract variant

Sims deploy `contracts/v3/token-x-token-y-jing-v3-stxer.clar` — identical
to the mainnet contract except:

| Constant | Mainnet | Stxer |
|----------|---------|-------|
| `CANCEL_THRESHOLD` | `u42` | `u0` |
| `MAX_STALENESS` | (real) | `u999999999` (relaxed) |

Stxer runs all steps at a single block height, so block-based gates are
zeroed. Staleness is relaxed because stored Pyth prices on the fork may
be minutes old. The `simul-v3-settle-refresh.js` sim patches
`MAX_STALENESS` back to `u60` to prove fresh VAAs pass the real gate.

## What's different from v2

The v3 template deploys with **placeholder data-vars** for token-pair,
oracle feed, and minimum deposits. A one-shot `initialize` call
configures everything for the pair:

```clarity
(contract-call? .token-x-token-y-jing-v3 initialize
  'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token  ;; token-x
  'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx       ;; token-y
  u1000           ;; min sBTC: 1000 sats
  u1000000        ;; min USDCx: 1 USDC (6dp)
  0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43)  ;; BTC/USD
```

All deposit / cancel / settle / swap functions take SIP-10 trait + asset-name
arguments so the contract is fully pair-agnostic at the source level.

The contract also requires that the **`jing-core` registry approve the
market** before any `log-*` call succeeds (else `(err u5004)`
`ERR_NOT_APPROVED_MARKET`). Each sim runs the approval as a setup step:

```clarity
(contract-call? .jing-core approve-market 'SPV9K21....token-x-token-y-jing-v3)
```

## Mainnet addresses used

| Role | Address | Purpose |
|------|---------|---------|
| Deployer | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22` | Deploys jing-core + v3 + initializes |
| USDCx depositor | `SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51` | ~832 USDCx (down from prior ~28k) |
| sBTC depositor | `SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2` | ~40.5 BTC |
| STX funder | `SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3` | ~18k STX (gas funding for fish) |

## Simulations

### 1. Full lifecycle (`simul-v3-blind-auction.js`)

Single sBTC + single USDCx depositor, top-up, close, settle, rollover.

```bash
npx tsx simulations/simul-v3-blind-auction.js
```

https://stxer.xyz/simulations/mainnet/39ce5363fb894977b6894ae7ad58f744

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy `jing-core` | `(ok true)` |
| 2 | Deploy `token-x-token-y-jing-v3` | `(ok true)` |
| 3 | `jing-core.approve-market` | `(ok true)` |
| 4 | `initialize` (sBTC, USDCx, mins, BTC/USD feed) | `(ok true)` |
| 5 | USDCx depositor: `deposit-token-y(100 USDCx, …)` | `(ok u100000000)` |
| 6 | sBTC depositor: `deposit-token-x(100k sats, limit u1, …)` | `(ok u100000)` |
| 9 | cycle totals u0 | `{ total-token-x: u100000, total-token-y: u100000000 }` |
| 14 | USDCx top-up `+50 USDCx` | `(ok u50000000)` |
| 17 | `close-deposits` | `(ok true)` (closed-at-block u7782442) |
| 18 | phase | `u2` (SETTLE — `BUFFER_BLOCKS = 0`) |
| 19 | `settle(sbtc-trait, "sbtc-token", usdcx-trait, "usdcx-token")` | `(ok (tuple (token-x-received u99900) (token-x-rolled u0) (token-y-received u0) (token-y-rolled u73535500)))` |
| 20 | settlement | `(some (tuple (price u7646450000000) (settled-at u7782442) (token-x-cleared u100000) (token-x-fee u100) (token-y-cleared u76464500) (token-y-fee u76464)))` |

### Settlement details

Oracle price `u7,646,450,000,000` = `BTC/USD × 1e8` = **$76,464.50/BTC**.

| Field | Value | Meaning |
|-------|-------|---------|
| binding-side | `"x"` | sBTC side smaller in USD-value, fully consumed |
| x-cleared | `100,000` sats | All sBTC matched |
| y-cleared | `76,464,500` µUSDCx (~76.46 USDCx) | Settled at oracle price |
| x-fee / y-fee (10 bps) | `100` sats / `76,464` µUSDCx | Sent to treasury |
| **caller fill** (sBTC depositor) | x-received `99,900` sats refunded as USDCx-equivalent payout `76,388,036` µUSDCx (~76.39 USDCx) | After fee |
| USDCx unfilled rolled | `73,535,500` µUSDCx (~73.54 USDCx) | Stays in cycle 1 for USDCx depositor |

**FT events emitted** (5+ transfers):
- treasury fees: `76,464` µUSDCx + `100` sats → deployer
- USDCx depositor's payout: `99,900` sats → USDCx depositor
- sBTC depositor's payout: `76,388,036` µUSDCx → sBTC depositor

### 2. Cancel flows (`simul-v3-cancel-flows.js`)

Cancel during deposit phase (succeeds), cancel-already-empty (fails),
cancel during settle phase (fails), and `cancel-cycle` rollforward.

```bash
npx tsx simulations/simul-v3-cancel-flows.js
```

https://stxer.xyz/simulations/mainnet/2172d325d034ec1934305dd77c14c231

| Step | Action | Result |
|------|--------|--------|
| 5 | USDCx 100 deposit | `(ok u100000000)` |
| 6 | sBTC 100k deposit | `(ok u100000)` |
| 7 | cycle totals u0 | `{ total-token-x: u100000, total-token-y: u100000000 }` |
| 8 | `cancel-token-y-deposit` | `(ok u100000000)` (refund-y, equity-y u0) |
| 9 | `cancel-token-x-deposit` | `(ok u100000)` (refund-x, equity-x u0) |
| 10 | cycle totals u0 (after cancel) | `{ u0, u0 }` |
| 11-12 | depositor lists u0 | `(list )` / `(list )` |
| 13 | `cancel-token-y-deposit` (already empty) | **`(err u1008)` `ERR_NOTHING_TO_WITHDRAW`** ✓ |
| 14-15 | re-deposit USDCx + sBTC | `(ok …)` |
| 16 | `close-deposits` | `(ok true)` |
| 17 | phase | `u2` (SETTLE) |
| 18 | `cancel-token-y-deposit` during settle | **`(err u1002)` `ERR_NOT_DEPOSIT_PHASE`** ✓ |
| 19 | `cancel-token-x-deposit` during settle | **`(err u1002)` `ERR_NOT_DEPOSIT_PHASE`** ✓ |
| 21 | `cancel-cycle` | `(ok true)` (cancel-cycle event: `x-rolled u100000, y-rolled u100000000`) |
| 22 | cycle (after cancel-cycle) | `u1` (advanced) |
| 23 | phase (new cycle) | `u0` (DEPOSIT) |
| 24 | cycle 1 totals | `{ u100000, u100000000 }` ← perfect roll |
| 27-28 | cycle 1 depositor lists | both preserve depositor principals |
| 29 | cycle 0 totals (wiped) | `{ u0, u0 }` |
| 30-31 | cancel rolled deposits in cycle 1 | both `(ok …)` |
| 32-34 | cycle 1 totals + lists empty | `{ u0, u0 }` / `(list )` / `(list )` |

### 3. Dust sweep — sBTC binding side (`simul-v3-dust-sweep.js`)

3 USDCx depositors and 3 sBTC depositors with prime-ish amounts that
maximize integer truncation. After settle, verifies the `sweep-dust`
event fires and cycle-1 totals are exact (no orphan dust).

```bash
npx tsx simulations/simul-v3-dust-sweep.js
```

https://stxer.xyz/simulations/mainnet/461adbb7ab15be5146ad4254c1dd3fe1

```
USDCx: 33.333333 / 44.444444 / 22.222223 USDCx (total 100 USDCx)
sBTC:  33,333 / 44,444 / 22,223 sats (total 100,000 sats)
```

| Step | Action | Result |
|------|--------|--------|
| 23-25 | 3× `deposit-token-y` | `(ok u33333333)` / `(ok u44444444)` / `(ok u22222223)` |
| 26-28 | 3× `deposit-token-x` | `(ok u33333)` / `(ok u44444)` / `(ok u22223)` |
| 29 | cycle totals u0 | `{ total-token-x: u100000, total-token-y: u100000000 }` ← exact |
| 30 | `close-deposits` | `(ok true)` |
| 31 | `settle(…)` | see below |
| 32 | settlement | `(some (tuple (price u7646450000000) (settled-at u7782436) (token-x-cleared u100000) (token-x-fee u100) (token-y-cleared u76464500) (token-y-fee u76464)))` |
| 33 | cycle | `u1` |
| 34 | cycle 1 totals | `{ u0, u23535499 }` ← 1 atom less than naïve sum (sweep-dust took it) |
| 35-37 | cycle 1 USDCx fish 1/2/3 | `u7845166 / u10460222 / u5230111` (sum = `23,535,499` ✓) |
| 38-40 | cycle 1 sBTC fish 1/2/3 | `u0 / u0 / u0` (all fully cleared) |

### Settlement details

```
binding-side  "x"
clearing-price u7646450000000  (= $76,464.50/BTC)
x-cleared u100000   x-fee u100      x-unfilled u0
y-cleared u76464500 y-fee u76464    y-unfilled u23535500
```

### sweep-dust event (the proof)

```clarity
(tuple (event "sweep-dust")
       (x-dust u2)  (x-payout-dust u2)  (x-roll-dust u0)  (x-unfilled u0)
       (y-dust u2)  (y-payout-dust u1)  (y-roll-dust u1)  (y-unfilled u23535500))
```

**Both sides emit non-zero dust** — the sweep correctly absorbs the
truncation residual. Per-fish y-rollover sums to `23,535,499` (one atom
swept), matching the cycle-1 total. No orphaned dust in the contract.

### 4. Dust sweep — heavy USDCx, light sBTC (`simul-v3-dust-sweep-both.js`)

Heavy USDCx vs light sBTC so sBTC is binding. Large USDCx unfilled
produces both **payout dust** and **roll dust** on the USDCx side.

> **Note:** USDCx whale balance has dropped to ~832 USDCx since the v2 sim
> was written. Per-fish funding scaled down 100× to fit. Fish deposit
> 33/44/22 USDCx (total 100 USDCx), sBTC fish deposit 1.3k/1.4k/1.2k
> sats (total 4k sats).

```bash
npx tsx simulations/simul-v3-dust-sweep-both.js
```

https://stxer.xyz/simulations/mainnet/59b124c9c6878509bea8ea345fdb6866

_(paste sweep-dust event with usdcx-payout-dust + usdcx-roll-dust > 0)_

### 5. Same depositor on both sides (`simul-v3-same-depositor.js`)

The sBTC whale is funded with USDCx, then the same address deposits on
**both sides** of the same cycle. Proves the contract handles the same
principal in both depositor lists and pays them on both sides at settle.

```bash
npx tsx simulations/simul-v3-same-depositor.js
```

https://stxer.xyz/simulations/mainnet/e1b46774a9a3256322ae662d3b63d85d

| Step | Action | Result |
|------|--------|--------|
| 5 | USDCx whale transfers 200 USDCx to sBTC whale | `(ok true)` |
| 6 | sBTC whale: `deposit-token-y(100 USDCx, …)` | `(ok u100000000)` |
| 7 | sBTC whale: `deposit-token-x(100k sats, …)` | `(ok u100000)` |
| 8 | cycle totals u0 | `{ total-token-x: u100000, total-token-y: u100000000 }` |
| 9 | token-y depositors u0 | `(list SP2C7BCAP…)` ← same address |
| 10 | token-x depositors u0 | `(list SP2C7BCAP…)` ← same address |
| 11 | close-deposits | `(ok true)` |
| 12 | `settle(…)` | see below |
| 15 | cycle 1 totals | `{ total-token-x: u0, total-token-y: u23535500 }` |
| 16 | sBTC whale's cycle-1 USDCx (rolled unfilled) | `u23535500` (~23.54 USDCx) |
| 17 | sBTC whale's cycle-1 sBTC | `u0` (fully cleared) |

### Settlement details — caller is on both sides

```
(ok (tuple (token-x-received u99900)         ;; sBTC payout from y-side
           (token-x-rolled u0)
           (token-y-received u76388036)      ;; USDCx payout from x-side
           (token-y-rolled u23535500)))      ;; USDCx unfilled rolled
```

**Both `token-x-received` and `token-y-received` are populated** in the
same call — the contract correctly distributes to the same address on
both sides:

- `99,900` sats sBTC (after `100` sats fee) → returned to caller as the y-side payout
- `76,388,036` µUSDCx (~76.39 USDCx, after `76,464` µUSDCx fee) → returned as the x-side payout
- `23,535,500` µUSDCx unfilled portion stays as a fresh cycle-1 token-y deposit

Settlement record same as Sim 1 (same block, same oracle price `$76,464.50/BTC`).

### 6. Settle with refresh (`simul-v3-settle-refresh.js`)

Patches `MAX_STALENESS` back to `u60` (real value). Tries `settle` with
stored prices (likely stale → `ERR_STALE_PRICE`), then calls
`settle-with-refresh` with a fresh Pyth VAA.

```bash
npx tsx simulations/simul-v3-settle-refresh.js
```

https://stxer.xyz/simulations/mainnet/9017fb764b622135dd7123f3fb15cd2c

| Step | Action | Result |
|------|--------|--------|
| 5-6 | USDCx 100 + sBTC 100k deposits | `(ok …)` / `(ok …)` |
| 7 | `close-deposits` | `(ok true)` |
| 8 | phase | `u2` (SETTLE) |
| 9 | `settle(…)` (stored prices, MAX_STALENESS=u60) | **`(err u1005)` `ERR_STALE_PRICE`** ✓ |
| 10 | `settle-with-refresh(vaa, …)` | `(ok (tuple (token-x-received u99900) (token-x-rolled u0) (token-y-received u0) (token-y-rolled u23391021)))` |
| 11 | settlement | `(some (tuple (price u7660897941401) (settled-at u7782443) (token-x-cleared u100000) (token-x-fee u100) (token-y-cleared u76608979) (token-y-fee u76608)))` |

### settle-with-refresh details

- Pyth `price-feed` updated event fires (publish-time `u1777427452`,
  price `7,660,897,941,401` = `$76,608.97/BTC`)
- 1 STX paid to Pyth oracle for the update (sender → `SP3CRX...K2Z3`)
- Treasury fees: `76,608` µUSDCx + `100` sats
- USDCx depositor's payout: `99,900` sats sBTC
- sBTC depositor's payout: `76,532,371` µUSDCx (~76.53 USDCx)
- USDCx unfilled rolled: `23,391,021` (~23.39 USDCx) → cycle 1

> v3's `settle-with-refresh` is **single-feed** (the old `stx-vaa` arg
> was dropped during the DEX-sanity removal — see
> `contracts/v3/README-dex-sanity-removal.md`). Only `btc-vaa` (or
> whatever Pyth feed the contract was initialized with) needs refresh.

### 7. Small-share filter (`simul-v3-small-share-filter.js`)

3 fish below the 0.2% small-share threshold get rolled across cycles
0 and 1, then finally settle in cycle 2 once they're a larger share of
the remaining pool.

> **Note:** USDCx whale deposit dropped from 1000 → 600 USDCx to fit
> the current ~832 USDCx whale balance. Fish at 1 USDCx are still well
> under the 0.2% threshold (`1 / (600 + 3) = 0.166%`).

```bash
npx tsx simulations/simul-v3-small-share-filter.js
```

https://stxer.xyz/simulations/mainnet/7bd891e979e53ddd6aac6e52ef29b0e5

### Cycle 0 — close filters small fish out

| Step | Action | Result |
|------|--------|--------|
| 8 | USDCx whale deposit 600 USDCx | `(ok u600000000)` |
| 9-11 | 3 small fish each deposit 1 USDCx | `(ok u1000000)` × 3 |
| 12 | sBTC depositor deposits 100k sats | `(ok u100000)` |
| 13 | cycle 0 totals (pre-close) | `{ u100000, u603000000 }` |
| 14 | depositors u0 token-y | 4 entries (whale + 3 fish) |
| 15 | `close-deposits` → 3× `small-share-roll-y` events | `(ok true)` |
| 16 | cycle 0 totals (post-close) | `{ u100000, u600000000 }` ← fish removed |
| 17 | cycle 1 totals (rolled fish) | `{ u0, u3000000 }` ← `1 + 1 + 1` USDCx ✓ |
| 18 | cycle 0 token-y depositors | `(list whale)` |
| 19 | cycle 1 token-y depositors | `(list fish1, fish2, fish3)` |
| 23 | `settle(…)` cycle 0 | `(ok (tuple (token-x-received u99900) (token-y-rolled u523535500)))` |

### Cycle 1 — fish still <0.2%, rolled again

523.5M whale + 3M fish = 526.5M total. Each fish = `1 / 526.5 = 0.19%` (under 0.2% threshold).

| Step | Action | Result |
|------|--------|--------|
| 28 | sBTC adds 2,000,000 sats | `(ok u2000000)` |
| 29 | `close-deposits` cycle 1 → 3× `small-share-roll-y` events again | `(ok true)` |
| 30 | cycle 1 totals (post-close) | `{ u2000000, u523535500 }` |
| 32 | cycle 2 totals (rolled fish again) | `{ u0, u3000000 }` |
| 34 | `settle(…)` cycle 1 | `(ok (tuple (token-x-received u683993) …))` — binding-side `"y"` (USDCx now smaller) |
| 37 | cycle 2 totals | `{ u1315323, u3000000 }` ← whale's unfilled sBTC + fish's USDCx |

### Cycle 2 — fish FINALLY settle

3 fish × 1 USDCx = 3M USDCx. Each fish share = `1/3 = 33.3%` (well above 0.2%).

| Step | Action | Result |
|------|--------|--------|
| 39 | sBTC adds 100k more (cycle 2 sBTC = 1.41M) | `(ok u100000)` |
| 40 | `close-deposits` cycle 2 — **NO small-share-roll events** | `(ok true)` |
| 41 | cycle 2 totals (post-close) | `{ u1415323, u3000000 }` ← fish stay in! |
| 43 | `settle(…)` cycle 2 | binding-side `"y"`, x-cleared `u3923` sats, y-cleared `u3000000` |
| 44 | settlement record cycle 2 | populated |
| 45 | cycle | `u3` |

**Each of the 3 fish gets `1306` sats** in the cycle 2 settle — they
finally received their sBTC after being rolled twice.

### 8. Atomic swap (`simul-v3-swap.js`)

USDCx side pre-stages liquidity. The sBTC depositor calls `swap` with
`deposit-x = true` to atomically deposit + close + settle-with-refresh
in a single tx, walking away with USDCx.

```bash
npx tsx simulations/simul-v3-swap.js
```

https://stxer.xyz/simulations/mainnet/1dc68ae599db6c39cd5ea82effb86a05

```clarity
(define-public (swap
  (amount uint) (limit-price uint)
  (vaa (buff 8192))
  (pyth-storage <pyth-storage-trait>)
  (pyth-decoder <pyth-decoder-trait>)
  (wormhole-core <wormhole-core-trait>)
  (tx-trait <ft-trait>) (tx-name (string-ascii 128))
  (ty-trait <ft-trait>) (ty-name (string-ascii 128))
  (deposit-x bool))               ;; true = deposit token-x, false = deposit token-y
  (begin
    (try! (if deposit-x
            (deposit-token-x amount limit-price tx-trait tx-name)
            (deposit-token-y amount limit-price ty-trait ty-name)))
    (try! (close-deposits))
    (settle-with-refresh vaa pyth-storage pyth-decoder wormhole-core
                         tx-trait tx-name ty-trait ty-name)))
```

| Step | Action | Result |
|------|--------|--------|
| 5 | USDCx depositor pre-stages 100 USDCx | `(ok u100000000)` |
| 6 | cycle totals u0 (pre-swap) | `{ u0, u100000000 }` |
| 7 | token-y depositors u0 | `(list usdcx-depositor)` |
| 8 | sBTC depositor: `swap(true, 100k sats, u1, vaa, …)` | `(ok (tuple (token-x-received u0) (token-x-rolled u0) (token-y-received u76501269) (token-y-rolled u0)))` |
| 9 | settlement | `(some (tuple (price u7657784696297) (settled-at u7782612) (token-x-cleared u100000) (token-x-fee u100) (token-y-cleared u76577846) (token-y-fee u76577)))` |
| 10 | cycle | `u1` (advanced) |
| 14 | cycle 1 totals | `{ u0, u23422154 }` (USDCx unfilled rolled) |

### Atomic flow inside step 8 — all in one tx

The single `swap` call emits 13 events:

1. **deposit-x event** — sBTC depositor's 100k sats arrive
2. **close-deposits event** — phase transitions to SETTLE
3. **Pyth `price-feed updated`** — oracle refreshed (publish-time `u1777428635`, price `7,657,784,696,297` = `$76,577.85/BTC`)
4. **STX_TRANSFER** — 1 STX paid to Pyth oracle
5-7. **settlement event** — binding-side `"x"`, x-cleared `u100000`, y-cleared `u76577846`, fees, etc.
8-9. **distribute-y-depositor** — pre-staged USDCx depositor receives `99,900` sats sBTC
10-11. **distribute-x-depositor** — caller (sBTC depositor) receives `76,501,269` µUSDCx (~76.50 USDCx)
12-13. **sweep-dust** — zero dust both sides

**Caller (sBTC) walks away with `76,501,269 µUSDCx` (~$76.50) in a
single tx.** The pre-staged USDCx liquidity (100 USDCx) is fully
consumed; the unfilled `23,422,154 µUSDCx` (~23.42 USDCx) rolls to
cycle 1 for the original USDCx depositor.

## Boilerplate every sim runs

Identical setup as the first 4 steps of every sim:

1. Deploy `jing-core` (Clarity 4)
2. Deploy `token-x-token-y-jing-v3` (Clarity 4)
3. `jing-core.approve-market(v3-contract-id)` from deployer
4. `initialize(sBTC, USDCx, min-x, min-y, BTC_USD_FEED)` from deployer

After that, scenario steps run.

## Why Clarity 4 for the deploy?

The `as-contract?` + `with-ft` post-condition forms work fine when
deployed as Clarity 4 in the current epoch (3.4). Setting
`clarity_version = 4` in the deploy step keeps the stxer.xyz UI
**rendering-compatible** (the stxer frontend can't display Clarity 5
contracts at the time of writing). Functionally equivalent.
