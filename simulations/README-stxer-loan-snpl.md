# Stxer Mainnet Fork Simulations — loan-reserve + snpl

Lifecycle proofs for the **two-contract loan architecture** introduced in
`contracts/loan/`: a pooled `loan-reserve` and per-borrower
`loan-sbtc-stx-0-jing` (snpl). Every sim runs against a real mainnet fork
of `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2` and uses
live Pyth VAAs for `close-and-settle-with-refresh` calls.

For the older single-contract PoC (`jing-loan-sbtc-stx-single`) sims, see
`README-stxer-jing-loan.md`.

## Stxer accommodations

The snpl source compiled into stxer sims is `loan-sbtc-stx-0-jing-stxer.clar`
which differs from production in two places:

| Site | Mainnet | Stxer |
|---|---|---|
| `CLAWBACK-DELAY` (line 59) | `u4200` (~29 days) | `u0` |
| `swap-deposit` deadline assert (line 185) | active | commented out |

Stxer runs every step at the same burn-block-height; with `CLAWBACK-DELAY u0`
the deadline equals the borrow block, which would otherwise trip the strict
`(< burn-block-height deadline)` gate inside `swap-deposit`. The
production contract keeps both checks intact.

The reserve copy `loan-reserve-stxer.clar` is byte-identical to the production
`loan-reserve.clar`.

## Mainnet principals used

| Role | Address | Purpose |
|---|---|---|
| LENDER (deployer) | `SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M` | Reserve lender, snpl deployer |
| BORROWER | `SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X` | Snpl borrower |
| SBTC_WHALE | `SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ` | Seeds LENDER (~276 sBTC mainnet) |
| STX_DEPOSITOR_1 | `SP14TZ17WHN486XFHFKHD1KTT6Z721NT40HV59T3K` | ~41,527 STX |
| STX_DEPOSITOR_2 | `SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG` | ~14,449 STX |
| JING_TREASURY | `SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE` | Hardcoded protocol-fee destination |

---

## Sim 1: Happy path via cancel-swap (`simul-loan-snpl-happy.js`)

Full repay lifecycle proving the 10% protocol fee on interest. Borrower
deposits into Jing then pulls back via `cancel-swap` (stxer stand-in for a
naturally-cleared deposit), tops up the interest shortfall, and repays.

```bash
npx tsx simulations/simul-loan-snpl-happy.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/bda9fa4bad7f2306d352cdd768bb55ea

### Flow

```
LENDER.initialize() x2  →  whale → LENDER 23M sats
LENDER.supply(22M)  →  open-credit-line(snpl, BORROWER, 22M, 100bps)
BORROWER.borrow(22M, 100, reserve)  →  swap-deposit(1, 31_152_648_000_000)
BORROWER.cancel-swap(1)        [zeros our-sbtc-in-jing for repay gate]
whale → BORROWER 1M sats       [covers 220k interest shortfall]
BORROWER.repay(1, reserve)     [protocol fee fires]
LENDER.withdraw-sbtc(22.198M)
```

### Key proof points

| Step | Evidence |
|---|---|
| 11 | `swap-deposit` fires real Jing `deposit-sbtc 22M` into cycle 8 |
| 24 | `cancel-swap` fires real Jing `refund-sbtc 22M` |
| 30 | `repay` emits **three** FT_TRANSFERs: 220k borrower→snpl, **22k snpl→`SMH8...75WQE`**, 22.198M snpl→reserve |
| 30 | Print event: `fee-sbtc u22000`, `lender-payoff-sbtc u22198000` |
| 29 vs 35 | JING_TREASURY balance: `u345885` → `u367885` = **exactly +22k sats** |
| 35–37 | Reserve drained, LENDER ends at `u23198000` (+220k vs supply) |

### Accounting

| Actor | Δ |
|---|---|
| LENDER | +198k sats (= 0.9% of 22M; 1% gross − 10% protocol carve-out) |
| JING_TREASURY | +22k sats (10% of 220k interest) |
| BORROWER | −220k sats (full interest paid) |
| Reserve | clean (`outstanding-sbtc u0`) |

---

## Sim 2: TRUE happy path with real Jing settle (`simul-loan-snpl-true-happy.js`)

Same lifecycle as Sim 1 but with a real `close-and-settle-with-refresh`
instead of a `cancel-swap` stand-in. Snpl naturally accumulates STX from
Jing's `distribute-sbtc-depositor`; borrower repays the full 22.22M sats
payoff and **the snpl's STX position releases to the borrower** in the
same atomic transaction. Exercises the `(if (> stx-out u0) ...)` branch
in `repay` that's dead in Sim 1 (where `stx-released u0`).

```bash
npx tsx simulations/simul-loan-snpl-true-happy.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/be4c488839924f5bc4e40fcac48634d9

