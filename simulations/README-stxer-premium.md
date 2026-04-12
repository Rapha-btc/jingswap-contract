# blind-premium: Stxer Simulation Guide

Mainnet fork simulations for `blind-premium.clar` using [stxer.xyz](https://stxer.xyz).

Uses `blind-premium-stxer.clar` (zeroed block thresholds, relaxed staleness) for most tests. The settle-refresh simulation patches the production contract to keep `MAX_STALENESS u80` while zeroing block thresholds.

## Running

```bash
npx tsx simulations/simul-blind-premium.js
```

Each simulation prints a link to view results on stxer.xyz.

## Simulations

### 1. Full Lifecycle (`simul-blind-premium.js`)

Ported from `simul-blind-auction.js`. Tests the complete deposit -> close -> settle -> rollover flow with 20 bps premium clearing price.

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy blind-premium (stxer variant) | ok |
| 2 | STX depositor deposits 100 STX (limit=99999999999999) | ok, 100 STX transferred |
| 3 | sBTC depositor deposits 100k sats (limit=1) | ok, 100k sats transferred |
| 4 | Read cycle state | cycle=0, phase=0 (deposit), totals=(stx:100M, sbtc:100k) |
| 5 | Read limits | stx-limit=99999999999999, sbtc-limit=1 |
| 6 | STX depositor top-up +50 STX | ok, total=150M (150 STX) |
| 7 | Close deposits | ok, closed-at-block=7568791 |
| 8 | Read phase | u2 (PHASE_SETTLE, no buffer) |
| 9 | Settle (stored Pyth prices) | ok |
| 10 | Read settlement | see below |
| 11 | Verify cycle=1 | ok |
| 12 | Read DEX price | 33,271,382,492,360 |
| 13 | Cycle 1 rollover | sbtc=55,052 rolled, stx=0 (fully filled) |

**Results: ALL GREEN (27/27 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/048c1b6fae366b5ba53bf8793dc49f14

**Settlement details (step 9):**

| Field | Value | Notes |
|-------|-------|-------|
| oracle-price | 33,438,281,357,157 | ~334,382 STX/BTC |
| clearing-price | 33,371,404,794,442 | oracle * 9980/10000 (20 bps premium) |
| binding-side | "stx" | STX fully cleared, sBTC partially |
| stx-cleared | 150,000,000 | 150 STX (100%) |
| sbtc-cleared | 44,948 | ~44.9% of 100k sats |
| sbtc-unfilled | 55,052 | rolled to cycle 1 |
| stx-fee | 150,000 | 0.1% of 150M |
| sbtc-fee | 44 | 0.1% of 44,948 |

**Premium verification:** 33,438,281,357,157 * 9980 / 10000 = 33,371,404,794,442 ✓

**Distribution:**
- STX depositor received 44,904 sats sBTC (44,948 - 44 fee)
- sBTC depositor received 149,850,000 uSTX (150M - 150k fee), 55,052 sats unfilled rolled to cycle 1

**Cycle 1 state:**
- total-sbtc: 55,052, total-stx: 0
- sBTC depositor list: [SP2C7...], STX depositor list: empty
- Only unfilled sBTC rolled forward; STX side fully filled and cleared

---

### 2. Cancel Flows (`simul-blind-premium-cancel-flows.js`)

Ported from `simul-cancel-flows.js`. Tests cancel-deposit, wrong-phase cancels, and cancel-cycle rollforward. Also verifies limits are cleared on cancel and persist across cycle rollover.

| Step | Action | Result |
|------|--------|--------|
| 2 | Deposit 100 STX (limit=permissive) | ok |
| 3 | Deposit 100k sats (limit=1) | ok |
| 4 | Read totals | (stx:100M, sbtc:100k) |
| 5 | Cancel STX deposit | ok, 100 STX refunded |
| 6 | Cancel sBTC deposit | ok, 100k sats refunded |
| 7 | Read totals | (stx:0, sbtc:0) |
| 8-9 | Depositor lists | both empty |
| 10 | STX limit after cancel | u0 (cleared) |
| 11 | sBTC limit after cancel | u0 (cleared) |
| 12 | Cancel again (nothing) | (err u1008) ERR_NOTHING_TO_WITHDRAW |
| 13 | Re-deposit STX 100 | ok |
| 14 | Re-deposit sBTC 100k | ok |
| 15 | STX_USER_2 deposit 50 STX | **(err u1)** -- unfunded address, test gap |
| 16 | Close deposits | ok |
| 17 | Phase | u2 (SETTLE) |
| 18 | Cancel STX during settle | (err u1002) ERR_NOT_DEPOSIT_PHASE |
| 19 | Cancel sBTC during settle | (err u1002) ERR_NOT_DEPOSIT_PHASE |
| 20 | Totals before cancel-cycle | (stx:100M, sbtc:100k) |
| 21 | Cancel-cycle | ok, rolled stx:100M + sbtc:100k |
| 22 | Current cycle | u1 |
| 23 | Phase | u0 (DEPOSIT) |
| 24 | Cycle 1 totals | (stx:100M, sbtc:100k) -- rolled |
| 25 | STX_USER deposit in cycle 1 | u100000000 |
| 27 | SBTC_USER deposit in cycle 1 | u100000 |
| 28-29 | Depositor lists cycle 1 | [STX_USER], [SBTC_USER] |
| 30 | STX limit after rollover | u99999999999999 (persisted) |
| 31 | sBTC limit after rollover | u1 (persisted) |
| 32 | Cycle 0 totals | (0, 0) -- cleared |
| 33 | Cancel rolled STX in cycle 1 | ok, 100 STX refunded |
| 34 | Cancel rolled sBTC in cycle 1 | ok, 100k sats refunded |
| 35-37 | Final state | cycle 1 totals=(0,0), both lists empty |

**Results: 36/37 GREEN** (step 15 failed: STX_USER_2 unfunded on mainnet -- test gap, not contract bug)

Stxer link: https://stxer.xyz/simulations/mainnet/d99b175a4b2b1dda2a870a4629cefecf

**Key verifications:**
- Limits cleared on cancel (steps 10-11) ✓
- Limits persist across cancel-cycle rollover (steps 30-31) ✓
- Cancel rejected during settle phase with ERR_NOT_DEPOSIT_PHASE (steps 18-19) ✓
- Cancel-cycle rolls deposits + depositor lists to next cycle (steps 24-29) ✓
- Rolled deposits can be cancelled in the new cycle (steps 33-34) ✓

**Note:** Step 15 should fund STX_USER_2 before depositing. This was also an issue in the blind-auction cancel-flows simulation.

---

### 3. Priority Queue (`simul-blind-premium-priority-queue.js`)

Ported from `simul-priority-queue.js`. Tests queue bumping with MAX_DEPOSITORS=5. Verifies bumped depositor's limit is also cleared.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Fill 5 STX slots (4x2 STX + 1x1 STX) | queue full |
| 2 | Fill 5 sBTC slots (same pattern) | queue full |
| 3 | 6th STX deposit (0.5 STX) | ERR_DEPOSIT_TOO_SMALL |
| 4 | 6th STX deposit (3 STX) | bumps 1 STX depositor, limit cleared |
| 5 | 6th sBTC deposit (500 sats) | ERR_DEPOSIT_TOO_SMALL |
| 6 | 6th sBTC deposit (3000 sats) | bumps 1000 sats depositor |
| 7 | Close + settle | settlement with premium |
| 8 | Read cycle 1 rollover | unfilled amounts rolled |

**Results:** _TBD_

---

### 4. Same Depositor Both Sides (`simul-blind-premium-same-depositor.js`)

Ported from `simul-same-depositor.js`. Single address deposits on both STX and sBTC sides. Verifies separate limits per side for the same principal.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Fund depositor with STX | ok |
| 2 | Deposit STX (permissive limit) | ok |
| 3 | Deposit sBTC (permissive limit) | ok |
| 4 | Read both limits for same address | stx-limit != sbtc-limit |
| 5 | Close + settle | settlement with premium |
| 6 | Read cycle 1 rollover | unfilled side rolled |

**Results:** _TBD_

---

### 5. Settle-with-Refresh + Bundled Close-and-Settle (`simul-blind-premium-settle-refresh.js`)

Ported from `simul-settle-refresh.js` with added Part B testing `close-and-settle-with-refresh`. Uses real `MAX_STALENESS u80` (not the relaxed stxer value) and fetches a live Pyth VAA from Hermes.

| Step | Action | Expected |
|------|--------|----------|
| A1 | Deploy (real staleness, zeroed blocks) | ok |
| A2 | Deposit 100 STX + 100k sats | ok |
| A3 | Close deposits | ok |
| A4 | Try settle (stored prices) | ERR_STALE_PRICE (u1005) |
| A5 | settle-with-refresh (fresh VAA) | ok |
| A6 | Read settlement | price = oracle * 0.998 |
| B1 | Deposit into cycle 1 | ok |
| B2 | close-and-settle-with-refresh (bundled) | ok, one tx |
| B3 | Verify cycle advanced to 2 | cycle = 2 |

**Results:** _TBD_

---

### 6. Limit-Price Filter (`simul-blind-premium-limit-filter.js`)

**NEW** -- tests per-depositor limit filtering, the core blind-premium feature.

| Step | Action | Expected |
|------|--------|----------|
| 1 | ADDR_A: STX deposit, tight limit (~10 STX/BTC) | deposit ok |
| 2 | ADDR_B: STX deposit, permissive limit | deposit ok |
| 3 | ADDR_C: sBTC deposit, tight limit (wants absurdly high price) | deposit ok |
| 4 | ADDR_D: sBTC deposit, permissive limit | deposit ok |
| 5 | ADDR_B: set-stx-limit to 500k STX/BTC | ok |
| 6 | ADDR_B: set-stx-limit to u0 | ERR_LIMIT_REQUIRED (u1017) |
| 7 | ADDR_A: deposit-stx with u0 limit | ERR_LIMIT_REQUIRED (u1017) |
| 8 | Close + settle | settlement ok |
| 9 | ADDR_A in cycle 1 (rolled, limit too tight) | deposit = 10 STX |
| 10 | ADDR_B in cycle 1 (filled) | deposit = 0 |
| 11 | ADDR_C in cycle 1 (rolled, limit too tight) | deposit = 10k sats |
| 12 | ADDR_D in cycle 1 (filled) | deposit = 0 |
| 13 | Rolled depositors' limits persist | limits intact |

**Results:** _TBD_

---

## New features to test (blind-premium vs blind-auction)

These are the features added in blind-premium that don't exist in blind-auction and need simulation coverage:

### Already covered above

- [x] **20 bps premium clearing price** -- all lifecycle simulations verify `price = oracle * 0.998`
- [x] **Mandatory non-zero limit prices** -- limit-filter simulation tests `ERR_LIMIT_REQUIRED` for u0
- [x] **Per-depositor limit filtering** -- limit-filter simulation tests tight vs permissive limits, verify rolled vs filled
- [x] **`set-stx-limit` / `set-sbtc-limit`** -- limit-filter simulation tests mid-cycle limit update
- [x] **Limit persistence across rollover** -- cancel-flows and limit-filter verify limits survive cycle rolls
- [x] **Limit cleared on cancel/bump** -- cancel-flows verifies limits cleared, priority-queue verifies bumped limit cleared
- [x] **`close-and-settle-with-refresh` bundled function** -- settle-refresh Part B tests the one-tx flow
- [x] **No buffer phase** -- all simulations go directly from close to settle (no PHASE_BUFFER)

### Still need dedicated simulations

- [ ] **Dust sweep with premium math** -- adapt `simul-dust-sweep.js` for premium clearing price. Pro-rata rounding may differ at 20 bps premium vs 0 bps.
- [ ] **Small-share filter with limits** -- adapt `simul-small-share-filter.js`. Test interaction: does a depositor below MIN_SHARE_BPS get rolled BEFORE limit filtering, or does order matter?
- [ ] **Mixed limit outcomes in large batch** -- 5 depositors per side with varying limits (some tight, some permissive), verify correct pro-rata distribution among filled depositors only.
- [ ] **Limit edge: clearing == limit exactly** -- STX side: `clearing == limit` should fill (not roll, since `clearing > limit` is the roll condition). sBTC side: `clearing == limit` should fill (since `clearing < limit` is the roll condition). Verify boundary behavior.

## Mainnet addresses used

| Role | Address | Holds |
|------|---------|-------|
| Deployer | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22` | -- |
| STX whale | `SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3` | ~18k STX |
| sBTC whale | `SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2` | ~40.5 BTC |
| STX user 2 | `SP1AE7DW1ZXBH983N89YY6VA5JKPFJWT89RFBPEAY` | funded per-sim |
| ADDR[0-7] | Various `SP0...` addresses | funded per-sim |
