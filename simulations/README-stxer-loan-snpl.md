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
which differs from production in three places:

| Site | Mainnet | Stxer |
|---|---|---|
| `CLAWBACK-DELAY` (line 59) | `u4200` (~29 days) | `u0` |
| `swap-deposit` deadline assert (line 185) | active | commented out |
| `set-swap-limit` deadline assert (line 224) | active | commented out |

Stxer runs every step at the same burn-block-height; with `CLAWBACK-DELAY u0`
the deadline equals the borrow block, which would otherwise trip the strict
`(< burn-block-height deadline)` gates inside `swap-deposit` and
`set-swap-limit`. Both gates use the same `<` semantics, so both must be
disabled for stxer mode. The production contract keeps all three checks
intact (see `loan-sbtc-stx-0-jing.clar`); deadline-gate enforcement is
clarinet's responsibility.

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

## Sim 6: Set-reserve between loans (`simul-loan-snpl-set-reserve.js`)

Canonical-bytecode demo for **reserves** (Sim 5 did it for snpls). Two
loan-reserves deployed from the same source under different names by the
same principal yield byte-identical bytecode. Cross-principal operational
ownership comes via `initialize`'s `init-lender` argument — the deployer
of reserve-B sets the lender to a different account, so all subsequent
`supply` / `open-credit-line` / `withdraw-sbtc` calls on reserve-B come
from that account.

Borrower opens loan u1 against reserve-A, repays, switches via
`set-reserve(reserve-B)`, opens loan u2 against reserve-B, repays. Each
lender pockets +198k sats independently.

Also covers two new negative tests not exercised by any prior sim:
`ERR-ACTIVE-LOAN-EXISTS (u104)` on `set-reserve` mid-loan, and
`ERR-WRONG-RESERVE (u113)` on `borrow` with the old reserve trait
reference after the switch.

```bash
npx tsx simulations/simul-loan-snpl-set-reserve.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/0a44715825543fc713fb7a1faa9db52e

### Trait-resolution gotcha (learned the hard way)

The first attempt deployed reserve-B under LENDER_B as a separate
deployer. It failed: the source uses *relative* trait references
(`(impl-trait .reserve-trait.reserve-trait)` and
`(use-trait snpl-trait .snpl-trait.snpl-trait)`) which resolve to
`<deployer>.reserve-trait` / `<deployer>.snpl-trait`. When LENDER_B
deploys, those resolve to `LENDER_B.reserve-trait` (which doesn't exist).

Even if LENDER_B redeployed their own copies of both traits, a deeper
issue remains: trait identity in Clarity is `(deployer-principal,
trait-name)`, so `LENDER_B.reserve-trait` and `LENDER_A.reserve-trait`
are *different types*. The snpl is typed against LENDER_A's trait, so
a reserve impl-ing LENDER_B's trait would be rejected by the snpl's
`<reserve-trait>` parameter.

The fix: deploy **both reserves under LENDER_A** (so trait references
resolve consistently), and use `initialize`'s `init-lender` to set
reserve-B's lender to LENDER_B. Operational ownership flows through
data-vars while trait identity stays unified.

Production deployments avoid this by using *absolute* trait references
in the source (e.g., `'SP_PROTOCOL.reserve-trait.reserve-trait`) so any
deployer can produce a reserve that impls the canonical trait. The
stxer source uses relative refs, which is fine for any single-protocol
deployment but constrains multi-deployer testing.

### Flow

```
LENDER_A deploys: reserve-trait, snpl-trait, loan-reserve-a, snpl, loan-reserve-b
  (all five contracts, all from LENDER_A so traits resolve consistently)
LENDER_A.initialize on reserve-a (lender = LENDER_A)
LENDER_A.initialize on reserve-b (lender = LENDER_B)  ← cross-principal
LENDER_A.initialize on snpl (borrower = BORROWER, reserve = reserve-a)
SBTC_WHALE -> LENDER_A 23M, SBTC_WHALE -> LENDER_B 23M
LENDER_A: reserve-a.supply(22M) + open-credit-line(snpl, BORROWER, 22M, 100bps)
LENDER_B: reserve-b.supply(22M) + open-credit-line(snpl, BORROWER, 22M, 100bps)
BORROWER.borrow on snpl with reserve-A trait -> loan u1
BORROWER.set-reserve(reserve-b) mid-loan                 [(err u104)]
BORROWER: swap-deposit + cancel-swap + topup + repay(reserve-A)  [loan u1 closed]
BORROWER.set-reserve(reserve-b)                          [(ok true)]
BORROWER.borrow with reserve-A trait                     [(err u113)]
BORROWER.borrow with reserve-B trait -> loan u2
BORROWER: swap-deposit + cancel-swap + topup + repay(reserve-B)  [loan u2 closed]
LENDER_A.withdraw-sbtc(22.198M) on reserve-a
LENDER_B.withdraw-sbtc(22.198M) on reserve-b
```