### Flow

```
[deploy + init + seed + supply + open-line + borrow + swap-deposit as Sim 1]
STX_DEPOSITOR_1 + _2 -> Jing.deposit-stx(41k + 14k STX)
LENDER -> Jing.close-and-settle-with-refresh(VAA)
  -> snpl receives ~74k STX directly (sBTC fully cleared, binds)
BORROWER.cancel-swap(1)            [defensive — no rolled sBTC, harmless revert]
SBTC_WHALE -> BORROWER 25M sats    [covers full 22.22M payoff shortfall]
BORROWER.repay(1, reserve)
  -> 22.22M sats topup borrower -> snpl
  -> 22k sats snpl -> JING_TREASURY  (protocol fee)
  -> 22.198M sats snpl -> reserve     (lender payoff)
  -> 74.22k STX snpl -> BORROWER      *** STX-RELEASE BRANCH ***
LENDER.withdraw-sbtc(22.198M)
```

### Key proof points

| Step | Evidence |
|---|---|
| 14 | Settlement event: `binding-side "sbtc"`, `sbtc-cleared u22192927`, `sbtc-unfilled u0` at clearing 337,737 STX/BTC |
| 14 | `distribute-sbtc-depositor` to snpl: `stx-received u74227883093`, `sbtc-rolled u0` |
| 15 | snpl STX balance after settle: `u74227883093` (~74.22k STX) |
| 18 | `cancel-swap` `(err u1008)` — defensive call, no Jing position; harmless |
| 25 | Repay emits **four** transfers in one tx: 22.22M borrower→snpl, **22k snpl→JING_TREASURY**, 22.198M snpl→reserve, **74.22k STX snpl→BORROWER** |
| 25 | Print event: `fee-sbtc u22000`, `lender-payoff-sbtc u22198000`, **`stx-released u74227883093`** (was `u0` in Sim 1) |
| 26 | Loan stamped `position-stx u74227883093`, `status u1` (REPAID) |
| 23 vs 30 | Borrower STX delta: `u34691837387` → `u108919720480` = **+74.22k STX** received |
| 22 vs 31 | Borrower sBTC delta: `u26303205` → `u4083205` = **−22.22M** paid |
| 24 vs 33 | JING_TREASURY delta: `u368078` → `u390078` = exactly **+22k sats** (protocol fee) |
| 32, 36, 37 | Reserve drained to LENDER, ending at `u23198000` (+198k vs supply, identical to Sim 1) |

### Why this matters

Sim 1 used `cancel-swap` to zero out the Jing position before repay,
which left the snpl holding *only* sBTC at repay time. That path could
never test the `stx-out > 0` branch. Sim 2 hits that branch with real
Jing settlement: borrower pays 22.22M sats principal+interest in
exchange for the 74.22k STX swap proceeds, in a single repay tx. This
is the production happy path; Sim 1 is the "borrower bailed before
auction settlement" fallback.

---

## Sim 3: Seize / sBTC-binding (`simul-loan-snpl-seize.js`)

Default path with **real Jing settlement** where the snpl's sBTC is on the
binding side and fully clears at the DEX clearing price. Snpl receives STX
directly from `distribute-sbtc-depositor`. Lender seizes the STX position.

This is the natural outcome at most fork blocks because mainnet cycle 8
already carries enough STX-side demand to absorb a 22M-sat sBTC deposit.

