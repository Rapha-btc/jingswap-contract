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
| 15 | Fund STX_USER_2 with 100 STX | ok |
| 16 | STX_USER_2 deposit 50 STX | ok |
| 17 | Close deposits | ok |
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

**Results: ALL GREEN (38/38 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/a86a493f41a05fc634e831318a001b90

**Key verifications:**
- Limits cleared on cancel (steps 10-11) ✓
- Limits persist across cancel-cycle rollover (steps 30-31) ✓
- Cancel rejected during settle phase with ERR_NOT_DEPOSIT_PHASE (steps 18-19) ✓
- Cancel-cycle rolls deposits + depositor lists to next cycle (steps 24-29) ✓
- Rolled deposits can be cancelled in the new cycle (steps 33-34) ✓

**Note:** STX_USER_2 is funded via STX transfer before depositing (step 15). The original blind-auction cancel-flows had the same gap.

---

### 3. Priority Queue (`simul-blind-premium-priority-queue.js`)

Ported from `simul-priority-queue.js`. Tests queue bumping with MAX_DEPOSITORS=5. Verifies bumped depositor's limit is also cleared.

| Step | Action | Result |
|------|--------|--------|
| 2-9 | Fund 8 addresses with 10 STX each | ok |
| 10-17 | Fund 8 addresses with 10k sats each | ok |
| 18-22 | Fill STX queue: 4x2 STX + 1x1 STX | ok, totals=9 STX |
| 23-27 | Fill sBTC queue: 4x2000 + 1x1000 sats | ok, totals=9000 sats |
| 28-30 | Read queue lengths + totals | 5 each, (stx:9M, sbtc:9000) |
| 31 | 6th STX 0.5 STX (below min) | (err u1001) ERR_DEPOSIT_TOO_SMALL |
| 32 | 6th STX 3 STX (bumps ADDR[4]) | ok, bumped=SP119..., 1 STX returned |
| 33 | 6th sBTC 500 sats (below min) | (err u1001) ERR_DEPOSIT_TOO_SMALL |
| 34 | 6th sBTC 3000 sats (bumps ADDR[4]) | ok, bumped=SP119..., 1000 sats returned |
| 35-36 | Queue lengths after bump | still 5 each |
| 37 | ADDR[4] STX deposit | u0 (bumped out) |
| 38 | ADDR[6] STX deposit | u3000000 (new, 3 STX) |
| 39 | ADDR[4] sBTC deposit | u0 (bumped out) |
| 40 | ADDR[7] sBTC deposit | u3000 (new) |
| 41 | Totals after bump | (stx:11M, sbtc:11000) |
| 42 | Bumped ADDR[4] limit | u0 (cleared on bump) |
| 43 | Close deposits | ok |
| 44 | Settle | ok, see below |
| 45 | Settlement record | price=33371404794442 (20 bps) |
| 46 | Cycle | u1 |
| 47 | Cycle 1 totals | (sbtc:7701, stx:0) |
| 48-49 | Cycle 1 depositor lists | stx=empty, sbtc=5 rolled depositors |

**Results: ALL GREEN (49/49 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/9dfc0bdf8565865b2dc6b2899e5135a7

**Settlement details (step 44):**

| Field | Value |
|-------|-------|
| clearing-price | 33,371,404,794,442 (20 bps premium) |
| binding-side | "stx" |
| stx-cleared | 11,000,000 (11 STX, 100%) |
| sbtc-cleared | 3,296 sats (~30% of 11,000) |
| sbtc-unfilled | 7,704 sats |
| stx-fee | 11,000 (0.1%) |
| sbtc-fee | 3 sats (0.1%) |

**Pro-rata distribution (5 depositors per side):**

STX depositors (receive sBTC):
- ADDR[0-3] (2 STX each, 2/11 share): 598 sats each
- ADDR[6] (3 STX, 3/11 share): 898 sats
- Total paid: 3,290 sats + 3 dust → treasury

sBTC depositors (receive STX, unfilled rolled):
- ADDR[0-3] (2000 sats each): 1,998,000 uSTX + 1,400 sats rolled
- ADDR[7] (3000 sats): 2,997,000 uSTX + 2,101 sats rolled
- Total STX paid: 10,989,000 = 11M - 11k fee ✓
- Total rolled: 4x1400 + 2101 = 7,701 sats (matches cycle 1 totals, 7704 - 3 roll dust)

**Dust sweep:** sbtc-dust=6 (3 payout + 3 roll) → swept to treasury. stx-dust=0.

**Key verifications:**
- Bumped depositor (ADDR[4]) gets STX + sBTC refunded immediately ✓
- Bumped depositor's limit cleared (step 42 = u0) ✓
- Queue stays at MAX_DEPOSITORS=5 after bump ✓
- Pro-rata distribution scales correctly with unequal deposit sizes ✓
- Dust sweep handles rounding remainders ✓

---

### 4. Same Depositor Both Sides (`simul-blind-premium-same-depositor.js`)

Ported from `simul-same-depositor.js`. Single address deposits on both STX and sBTC sides. Verifies separate limits per side for the same principal.

| Step | Action | Result |
|------|--------|--------|
| 2 | Fund depositor with 200 STX | ok |
| 3 | Same address deposits 100 STX (limit=permissive) | ok |
| 4 | Same address deposits 100k sats (limit=1) | ok |
| 5 | Read totals | (stx:100M, sbtc:100k) |
| 6 | STX depositors | [SP2C7...] (same address) |
| 7 | sBTC depositors | [SP2C7...] (same address) |
| 8 | STX limit for depositor | u99999999999999 |
| 9 | sBTC limit for depositor | u1 |
| 10 | Close deposits | ok |
| 11 | Settle | ok, see below |
| 12 | Settlement record | price=33371404794442, stx-cleared=100M |
| 13 | Cycle | u1 |
| 14 | Cycle 1 totals | (sbtc:70035, stx:0) |
| 15 | STX deposit cycle 1 | u0 (fully filled) |
| 16 | sBTC deposit cycle 1 | u70035 (unfilled rolled) |

**Results: ALL GREEN (16/16 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/f8f5667020981db3744579821ebc9630

**Settlement details (step 11):**

| Field | Value |
|-------|-------|
| clearing-price | 33,371,404,794,442 (20 bps premium) |
| binding-side | "stx" |
| stx-cleared | 100,000,000 (100 STX, 100%) |
| sbtc-cleared | 29,965 sats (~30% of 100k) |
| sbtc-unfilled | 70,035 sats |
| stx-fee | 100,000 (0.1%) |
| sbtc-fee | 29 sats (0.1%) |

**Same-address distribution:**
- As STX depositor: received 29,936 sats sBTC (29,965 - 29 fee)
- As sBTC depositor: received 99,900,000 uSTX (100M - 100k fee), 70,035 sats unfilled rolled

**Key verifications:**
- Same principal appears in both depositor lists independently ✓
- Separate limits per side for same address (stx-limit vs sbtc-limit) ✓
- Settlement distributes correctly to same address on both sides ✓
- Zero dust (1 depositor per side = no rounding) ✓

---

### 5. Settle-with-Refresh + Bundled Close-and-Settle (`simul-blind-premium-settle-refresh.js`)

Ported from `simul-settle-refresh.js` with added Part B testing `close-and-settle-with-refresh`. Uses real `MAX_STALENESS u80` (not the relaxed stxer value) and fetches a live Pyth VAA from Hermes.

| Step | Action | Result |
|------|--------|--------|
| 1 | Deploy (real MAX_STALENESS u80, zeroed blocks) | ok |
| 2 | Deposit 100 STX (permissive limit) | ok |
| 3 | Deposit 100k sats (permissive limit) | ok |
| 4 | Close deposits | ok |
| 5 | Phase | u2 (SETTLE) |
| 6 | settle (stored prices) | **(err u1005)** ERR_STALE_PRICE ✓ |
| 7 | settle-with-refresh (fresh VAA) | ok, see below |
| 8 | Settlement record | price=33494932248938 |
| 9 | Cycle | u1 |
| 10 | Phase | u0 (DEPOSIT) |
| 11 | DEX price | 33,271,382,492,360 |
| 12 | Deposit 100 STX in cycle 1 | ok |
| 13 | Deposit 100k sats in cycle 1 | ok (total=170,145 incl. 70,145 rolled) |
| 14 | **close-and-settle-with-refresh** (bundled) | **ok, one tx** ✓ |
| 15 | Settlement record cycle 1 | price=33494932248938 |
| 16 | Cycle | u2 |
| 17 | Cycle 2 totals | (sbtc:140,290, stx:0) |

**Results: ALL GREEN (17/17 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/d72ce9d43bc80d9ffb50ca1de2caa110

**Part A: settle-with-refresh (separate close + settle)**

Pyth prices refreshed via VAA: BTC=$71,790.52, STX=$0.2139

| Field | Value |
|-------|-------|
| oracle-price | 33,562,056,361,662 |
| clearing-price | 33,494,932,248,938 |
| premium check | 33,562,056,361,662 * 9980/10000 = 33,494,932,248,938 ✓ |
| stx-cleared | 100,000,000 (100%) |
| sbtc-cleared | 29,855 sats |
| sbtc-unfilled | 70,145 sats → rolled to cycle 1 |

- `settle` correctly fails with ERR_STALE_PRICE (u1005) when stored Pyth prices exceed MAX_STALENESS u80 ✓
- `settle-with-refresh` succeeds with fresh VAA ✓
- Runtime: ~122.7M (well within Clarity budget)

**Part B: close-and-settle-with-refresh (bundled, one tx)**

Step 14 event log shows both operations in sequence:
1. `close-deposits` event (cycle 1, closed-at-block=7568794)
2. Settlement event (same clearing price, same oracle)

- sBTC in cycle 1: 170,145 sats (100k fresh + 70,145 rolled from cycle 0)
- sbtc-cleared: 29,855 sats, sbtc-unfilled: 140,290 → rolled to cycle 2
- Runtime: ~122.7M (essentially same as separate settle-with-refresh)
- Cycle advanced to 2 ✓

**Key verifications:**
- `settle` rejects stale stored prices with ERR_STALE_PRICE when MAX_STALENESS=80 ✓
- `settle-with-refresh` passes staleness gate with fresh Pyth VAA ✓
- `close-and-settle-with-refresh` bundles both operations atomically in one tx ✓
- Bundled runtime (~122.7M) is essentially identical to separate settle-with-refresh ✓
- Rolled sBTC from cycle 0 accumulates with fresh deposits in cycle 1 ✓
- Pyth refresh fee: 2 uSTX paid to Pyth deployer ✓

---

### 6. Limit-Price Filter (`simul-blind-premium-limit-filter.js`)

**NEW** -- tests per-depositor limit filtering, the core blind-premium feature.

| Step | Action | Result |
|------|--------|--------|
| 2-9 | Fund 4 addresses with 50 STX + 50k sats each | ok |
| 10 | ADDR_A: deposit 10 STX, limit=1,000,000,000 (~10 STX/BTC, tight) | ok |
| 11 | ADDR_B: deposit 10 STX, limit=99,999,999,999,999 (permissive) | ok |
| 12 | ADDR_C: deposit 10k sats, limit=99,999,999,999,999 (tight -- wants absurd min) | ok |
| 13 | ADDR_D: deposit 10k sats, limit=1 (permissive) | ok |
| 14 | Totals | (stx:20M, sbtc:20k) |
| 15-18 | Read all 4 limits | confirmed as set |
| 19 | ADDR_B: set-stx-limit to 50T | ok, updated |
| 20 | Read ADDR_B limit | u50000000000000 |
| 21 | ADDR_B: set-stx-limit to u0 | **(err u1017)** ERR_LIMIT_REQUIRED |
| 22 | ADDR_A: deposit-stx with limit=u0 | **(err u1017)** ERR_LIMIT_REQUIRED |
| 23 | Close deposits | ok |
| 24 | Settle | ok, see below |
| 25 | Settlement record | price=33371404794442, stx-cleared=10M |
| 26 | Cycle | u1 |
| 27 | Cycle 1 totals | (stx:10M, sbtc:17004) |
| 28 | ADDR_A STX in cycle 1 | u10000000 (rolled) |
| 29 | ADDR_B STX in cycle 1 | u0 (filled) |
| 30 | ADDR_C sBTC in cycle 1 | u10000 (rolled) |
| 31 | ADDR_D sBTC in cycle 1 | u7004 (unfilled portion rolled) |
| 32 | STX depositors cycle 1 | [ADDR_A] |
| 33 | sBTC depositors cycle 1 | [ADDR_C, ADDR_D] |
| 34 | ADDR_A limit persisted | u1000000000 |
| 35 | ADDR_C limit persisted | u99999999999999 |

**Results: ALL GREEN (35/35 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/2bed5216ffe6fbd424d173ab343ec044

**Limit filtering in action (step 24 events):**

| Depositor | Side | Limit | Clearing | Condition | Outcome |
|-----------|------|-------|----------|-----------|---------|
| ADDR_A | STX | 1,000,000,000 (~10 STX/BTC) | 33,371,404,794,442 | clearing > limit | ROLLED (`limit-roll-stx`) |
| ADDR_B | STX | 50,000,000,000,000 (~500k STX/BTC) | 33,371,404,794,442 | clearing < limit | FILLED |
| ADDR_C | sBTC | 99,999,999,999,999 (~999k STX/BTC) | 33,371,404,794,442 | clearing < limit | ROLLED (`limit-roll-sbtc`) |
| ADDR_D | sBTC | 1 | 33,371,404,794,442 | clearing > limit | FILLED |

**Premium verification:** 33,438,281,357,157 * 9980 / 10000 = 33,371,404,794,442 ✓ (exact match)

**Settlement after filtering (only ADDR_B + ADDR_D remain):**

| Field | Value |
|-------|-------|
| stx-cleared | 10,000,000 (10 STX, ADDR_B only) |
| sbtc-cleared | 2,996 sats |
| sbtc-unfilled | 7,004 sats |
| stx-fee | 10,000 (0.1%) |
| sbtc-fee | 2 sats (0.1%) |

**Distribution:**
- ADDR_B: received 2,994 sats sBTC (2,996 - 2 fee)
- ADDR_D: received 9,990,000 uSTX (10M - 10k fee), 7,004 sats unfilled rolled

**Cycle 1 breakdown:**
- ADDR_A: 10M STX rolled (limit-violated)
- ADDR_C: 10,000 sats rolled (limit-violated)
- ADDR_D: 7,004 sats rolled (unfilled portion)
- Total: stx=10M, sbtc=17,004 (10,000 + 7,004) ✓

**Key verifications:**
- `ERR_LIMIT_REQUIRED (u1017)` rejects u0 in both set-stx-limit and deposit-stx ✓
- Tight limits cause depositors to be rolled BEFORE settlement math runs ✓
- Settlement totals reflect post-filter amounts (only filled depositors counted) ✓
- Rolled depositors' limits persist in cycle 1 ✓
- Unfilled portion of FILLED depositor (ADDR_D) also rolled to cycle 1 ✓

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

### Ported from blind-auction (results below)

- [x] **Dust filter with premium** -- `simul-blind-premium-dust-filter.js`
- [x] **Dust sweep with premium (sBTC side)** -- `simul-blind-premium-dust-sweep.js`
- [x] **Dust sweep with premium (STX side)** -- `simul-blind-premium-dust-sweep-stx-side.js`
- [x] **Small-share filter** -- `simul-blind-premium-small-share-filter.js`

### Still need dedicated simulations

- [x] **Mixed limit outcomes in large batch** -- `simul-blind-premium-mixed-limits.js`
- [x] **Limit edge: clearing == limit exactly** -- `simul-blind-premium-limit-edge.js`

### 11. Mixed Limits (`simul-blind-premium-mixed-limits.js`)

5 depositors per side, 2 with tight limits (rolled) and 3 with permissive limits (filled) on each side. Verifies pro-rata distribution only among filled depositors.

| Depositor | Side | Amount | Limit | Outcome |
|-----------|------|--------|-------|---------|
| STX D0 | STX | 10 STX | tight (1B) | ROLLED (`limit-roll-stx`) |
| STX D1 | STX | 20 STX | permissive | FILLED → 5,987 sats |
| STX D2 | STX | 30 STX | tight (1B) | ROLLED (`limit-roll-stx`) |
| STX D3 | STX | 40 STX | permissive | FILLED → 11,974 sats |
| STX D4 | STX | 50 STX | permissive | FILLED → 14,968 sats |
| sBTC D0 | sBTC | 10k sats | permissive | FILLED → 13,736,250 STX + 5,879 rolled |
| sBTC D1 | sBTC | 20k sats | tight (99.9T) | ROLLED (`limit-roll-sbtc`) |
| sBTC D2 | sBTC | 30k sats | permissive | FILLED → 41,208,750 STX + 17,639 rolled |
| sBTC D3 | sBTC | 40k sats | permissive | FILLED → 54,945,000 STX + 23,519 rolled |
| sBTC D4 | sBTC | 50k sats | tight (99.9T) | ROLLED (`limit-roll-sbtc`) |

**Results: ALL GREEN (49/49 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/49504b7bffd1d4a7af13aae3b5e02d18

**Settlement after filtering:** stx-cleared=110M (D1+D3+D4), sbtc-cleared=32,962 (of 80k filled), binding="stx"

**Cycle 1 verification:**
- STX: 40M (10M D0 + 30M D2 rolled by limit) ✓
- sBTC: 117,037 (20k D1 + 50k D4 rolled by limit + 5,879+17,639+23,519 unfilled from D0+D2+D3) ✓
- STX depositors: [D0, D2] (limit-rolled only) ✓
- sBTC depositors: [D1, D4, D0, D2, D3] (limit-rolled + unfilled) ✓

---

### 12. Limit Edge (`simul-blind-premium-limit-edge.js`)

**Results:** _TBD_ (link: https://stxer.xyz/simulations/mainnet/220b278684d00fd39b074742d15ccc7d)

### 7. Dust Filter (`simul-blind-premium-dust-filter.js`)

Ported from `simul-dust-filter.js`. Tests that depositors below MIN_SHARE_BPS (0.20%) get rolled at close-deposits. STX whale (10,000 STX) + dust depositor (1 STX) + sBTC depositor (1,000 sats).

| Step | Action | Result |
|------|--------|--------|
| 3 | STX whale deposits 10,000 STX | ok |
| 4 | Dust depositor deposits 1 STX (~0.01% share) | ok |
| 5 | sBTC depositor deposits 1,000 sats | ok |
| 6 | Totals before close | (stx:10,001,000,000, sbtc:1000) |
| 7 | STX depositors | [whale, dust_depositor] |
| 8 | Close deposits | ok, `small-share-roll-stx` event for dust depositor |
| 9 | Totals after close | (stx:10,000,000,000, sbtc:1000) — dust removed |
| 10 | STX depositors after close | [whale only] |
| 11 | Dust depositor cycle 0 | u0 (rolled out) |
| 12 | Cycle 1 totals | (stx:1,000,000, sbtc:0) — dust rolled here |
| 13 | Dust depositor cycle 1 | u1,000,000 (1 STX intact) |
| 14 | Cycle 1 STX depositors | [dust_depositor] |
| 15 | Settle | ok, sBTC binding side |
| 16 | Settlement | price=33371404794442, stx-cleared=3,337,140, sbtc-cleared=1000 |
| 17 | Cycle | u1 |
| 18 | Cycle 1 totals | (stx:9,997,662,860, sbtc:0) — whale rolled + dust depositor |
| 19 | Dust depositor still in cycle 1 | u1,000,000 |

**Results: ALL GREEN (19/19 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/d5c8a98a99ea7ede4ac0e27ae927343d

**Key verifications:**
- `small-share-roll-stx` event fires for dust depositor at close-deposits ✓
- Dust depositor (0.01% share) rolled, whale (99.99%) stays ✓
- Settlement runs with whale only at premium-adjusted clearing price ✓
- Cycle 1: whale's unfilled STX (9,996,662,860) + dust depositor's rolled STX (1,000,000) = 9,997,662,860 ✓

---

### 8. Dust Sweep (`simul-blind-premium-dust-sweep.js`)

Ported from `simul-dust-sweep.js`. 3 depositors per side with odd amounts to maximize integer truncation. Verifies sweep-dust event collects all rounding remainders.

**Results: ALL GREEN (33/33 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/a260ee29903cd31746a6dc7511a40793

**Settlement (step 22):** clearing=33,371,404,794,442 (20 bps), STX binding, stx-cleared=100M, sbtc-cleared=29,965

**Pro-rata distribution with truncation:**

| Depositor | Share | sBTC received | STX received | sBTC rolled |
|-----------|-------|---------------|--------------|-------------|
| STX D1 (33.33%) | 33,333,333/100M | 9,978 | -- | -- |
| STX D2 (44.44%) | 44,444,444/100M | 13,304 | -- | -- |
| STX D3 (22.22%) | 22,222,223/100M | 6,652 | -- | -- |
| sBTC D1 (33.33%) | 33,333/100k | -- | 33,299,667 | 23,344 |
| sBTC D2 (44.44%) | 44,444/100k | -- | 44,399,556 | 31,126 |
| sBTC D3 (22.22%) | 22,223/100k | -- | 22,200,777 | 15,563 |

**Dust sweep:** sbtc-dust=4 (2 payout + 2 roll) swept to treasury. stx-dust=0.
**Cycle 1 totals:** sbtc=70,033 = 23,344+31,126+15,563 (exact sum, no inflation) ✓

---

### 9. Dust Sweep STX Side (`simul-blind-premium-dust-sweep-stx-side.js`)

Ported from `simul-dust-sweep-stx-side.js`. Heavy STX (~10k STX) vs light sBTC (4k sats) so sBTC is binding → large STX unfilled → STX roll dust.

**Results: ALL GREEN (30/30 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/4e73b8980b3d3baf19c7e4e37a22d25c

**Settlement (step 22):** binding-side="sbtc", clearing=33,371,404,794,442 (20 bps), sbtc-cleared=4,000 (100%), stx-cleared=13,348,561, stx-unfilled=9,986,651,439

**Pro-rata distribution:**

| Depositor | Side | Share | Received | Rolled |
|-----------|------|-------|----------|--------|
| STX D1 (33.33%) | STX | 3,333M/10B | 1,331 sats | 3,328,883,812 STX |
| STX D2 (44.44%) | STX | 4,444M/10B | 1,775 sats | 4,438,511,750 STX |
| STX D3 (22.22%) | STX | 2,222M/10B | 888 sats | 2,219,255,876 STX |
| sBTC D1 (33.33%) | sBTC | 1,333/4k | 4,443,959 STX | 0 (fully filled) |
| sBTC D2 (36.10%) | sBTC | 1,444/4k | 4,814,011 STX | 0 (fully filled) |
| sBTC D3 (30.58%) | sBTC | 1,223/4k | 4,077,241 STX | 0 (fully filled) |

**Dust sweep:** stx-dust=3 (2 payout + 1 roll), sbtc-dust=2 (2 payout + 0 roll) → both swept to treasury ✓
**Cycle 1:** stx=9,986,651,438 = sum(3,328,883,812 + 4,438,511,750 + 2,219,255,876) ✓, sbtc=0

---

### 10. Small-Share Filter (`simul-blind-premium-small-share-filter.js`)

Ported from `simul-small-share-filter.js`. Multi-cycle: 3 small fish (1 STX each, ~0.1% share) get rolled repeatedly until whale's STX is mostly cleared, then fish finally exceed 0.2% threshold and settle.

**Results: ALL GREEN (39/39 steps)**

Stxer link: https://stxer.xyz/simulations/mainnet/b05bf6453e3bbbd33d2a6bc0f5a74d47

**Cycle 0:** Whale=1000 STX, 3 fish=1 STX each (~0.1% share). sBTC=100k sats.
- Close: 3x `small-share-roll-stx` events → fish rolled to cycle 1 ✓
- Settle: sBTC binding, stx-cleared=333,714,047, whale gets 99,900 sats. Whale's unfilled 666M STX rolled.

**Cycle 1:** Whale=666M STX (rolled) + fish=3M STX. sBTC whale deposits 3 BTC.
- Close: 3x `small-share-roll-stx` again (fish=1M/669M ≈ 0.15% < 0.2%) → rolled to cycle 2 ✓
- Settle: STX binding, whale's 666M fully cleared. sBTC depositor gets 665.6M STX, 299.8M sats rolled.

**Cycle 2:** Fish=3M STX (only depositors left!). sBTC whale deposits 100k more sats.
- Close: NO small-share rolls! Fish are 33.3% each → above 0.2% ✓
- Settle: STX binding, stx-cleared=3M. Each fish receives 299 sats sBTC. Fish finally filled! ✓

**Key verifications:**
- Fish rolled in cycle 0 (0.1% < 0.2% threshold) ✓
- Fish rolled again in cycle 1 (0.15% < 0.2%) ✓
- Fish stay in cycle 2 (33.3% > 0.2%) and fill successfully ✓
- Limits persist across all 3 cycles without re-setting ✓
- Multi-cycle settlement math correct with premium at each cycle ✓

---

## Mainnet addresses used

| Role | Address | Holds |
|------|---------|-------|
| Deployer | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22` | -- |
| STX whale | `SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3` | ~18k STX |
| sBTC whale | `SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2` | ~40.5 BTC |
| STX user 2 | `SP1AE7DW1ZXBH983N89YY6VA5JKPFJWT89RFBPEAY` | funded per-sim |
| ADDR[0-7] | Various `SP0...` addresses | funded per-sim |