### Key proof points

| Step | Evidence |
|---|---|
| 3 vs 5 | reserve-a vs reserve-b deploys: **identical execution costs** (Runtime 480,200, Read 5/178, Write 9/10,797) — canonical bytecode for reserves |
| 6, 7 | Both initialize succeed under LENDER_A as deployer; reserve-b print event records `lender LENDER_B` |
| 10 | `reserve-a.get-lender` returns LENDER_A |
| 11 | `reserve-b.get-lender` returns LENDER_B (different operational owner via initialize) |
| 16, 17 | LENDER_B can `supply` and `open-credit-line` on reserve-b — tx-sender == lender check passes against the cross-principal lender |
| 21 vs 22 | After loan u1 borrow: A.outstanding `u22000000`, **B.outstanding `u0`** |
| **23** | `set-reserve` mid-loan: `(err u104)` ERR-ACTIVE-LOAN-EXISTS ← **new negative test** |
| 28 vs 29 | After loan u1 repay: A.outstanding `u0`, **B.outstanding STILL `u0`** ← never touched |
| 30 | `set-reserve(reserve-b)`: `(ok true)`, print event records the switch |
| 31 | `(get-reserve)` returns `reserve-b` |
| **32** | `borrow` with old reserve-A trait: `(err u113)` ERR-WRONG-RESERVE ← **new negative test** |
| 33 | `borrow` with reserve-B trait: `(ok u2)` — `next-loan-id` incremented |
| 34 vs 35 | After loan u2 borrow: A.outstanding STILL `u0`, B.outstanding `u22000000` |
| 36, 37 | Loan u1 status STILL `u1` (REPAID), Loan u2 status `u0` (OPEN) |
| 41 | Loan u2 repay print: `fee-sbtc u22000`, `lender-payoff-sbtc u22198000`, reserve = reserve-b |
| 45, 46 | Each LENDER withdraws 22.198M from their respective reserve independently |
| 49, 50 | LENDER_A and LENDER_B both end at `u23198000` (= +198k net each) |
| 51 | JING_TREASURY: `u389885` − pre-sim `u345885` = **exactly +44k** (22k per repay) |

---

## Sim 7: Rollover — back-to-back repays (`simul-loan-snpl-rollover.js`)

State-machine continuity demo: borrower runs the full happy path twice
in a row on a single snpl + reserve, no `set-reserve` in between. Tests
that `active-loan` releases on repay, `next-loan-id` increments, the
credit line cycles outstanding-sbtc back to zero ready for the next
draw, and the lender accumulates 198k sats per loan.

```bash
npx tsx simulations/simul-loan-snpl-rollover.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/483c8ceed2515e3c05f2227d2137d2fa

### Key proof points

| Step | Evidence |
|---|---|
| 17 | After loan u1 repay: `(get-active-loan)` = `none` ← released by repay |
| 19 | A.outstanding back to `u0` |
| 20 | Reserve sBTC `u22198000` (lender-payoff from loan 1) |
| 21 | Loan u2 borrow: **`(ok u2)`** ← `next-loan-id` incremented past u1 |
| 23 | Loan u2 record at status `u0` OPEN, with fresh deadline + zeroed jing-cycle/limit-price |
| 24 | Loan u1 record STILL status `u1` REPAID — prior loan preserved |
| 26 | Reserve sBTC drops to `u198000` (= 22.198M − 22M loan-2 draw) |
| 29 | Loan u2 repay print: same `fee-sbtc u22000`, `lender-payoff-sbtc u22198000`, `stx-released u0` |
| 33 | Final reserve sBTC: **`u22396000`** = 198k + 22.198M lender-payoff |
| 34 | JING_TREASURY: `u345885 → u389885` = **exactly +44k** (22k × 2) |
| 37 | LENDER end: **`u23396000`** (= 23M seed − 22M supply + 22.396M withdraw → **+396k net = 198k × 2**) |

---

## Sim 8: Reborrow after seize (`simul-loan-snpl-reborrow-after-seize.js`)

Companion to Sim 7 but with default in the middle: borrow → seize →
borrow again on the *same credit line*. Proves that `seize` releases
`active-loan` exactly like `repay` does (via `notify-return`), that
`close-credit-line` is *not* automatically triggered by default, and
that the lender can keep the line open indefinitely after a default
without any state cleanup. Loan u1's record is preserved on-chain
(status `u2` SEIZED) as historical evidence even after loan u2 opens.

```bash
npx tsx simulations/simul-loan-snpl-reborrow-after-seize.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/619de540d9f9f56e9360ed6e18753323

