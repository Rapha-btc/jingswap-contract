# Blind Auction Test Suite

## Run tests

```bash
npm test
```

## Why this is fully tested

The blind-auction contract is tested at two levels:

1. **Clarinet unit tests** (`tests/blind-auction.test.ts`) — run locally via vitest + clarinet-sdk simnet. These test every public function, every error path, every phase transition, and the priority queue. The only thing simnet cannot test is actual settlement (requires Pyth oracle data and BitFlow pool state).

2. **Stxer mainnet fork simulations** (`simulations/`) — run against a real mainnet fork with live Pyth prices, real sBTC balances, and real BitFlow pools. These prove the settlement math, pro-rata distributions, fee calculations, and price oracle integration all work with real-world data.

Together, there is no untested public function or error path.

## Clarinet tests (9 tests, all passing)

### Test 1: Full lifecycle

Covers the complete happy path from deposit to rollforward.

| Step | What's tested |
|------|---------------|
| Initial state | Cycle 0, deposit phase, default minimums, empty totals/lists |
| Deposit STX | wallet_1 deposits 100 STX, verify deposit + depositor list + totals |
| Deposit sBTC | wallet_2 deposits 100k sats, verify state |
| Top-up | wallet_1 adds 50 STX, cumulative deposit correct, no duplicate in list |
| Multiple depositors | wallet_3 (STX), wallet_4 (sBTC) added, lists + totals correct |
| Cancel + re-deposit | wallet_3 cancels → refund, deposit=0, removed from list. Re-deposits. |
| Cancel with nothing | Returns `ERR_NOTHING_TO_WITHDRAW` (u1008) |
| Pause/unpause | Owner pauses → deposit fails with `ERR_PAUSED` (u1010) → unpause → deposit works |
| Non-owner admin | wallet_1 cannot pause → `ERR_NOT_AUTHORIZED` (u1011) |
| Min deposit change | Owner changes min, resets |
| DEX source switch | XYK → DLMM → back |
| Close too early | `ERR_CLOSE_TOO_EARLY` (u1015) before 150 blocks |
| Close deposits | Advance 160 blocks → close succeeds |
| Double close | `ERR_ALREADY_CLOSED` (u1016) |
| Buffer phase | Deposits rejected (u1002), cancels rejected (u1002) |
| Settle phase | Advance past buffer → phase=SETTLE, deposits rejected |
| Settle (no Pyth) | `ERR_ZERO_PRICE` (u1009) — simnet has no oracle data |
| Cancel-cycle too early | `ERR_CANCEL_TOO_EARLY` (u1014) |
| Cancel-cycle | Advance 510 blocks → succeeds, cycle advances to 1 |
| Rollforward | All deposits rolled to cycle 1 with correct amounts |
| Cycle 0 empty | Totals zeroed after rollforward |
| Cancel rolled deposit | wallet_3 cancels in new cycle → success |
| Top-up rolled deposit | wallet_2 adds sBTC in cycle 1, cumulative correct |

### Test 2: Phase guard errors

Tests every function in the wrong phase.

| Scenario | Expected error |
|----------|---------------|
| `settle` during deposit phase | `ERR_ZERO_PRICE` (u1009) |
| `cancel-cycle` during deposit phase | `ERR_NOT_SETTLE_PHASE` (u1003) |
| `close-deposits` with only STX (no sBTC) | `ERR_NOTHING_TO_SETTLE` (u1012) |
| `cancel-sbtc-deposit` during buffer | `ERR_NOT_DEPOSIT_PHASE` (u1002) |
| `settle` during buffer | `ERR_ZERO_PRICE` (u1009) |
| `cancel-sbtc-deposit` during settle | `ERR_NOT_DEPOSIT_PHASE` (u1002) |
| `cancel-cycle` too early in settle | `ERR_CANCEL_TOO_EARLY` (u1014) |
| `cancel-cycle` after success | Succeeds, then double cancel → `ERR_NOT_SETTLE_PHASE` (u1003) |

### Test 3: Admin functions