```bash
npx tsx simulations/simul-loan-snpl-seize.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/b6629bcaba5e7160ae600a6d936258e5  
*(reference run with two unused defensive calls: `d1399c921e93a4ca857d2ed4e454690b`)*

### Flow

```
[deploy + init + seed + supply + open-line + borrow as above, 22M sats]
BORROWER.swap-deposit(1, 31_152_648_000_000)         [22M sats → cycle 8]
STX_DEPOSITOR_1 → Jing.deposit-stx(41k STX, limit)
STX_DEPOSITOR_2 → Jing.deposit-stx(14k STX, limit)
LENDER → Jing.close-and-settle-with-refresh(VAA)
LENDER.seize(1, reserve)                              [past deadline]
LENDER.withdraw-stx(70k floor)                        [residual stays in reserve]
```

### Key proof points (reference run)

| Step | Evidence |
|---|---|
| 14–15 | Both STX depositors fire real Jing `deposit-stx` (41k + 14k STX) |
| 17 | Settlement event: `binding-side "sbtc"`, `sbtc-cleared u22192927`, `sbtc-unfilled u0`, clearing 337,990 STX/BTC (above our 311k floor → we get the better rate) |
| 17 | `distribute-sbtc-depositor` to snpl: `stx-received u74283562076` (~74.28k STX), `sbtc-rolled u0` |
| 17 | Our STX deposits (limit below clearing) emit `limit-roll-stx` — they didn't fill |
| 25 | `seize`: STX_TRANSFER 74.28k STX snpl→reserve, `notify-return(22M)`, **no FT_TRANSFER to JING_TREASURY** (no-fee-on-seize) |
| 33 | JING_TREASURY balance reflects only Jing's settlement fees, not our 10% carve-out |
| 26 | Loan stamped `position-stx u74283562076`, `status u2` (SEIZED) |

### Why "binding sBTC" was the outcome

- Mainnet cycle 8 had ~191k STX of pre-existing demand at various limits
- At clearing 337,990 STX/BTC, that absorbs all 22.19M sats of sBTC deposited
- Our 55k STX deposits had limits *below* clearing → they roll instead of filling
- The lender comes out ahead on this branch: 74.28k STX recovered, market price > 311k floor

---

## Sim 4: Seize / sBTC-rolling (`simul-loan-snpl-seize-rolled.js`)

Inverse of Sim 2. Forces the snpl onto the rolling side by depositing more
sBTC than mainnet's STX-side liquidity can absorb (1 BTC = 100M sats
deposit, no STX-side depositors from us). Settlement clears only the
filled portion; the remainder rolls into cycle N+1 and is recovered via
`cancel-swap` before `seize` ships both legs.

```bash
npx tsx simulations/simul-loan-snpl-seize-rolled.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/b68c6cd80aa82a061ec2b9534c2d41c4

### Flow

```
[deploy + init + seed 110M + supply 100M + open-line(100M, 100bps) + borrow]
BORROWER.swap-deposit(1, 31_152_648_000_000)         [100M sats → cycle 8]
LENDER → Jing.close-and-settle-with-refresh(VAA)
BORROWER.cancel-swap(1)                               [pulls rolled sBTC from N+1]
LENDER.seize(1, reserve)                              [past deadline]
LENDER.withdraw-stx(100k floor) + withdraw-sbtc(10M floor)
```

### Key proof points

| Step | Evidence |
|---|---|
| 11 | `swap-deposit` 100M sats → Jing cycle 8 |
| 14 | Cycle totals: total-sbtc `u100192927`, total-stx `u136627296612` (no STX from us) |
| 15 | Settlement event: **`binding-side "stx"`**, `sbtc-cleared u40095533`, **`sbtc-unfilled u59904467`**, clearing 337,913 STX/BTC |
| 15 | `distribute-sbtc-depositor` to snpl: `sbtc-rolled u59904467`, `stx-received u135352658451` |
| 19 | `our-sbtc-in-jing(cycle 9) = u59904467` ← the rolled portion sitting in N+1 |
| 20 | `cancel-swap`: real Jing `refund-sbtc u59904467` cycle 9 → snpl |
| 22 | Snpl sBTC balance after cancel: `u59904467` (recovered) |
| 23 | `seize`: STX_TRANSFER **135.35k STX** + FT_TRANSFER **59.9M sats** snpl→reserve, `notify-return(100M)` |
| 23 | Print event: `stx-seized u135352658451`, `sbtc-seized u59904467` |
| 31 vs prior | JING_TREASURY balance moved `u367885` → `u385981` (= +18,096 sats from Jing's own protocol fees on this cycle's settlement, **not** our 10% carve-out — `seize` correctly skips the fee path) |
| 30 | Credit-line `outstanding-sbtc u0` ← `notify-return` released the principal credit |