### Key proof points

| Step | Evidence |
|---|---|
| 15 | Seize: `sbtc-seized u22000000, stx-seized u0`, `notify-return(22M)`, no FT_TRANSFER to JING_TREASURY |
| 16 | After seize: `(get-active-loan)` = `none` ← released by seize, just like repay |
| 17 | Loan u1 stamped status `u2` SEIZED |
| 18 | Reserve credit-line: `outstanding-sbtc u0` ← `notify-return` cleared it |
| 20 | Reserve sBTC: `u22000000` (recovered principal exactly — no interest, since seize collects only what the snpl held) |
| 21 | JING_TREASURY: `u345885` ← UNCHANGED post-seize ← **no-fee-on-seize invariant** |
| 22 | Loan u2 borrow: **`(ok u2)`** on the *same credit line*, no `close-credit-line` ever called |
| 25 | **Loan u1 record STILL status `u2` SEIZED** — prior default preserved as on-chain history |
| 29 | Loan u2 repay: 3 transfers as usual, `fee-sbtc u22000`, `lender-payoff-sbtc u22198000` |
| 33 | Final reserve sBTC: **`u22198000`** (= 22M post-seize − 22M loan-2 draw + 22.198M loan-2 repay) |
| 34 | JING_TREASURY: `u345885 → u367885` = **exactly +22k** (only loan 2 paid the fee — loan 1 was seized) |
| 37 | LENDER end: **`u23198000`** (= +198k net, only loan 2 had interest; seize gave back exactly principal) |

### Why this matters

The credit line is *passive on-chain state*: it persists across loan
boundaries until the lender explicitly calls `close-credit-line` (which
itself requires `outstanding-sbtc u0` as a guard). After a default, the
lender's choices are:
1. Keep the line open and let the borrower retry (this sim) — useful
   if the lender judges the default to be one-off.
2. Call `close-credit-line` to retire the line (not exercised in any
   sim — pure state mutation, clarinet-suitable).
3. Lower the cap via `set-credit-line-cap` to a smaller drawable amount
   while keeping the line open (clarinet-suitable).

Sim 8 confirms option 1 works end-to-end with no manual state cleanup.

---

## Coverage matrix

| Branch | sim | snpls | reserves | loans | settlement | binding side | rolled sBTC | stx-released to borrower | cancel-swap caller | protocol fee paid |
|---|---|---|---|---|---|---|---|---|---|---|
| `repay` (synthetic) | 1 | 1 | 1 | 1 | cancel-swap stand-in | n/a | 0 | u0 (branch dead) | borrower | yes (22k sats) |
| `repay` (real Jing) | 2 | 1 | 1 | 1 | close-and-settle | sBTC | 0 | u74227883093 ✓ | borrower (defensive) | yes (22k sats) |
| `seize` after full clear | 3 | 1 | 1 | 1 | close-and-settle | sBTC | 0 | n/a | borrower (defensive) | no |
| `seize` after partial clear | 4 | 1 | 1 | 1 | close-and-settle | STX | 59.9M sats | n/a | borrower | no |
| Multi-snpl repay + seize | 5 | 2 | 1 | 2 (1 ea) | cancel-swap stand-in (both) | n/a | 0 | u0 | borrower (A) **+ lender (B)** | yes on A only |
| Set-reserve between loans | 6 | 1 | 2 | 2 | cancel-swap stand-in (both) | n/a | 0 | u0 | borrower | yes on both repays (44k total) |
| Rollover (repay → repay) | 7 | 1 | 1 | 2 | cancel-swap stand-in (both) | n/a | 0 | u0 | borrower | yes on both repays (44k total) |
| Reborrow after seize | 8 | 1 | 1 | 2 | cancel-swap stand-in (both) | n/a | 0 | u0 | borrower | yes on loan 2 only (22k) |
| Repay refund branch | 9 | 1 | 1 | 1 | close-and-settle | STX | 60.04M sats | u135352658451 ✓ | borrower | yes (100k — scales with 100M loan); **refund branch ⭐** |
| set-swap-limit relay | 10 | 1 | 1 | 1 | cancel-swap stand-in | n/a | 0 | u0 | borrower | yes (22k sats); **`set-swap-limit` ⭐** |