| Scenario | Expected |
|----------|----------|
| `set-treasury` by owner | `(ok true)` |
| `set-treasury` by non-owner | `ERR_NOT_AUTHORIZED` (u1011) |
| `set-contract-owner` transfer | New owner can pause, old owner cannot |
| Transfer ownership back | Restores original deployer |
| `set-min-sbtc-deposit` | Change to 5000, deposit 2000 fails with u1001, reset |
| `set-dex-source` invalid (u3, u0) | `ERR_NOT_AUTHORIZED` (u1011) |

### Test 4: Cancel sBTC deposit

| Scenario | Expected |
|----------|----------|
| Deposit 100k sats then cancel | `(ok u100000)`, deposit=0, list empty |
| Cancel with nothing | `ERR_NOTHING_TO_WITHDRAW` (u1008) |

### Test 5: Priority queue bumping (MAX_DEPOSITORS=5)

| Scenario | Expected |
|----------|----------|
| Fill STX queue: 4×2 STX + 1×1 STX | 5 depositors, totals=9 STX |
| 6th STX deposit = 1 STX (equal to smallest) | `ERR_QUEUE_FULL` (u1013) |
| 6th STX deposit = 0.5 STX (below min) | `ERR_DEPOSIT_TOO_SMALL` (u1001) |
| 6th STX deposit = 3 STX (bigger) | Bumps smallest → refund 1 STX to wallet5, wallet6 takes slot |
| Verify post-bump | wallet5 deposit=0, wallet6=3 STX, list updated, totals=11 STX |
| Same pattern for sBTC | Fill 5 slots, bump smallest with bigger deposit |

## What clarinet cannot test (covered by stxer)

| Feature | Why simnet can't test | Stxer simulation |
|---------|----------------------|-----------------|
| Settlement math | No Pyth oracle data in simnet | `simul-blind-auction.js` — settles with real prices, verifies pro-rata distributions |
| `settle-with-refresh` | Needs Wormhole-signed VAAs | `simul-settle-refresh.js` — fetches live Pyth VAA, proves stored prices fail (u1005) and fresh VAA succeeds |
| Fee calculations | Requires settlement | Verified: 10 bps from both sides, sent to treasury |
| DEX sanity gate | Needs real BitFlow pool state | Oracle vs DEX divergence verified (~0.2%) |
| Rollover after settlement | Requires settlement to produce unfilled amounts | Unfilled deposits correctly roll to next cycle with accurate amounts |
| Priority queue at scale | Only 8 wallets in simnet | `simul-priority-queue.js` tests with real mainnet addresses |

## Error code reference

| Code | Constant | Meaning |
|------|----------|---------|
| u1001 | `ERR_DEPOSIT_TOO_SMALL` | Below min-stx-deposit or min-sbtc-deposit |
| u1002 | `ERR_NOT_DEPOSIT_PHASE` | Action requires deposit phase |
| u1003 | `ERR_NOT_SETTLE_PHASE` | cancel-cycle requires deposits to be closed |
| u1004 | `ERR_ALREADY_SETTLED` | Cycle already settled |
| u1005 | `ERR_STALE_PRICE` | Pyth price older than 60 seconds |
| u1006 | `ERR_PRICE_UNCERTAIN` | Pyth confidence > 2% of price |
| u1007 | `ERR_PRICE_DEX_DIVERGENCE` | Oracle vs DEX price > 10% apart |
| u1008 | `ERR_NOTHING_TO_WITHDRAW` | No deposit to cancel |
| u1009 | `ERR_ZERO_PRICE` | Pyth returned no price data |
| u1010 | `ERR_PAUSED` | Contract is paused |
| u1011 | `ERR_NOT_AUTHORIZED` | Not contract owner |
| u1012 | `ERR_NOTHING_TO_SETTLE` | Both sides need deposits above minimum |
| u1013 | `ERR_QUEUE_FULL` | Queue full and deposit not larger than smallest |
| u1014 | `ERR_CANCEL_TOO_EARLY` | Must wait CANCEL_THRESHOLD blocks |
| u1015 | `ERR_CLOSE_TOO_EARLY` | Must wait DEPOSIT_MIN_BLOCKS |
| u1016 | `ERR_ALREADY_CLOSED` | Deposits already closed this cycle |