### Accounting (lender perspective)

| Asset | Movement |
|---|---|
| sBTC | Supplied 100M, recovered 59.9M (rolled portion) → 40.1M sat shortfall |
| STX | Received 135.35k STX from Jing's clearing distribution |

The 40.1M-sat sBTC shortfall is offset by the 135.35k STX recovered. At
clearing 337,913 STX/BTC, those STX are worth 135.35k / 337,913 ≈ 0.401
BTC = 40.06M sats. Net: lender breaks even on principal at the clearing
price; the borrower's interest portion (1M sats payoff − 100M notional)
is forfeited because seize pays no protocol fee and credits only the
notional via `notify-return`.

---

## Sim 5: Two snpls on one reserve (`simul-loan-snpl-multi.js`)

Proves the canonical-bytecode value prop and per-snpl isolation in one
shot. Same source file deployed under two contract names yields two
distinct contracts with byte-identical bytecode (and identical execution
costs at deploy). Both share one `loan-reserve`. Snpl A completes a
happy-path repay; snpl B is defaulted and seized. The reserve's
`credit-lines` map is keyed per-snpl-principal so the two flows never
interact.

Bonus first: the LENDER-branch of `cancel-swap` (the post-deadline OR
gate that lets a non-borrower clean up Jing position) is finally
exercised when LENDER cancels snpl B's deposit before seizing.