## Sim 9: Repay refund branch (`simul-loan-snpl-repay-refund.js`)

The first sim to exercise the **refund branch** in `repay`. Every
prior sim took the `is-shortfall` path (snpl had less sBTC than payoff,
borrower topped up). This one constructs the inverse: real Jing settle
leaves the snpl with rolled sBTC + STX position, then a whale airdrops
105M sats directly to the snpl (simulating an over-stage, an
out-of-band airdrop, or returned dust). At repay the snpl now holds
*more* than payoff, the `(is-shortfall false)` branch fires, and the
excess sBTC ships back to the borrower in the same atomic tx as the
fee + lender-payoff + STX release.

This is the only stxer-feasible way to hit the refund branch — it
needs both real Jing distribution math (so the snpl ends up holding
both legs) and a third-party sBTC sender (so snpl's sBTC exceeds what
the borrower would have computed for shortfall topup).

```bash
npx tsx simulations/simul-loan-snpl-repay-refund.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/6f5f55ccb06717ec08da50d071141172

### Flow

```
[deploy + init + seed 110M + supply 100M + open-line(100M, 100bps) + borrow]
BORROWER.swap-deposit(1)               [100M sats -> Jing cycle 8]
LENDER -> Jing.close-and-settle-with-refresh(VAA)
  -> binding-side "stx", snpl receives ~135k STX, ~60M sats roll into N+1
BORROWER.cancel-swap(1)                [recovers ~60M rolled to snpl]
SBTC_WHALE -> snpl 105M sats           [over-stage / airdrop]
  -> snpl sBTC = recovered + 105M = ~165M >> 101M payoff
BORROWER.repay(1, reserve)
  -> 4 transfers, NO borrower-to-snpl shortfall pull:
     - 64M sBTC snpl -> BORROWER  (REFUND BRANCH)
     - 100k snpl   -> JING_TREASURY (protocol fee)
     - 100.9M snpl -> reserve     (lender-payoff)
     - 135k STX snpl -> BORROWER  (STX-release)
LENDER.withdraw-sbtc(100.9M)
```

### Key proof points

| Step | Evidence |
|---|---|
| 12 | Settlement event: `binding-side "stx"`, `sbtc-cleared u39957961`, `sbtc-unfilled u60042039`, clearing 339,076 STX/BTC |
| 12 | `distribute-sbtc-depositor` to snpl: `stx-received u135352658451`, `sbtc-rolled u60042039` |
| 16 | `cancel-swap` fires real Jing `refund-sbtc u60042039` from cycle 9 → snpl |
| 17 | snpl sBTC after cancel: `u60042039` (recovered exactly the rolled portion) |
| 18 | Whale airdrop: real `FT_TRANSFER 105000000` whale → snpl |
| 19 | snpl sBTC after airdrop: `u165042039` (= 60.04M + 105M, well above 101M payoff) |
| 23 | Repay output `(ok true)` with **four** transfers — first is **snpl → BORROWER 64,042,039 sBTC** (refund), no `BORROWER → snpl` shortfall pull anywhere in the tx |
| 23 | Print event: **`is-shortfall false`** ← key proof of refund branch firing, `delta-sbtc u64042039`, `fee-sbtc u100000`, `lender-payoff-sbtc u100900000`, `stx-released u135352658451` |
| 24 | Loan stamped status `u1` REPAID, `position-stx u135352658451` |
| 27 vs 21 | Borrower STX delta: `u34691837385 → u170044495836` = **+135.35k STX** released |
| 28 vs 20 | Borrower sBTC delta: `u1303205 → u65345244` = **+64.04M** received as refund (never paid shortfall) |
| 30 vs 22 | JING_TREASURY: `u385843 → u485843` = exactly **+100k sats** (10% of 1M interest — scales with loan size; 4.5× the 22k fee on 22M loans) |
| 32–34 | Reserve drained to LENDER, ending at `u110900000` (= 110M seed − 100M supply + 100.9M withdraw → **+900k net = 100M × 100bps × 90%**) |

### Why this matters

The contract's repay logic has three reconciliation paths based on
sbtc-balance vs payoff:

| Branch | Trigger | Action | Sims that hit it |
|---|---|---|---|
| `is-shortfall true, delta > 0` | snpl has less than payoff | borrower → snpl `delta` (pull from wallet) | 1, 2, 4-8 (every other sim) |
| `is-shortfall true, delta = 0` (exact) | snpl has exactly payoff | no transfer | none — would require precise pre-stage |
| `is-shortfall false, delta > 0` (excess) | snpl has more than payoff | snpl → borrower `delta` (refund) | **9 (this one)** |

The refund branch is the only safety valve for sBTC that arrives on
the snpl outside the borrower's intended topup — a race condition that
*will* happen in production whenever Jing returns dust late, a
borrower frontend miscalculates the topup, or a third party sends
sBTC to the snpl by mistake. Without this branch, that sBTC would be
locked in the snpl forever (no admin extraction; the snpl has no
sweep function). Sim 9 confirms the branch fires correctly with a
real Jing settlement upstream and routes the excess back to the
borrower as the only legitimate beneficiary.

---

## Sim 10: set-swap-limit relay (`simul-loan-snpl-set-swap-limit.js`)

The first sim to exercise `snpl.set-swap-limit`. The snpl wraps Jing's
`set-sbtc-limit` in an empty `as-contract?` block — when the borrower
calls `set-swap-limit(loan-id, new-limit)`, the snpl updates its loan
record's `limit-price` field then forwards via as-contract to Jing. This
is the only stxer-feasible way to verify Jing v2's `set-sbtc-limit`
accepts a relayed call from a contract depositor (the snpl is recorded
as the cycle-8 depositor via the original `deposit-sbtc` tx, also done
under as-contract).

```bash
npx tsx simulations/simul-loan-snpl-set-swap-limit.js
```

**Stxer**: https://stxer.xyz/simulations/mainnet/3b35937fad682a0845cc77d2974fe032

### Flow

```
[deploy + init + seed + supply + open-line + borrow + swap-deposit at LIMIT_INITIAL]
BORROWER.set-swap-limit(1, LIMIT_BUMPED)
  -> snpl maps-set loan { limit-price: LIMIT_BUMPED }
  -> snpl as-contract? -> Jing.set-sbtc-limit(LIMIT_BUMPED)
  -> Jing emits (event "set-sbtc-limit" (depositor snpl) (limit LIMIT_BUMPED))