```bash
npx tsx simulations/simul-loan-snpl-multi.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/7b1358da9ffdb8ffaa58ae9ce1c883de

### Flow

```
LENDER deploys reserve-trait, snpl-trait, loan-reserve, snpl-A, snpl-B
LENDER initializes reserve, snpl-A(BORROWER_A), snpl-B(BORROWER_B)
SBTC_WHALE -> LENDER 50M
LENDER supply 44M, open-credit-line(snpl-A, 22M, 100bps)
LENDER open-credit-line(snpl-B, 22M, 100bps)
BORROWER_A.borrow(22M) on snpl-A   |   BORROWER_B.borrow(22M) on snpl-B
BORROWER_A.swap-deposit(1)         |   BORROWER_B.swap-deposit(1)
BORROWER_A.cancel-swap (borrower branch)
SBTC_WHALE -> BORROWER_A 1M
BORROWER_A.repay(1, reserve)              [A.outstanding -> 0; B unchanged]
LENDER.cancel-swap on snpl-B (LENDER branch — post-deadline OR)
LENDER.seize(1, reserve) on snpl-B
LENDER.withdraw-sbtc(44.198M)
```

### Key proof points

| Step | Evidence |
|---|---|
| 4 vs 5 | snpl-A and snpl-B deploys: **identical execution cost** (Runtime 851,729, Read 16/110, Write 11/17,270) — same source -> same bytecode -> same Clarity charge |
| 15, 16 | Two `credit-lines` entries appear, each keyed on its snpl principal, both `outstanding-sbtc u0` |
| 19, 20 | After both `borrow`: A.outstanding `u22000000`, B.outstanding `u22000000` — **independently incremented** |
| 21, 22 | `(get-loan u1)` on each snpl returns structurally identical loan records (same notional, payoff, deadline, interest-bps, status) |
| 24, 25 | Both snpls fire real Jing `deposit-sbtc 22M` into cycle 8 — distinct depositor slots in the same cycle |
| 26 | snpl-A `cancel-swap`: borrower-branch (`tx-sender = BORROWER_A`), real Jing `refund-sbtc 22M` |
| 28 vs 35 | JING_TREASURY: `u345885` -> `u367885` = exactly `+22000` sats from A's repay |
| 29 | A's repay print: `fee-sbtc u22000`, `lender-payoff-sbtc u22198000`, three FT_TRANSFERs as in Sim 1 |
| **30, 31** | A.outstanding `u0`, **B.outstanding STILL `u22000000`** ← per-snpl isolation proof |
| 32, 33 | A.status `u1` (REPAID), B.status `u0` (still OPEN) |
| **36** | LENDER `cancel-swap` on snpl-B: sender `SP3TACXQF...` (LENDER, not BORROWER_B), `(ok true)`, real Jing `refund-sbtc 22M` ← **first sim to hit the LENDER branch** |
| 38 | B's seize print: `sbtc-seized u22000000, stx-seized u0`, **no FT_TRANSFER to JING_TREASURY** |
| 39, 40 | Both A.outstanding and B.outstanding now `u0` — credit lines independently closed |
| 44, 45 | Reserve sBTC `u44198000` = 22.198M (A) + 22M (B); JING_TREASURY unchanged at `u367885` (no fee on B's seize) |
| 46–48 | `withdraw-sbtc(44198000)` drains; LENDER ends at `u50198000` (= 50M seed − 44M supply + 44.198M withdraw = **+198k net**) |

### Why the first proof of canonical bytecode lives here

`loan-sbtc-stx-0-jing-stxer.clar` deliberately avoids any baked-in
LENDER/BORROWER/RESERVE — those become runtime-set data-vars at
`initialize`. Without that, every borrower would need a one-off
contract source, every redeploy a new bytecode hash, and a third-party
registry of approved snpl bytecodes (the design's whole point) would
be impossible. Sim 5 is the empirical receipt: one source file,
duplicated by name only, identical at compile time, identical at
runtime, isolated state. The lender's review burden collapses to a
single bytecode hash regardless of how many snpls they fund.

---

## Coverage matrix

| Branch | sim | snpls | settlement | binding side | rolled sBTC | stx-released to borrower | cancel-swap caller | protocol fee paid |
|---|---|---|---|---|---|---|---|---|
| `repay` (synthetic) | 1 | 1 | cancel-swap stand-in | n/a | 0 | u0 (branch dead) | borrower | yes (22k sats) |
| `repay` (real Jing) | 2 | 1 | close-and-settle | sBTC | 0 | u74227883093 ✓ | borrower (defensive) | yes (22k sats) |
| `seize` after full clear | 3 | 1 | close-and-settle | sBTC | 0 | n/a | borrower (defensive) | no |
| `seize` after partial clear | 4 | 1 | close-and-settle | STX | 59.9M sats | n/a | borrower | no |
| Multi-snpl repay + seize | 5 | 2 | cancel-swap stand-in (both) | n/a | 0 | u0 | borrower (A) **+ lender (B)** | yes on A only |

Open seize state-space:

- `seize` past deadline with **no Jing settlement at all** (snpl never deposited, or cancel-swap was used pre-settle): produces clean STX=0 / sBTC=notional reserve receipt. Trivial extension of Sim 1 by skipping repay and calling seize instead.
- `seize` with **STX-only seize proceeds** (no leftover sBTC): subset of Sim 2.
- `seize` with **both legs nonzero** at the seize call: Sim 3 is the canonical case.

## Open follow-ups for full lifecycle coverage

Not yet ported from the old single-contract PoC suite:

- `simul-loan-snpl-rollover.js` — borrow → repay → borrow again on the same snpl
- `simul-loan-snpl-reborrow-after-seize.js` — borrow → seize → reopen credit line → borrow again
- `simul-loan-snpl-set-swap-limit.js` — exercise `set-swap-limit` relay to Jing
- `simul-loan-snpl-set-reserve.js` — borrower swaps reserves between loans (active-loan gate)
- `simul-loan-snpl-errors.js` — bundle of revert paths: `ERR-WRONG-RESERVE`, `ERR-INTEREST-MISMATCH`, `ERR-OVER-LIMIT`, `ERR-NOT-LENDER`/`-BORROWER`, `ERR-PAUSED`, `ERR-ALREADY-INIT`, `ERR-BORROWER-MISMATCH`, `ERR-NOT-DEPLOYER`
- `simul-loan-snpl-admin.js` — `set-credit-line-cap`, `set-credit-line-interest`, `set-min-sbtc-draw`, `set-paused`, `close-credit-line`
- Multi-snpl on one reserve — canonical-bytecode value prop