BORROWER.cancel-swap(1)                [no economic change vs Sim 1]
BORROWER.repay(1, reserve)             [standard flow]
LENDER.withdraw-sbtc(22.198M)
```

### Key proof points

| Step | Evidence |
|---|---|
| 12 | Initial `swap-deposit` records limit `u31152648000000` on both snpl loan record and Jing's depositor metadata |
| 13 | `(get-loan u1)` shows `limit-price u31152648000000` |
| 15 | `set-swap-limit(1, u32000000000000)`: **`(ok true)`** with TWO events — Jing's `set-sbtc-limit` log (`depositor = snpl`, `limit u32000000000000`) and snpl's own `set-swap-limit` print event |
| 16 | `(get-loan u1)` AFTER set-swap-limit: `limit-price u32000000000000` ← snpl's `map-set` ran cleanly; loan record is in sync with Jing's stored limit |
| 17 | `cancel-swap`: real `refund-sbtc u22000000` from Jing → snpl, normal flow (proves no state desync from the limit change) |
| 18 | `repay`: standard 3-transfer flow (220k borrower→snpl, 22k snpl→JING_TREASURY, 22.198M snpl→reserve), `fee-sbtc u22000`, `lender-payoff-sbtc u22198000`, `stx-released u0` |
| 19 | Final loan record persists `limit-price u32000000000000` and `status u1` REPAID — the bumped value is what stays as on-chain history |
| 23 | LENDER end at `u23198000` (+198k net) — unchanged from Sim 1, confirming the limit relay has no economic side-effects on the cancel-swap path |

### Real-world significance

`set-swap-limit` is the only mutation path for an active Jing position
short of canceling the entire deposit. In production, a borrower might
want to bump their limit if the auction's clearing price is moving
away from their original floor (limit too low → STX side won't cross,
sBTC rolls indefinitely). Without this relay, the only recourse would
be `cancel-swap` + redeposit — which costs gas and creates a window
where the snpl's sBTC sits idle.

Jing's `set-sbtc-limit` requires `tx-sender` to match the cycle's
existing depositor record. Since the snpl deposited under as-contract
(making the snpl the depositor of record), the relay must also fire
under as-contract — which is exactly what the snpl does. This sim
confirms that Jing's depositor-recognition and the snpl's as-contract
context are compatible across the original deposit and the limit
update.

### Stxer-mode tweak required mid-sim

The first run failed at step 15 with `(err u110)` ERR-PAST-DEADLINE.
The stxer copy had only commented out the deadline gate in
`swap-deposit` (line 185); the equivalent gate in `set-swap-limit`
(line 224) was still active and tripped immediately under `CLAWBACK-
DELAY u0`. Fix was to comment out line 224 too — symmetric stxer
accommodation. Production keeps both checks; deadline enforcement on
both paths is clarinet's responsibility.

---

## Stxer coverage exhausted — moving to Clarinet

The eight sims above cover every branch that depends on real mainnet
Jing/Pyth/sBTC interaction, multi-actor concurrency, or canonical
bytecode demonstrations. The remaining branches don't depend on any of
that — they're pure state-machine paths that clarinet can validate at
much lower cost (and with block-advance support that stxer's
single-block fork model can't provide).

**Migrating to clarinet** for:

- **Errors bundle**: `ERR-NOT-LENDER`, `ERR-NOT-BORROWER`, `ERR-NOT-DEPLOYER`, `ERR-ALREADY-INIT`, `ERR-PAUSED`, `ERR-OVER-LIMIT`, `ERR-INVALID-AMOUNT`, `ERR-LINE-EXISTS`, `ERR-LINE-NOT-FOUND`, `ERR-OUTSTANDING-NONZERO`, `ERR-UNDERFLOW`, `ERR-BORROWER-MISMATCH`, `ERR-INTEREST-MISMATCH`, `ERR-NO-CREDIT-LINE`, `ERR-LOAN-NOT-FOUND`, `ERR-BAD-STATUS`. `ERR-WRONG-RESERVE` (u113) and `ERR-ACTIVE-LOAN-EXISTS` (u104) already exercised in Sim 6.
- **Admin setters**: `set-credit-line-cap`, `set-credit-line-interest`, `set-min-sbtc-draw`, `set-paused` + draw-while-paused, `close-credit-line` happy path + ERR-OUTSTANDING-NONZERO guard.
- **SAINT sentinel guards**: pre-init reverts on every gated function.
- **Slippage protection**: `set-credit-line-interest` + stale `expected-bps` in `borrow` → ERR-INTEREST-MISMATCH.
- **Cap / min-draw enforcement**: borrow > cap → ERR-OVER-LIMIT; borrow < min → ERR-INVALID-AMOUNT.
- **Block-advance dependent (stxer can't do these at all)**:
  - `swap-deposit` / `set-swap-limit` past deadline → `ERR-PAST-DEADLINE`. The stxer copy comments out these guards because the single-block fork puts deadline = current burn-block-height; clarinet can advance past deadline and prove the production gate fires.
  - `seize` before deadline → `ERR-DEADLINE-NOT-REACHED`. Same reason — production has `CLAWBACK-DELAY u4200` (~29 days); clarinet can run mock-block-advance to test partial elapse.
  - `cancel-swap` borrower-only-pre-deadline branch (the OR's left side enforced standalone). Sim 5 hit the lender-post-deadline branch.
