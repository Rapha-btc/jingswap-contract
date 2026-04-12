# sbtc-stx-v2 Clarinet Test Suite

Unit tests for the deployed Jing v2 blind auction contracts using Clarinet SDK with `remote_data` (mainnet fork).

**Contracts under test:**
- `sbtc-stx-0-v2` — Zero premium: clearing price = oracle price
- `sbtc-stx-20-v2` — 20bps premium: clearing price = oracle * (1 - 20/10000)

**Deployed as:**
- `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2`
- `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-20-jing-v2`

## Running

```bash
# Run each file individually (required — see Known Issues)
npx vitest run tests/sbtc-stx-0-v2.test.ts
npx vitest run tests/sbtc-stx-20-v2.test.ts
```

Requires `remote_data.enabled = true` in `Clarinet.toml`. Tests skip automatically when remote_data is off.

## Configuration

The local v2 contracts have `MAX_STALENESS` relaxed to `u999999999` so mainnet Pyth prices from the fork remain valid. All other constants match the deployed contracts exactly:

| Constant | Value | What it gates |
|----------|-------|---------------|
| `DEPOSIT_MIN_BLOCKS` | `u10` | Min blocks before close-deposits (~20s) |
| `CANCEL_THRESHOLD` | `u42` | Blocks after close before cancel-cycle allowed (~84s) |
| `MAX_DEPOSITORS` | `u50` | Priority queue cap per side |
| `FEE_BPS` | `u10` | 10bps fee on cleared amounts |
| `MIN_SHARE_BPS` | `u20` | Deposits below 0.2% of pool are rolled on close |
| `PREMIUM_BPS` | `u20` | 20bps premium (sbtc-stx-20-v2 only) |
| `MAX_STALENESS` | `u999999999` | Relaxed for testing (deployed: `u80`) |

## Test Scenarios

### sbtc-stx-0-v2.test.ts (16 tests)

| # | Test | What's verified | Status |
|---|------|-----------------|--------|
| 1 | initial state | Cycle 0, deposit phase, zero totals, XYK dex source | PASS |
| 2 | rejects deposits below minimum | `ERR_DEPOSIT_TOO_SMALL` (u1001) for STX < 1M | PASS |
| 3 | rejects zero limit price | `ERR_LIMIT_REQUIRED` (u1017) | PASS |
| 4 | STX: deposit, top-up, cancel, re-deposit | Deposit tracking, cumulative top-up, no duplicate in depositor list, cancel refund, cancel-nothing error | PASS |
| 5 | sBTC: deposit, cancel, re-deposit | Same as STX side with sBTC token transfers via whale funding | PASS |
| 6 | set-stx-limit and set-sbtc-limit | Limit price updates, zero-limit rejection, no-deposit error | PASS |
| 7 | admin: pause, owner, treasury, min deposits, dex source | All admin functions + auth guards (u1011) | PASS |
| 8 | close-deposits: timing gate + phase guards | ERR_CLOSE_TOO_EARLY before 10 blocks, success after, double-close error, deposit/cancel blocked in settle | PASS |
| 9 | close-deposits fails with only one side | ERR_NOTHING_TO_SETTLE (u1012) when only STX deposited | PASS |
| 10 | cancel-cycle: timing gate + rollforward | ERR_CANCEL_TOO_EARLY before 42 blocks, success after, all deposits rolled with correct amounts | PASS |
| 11 | cancel-cycle fails in deposit phase | ERR_NOT_SETTLE_PHASE (u1003) | PASS |
| 12 | **full settlement** | Deposit->close->settle, settlement record, fee math (10bps), **clearing = oracle (no premium)** | PASS |
| 13 | **pro-rata distribution** | 2 STX depositors (100+200 STX) get proportional sBTC, wallet3 ~2x wallet1 | PASS |
| 14 | limit orders | STX depositor with low limit gets rolled, limit-roll-stx event | VM-gated* |
| 15 | multi-cycle | Two full settlement cycles, both records exist | VM-gated* |
| 16 | dust sweep | sweep-dust event emitted | VM-gated* |

### sbtc-stx-20-v2.test.ts (12 tests)

| # | Test | What's verified | Status |
|---|------|-----------------|--------|
| 1 | initial state | Cycle 0, deposit phase | PASS |
| 2 | rejects deposits below minimum | ERR_DEPOSIT_TOO_SMALL (u1001) | PASS |
| 3 | rejects zero limit price | ERR_LIMIT_REQUIRED (u1017) | PASS |
| 4 | STX: deposit, top-up, cancel | Deposit tracking, cancel refund | PASS |
| 5 | sBTC: deposit, cancel | sBTC deposit + cancel flow via whale | PASS |
| 6 | admin: pause, owner transfer | Auth guards, ownership transfer | PASS |
| 7 | close-deposits: timing gate + phase guards | 10-block min, phase transitions | PASS |
| 8 | cancel-cycle: timing gate + rollforward | 42-block threshold, deposit rollforward | PASS |
| 9 | **settlement: 20bps premium** | **clearing = oracle * (10000-20)/10000**, fee math verified | PASS |
| 10 | **pro-rata with premium** | Distribution proportional with premium pricing | PASS |
| 11 | limit orders with premium | Low-limit depositor rolled | VM-gated* |
| 12 | multi-cycle with premium | Two cycles with premium | VM-gated* |

\* VM-gated: gracefully skips if prior settlements trigger the clarinet "Clarity VM failed to track token supply" bug.

## Coverage Audit

### Function Coverage

| Function | 0bps | 20bps | Covered Paths | Missing |
|----------|------|-------|---------------|---------|
| `get-current-cycle` | YES | YES | Returns counter | — |
| `get-cycle-start-block` | NO | NO | — | Never called |
| `get-blocks-elapsed` | NO | NO | — | Only exercised indirectly via close-deposits |
| `get-cycle-phase` | YES | YES | DEPOSIT (u0), SETTLE (u2) | — |
| `get-cycle-totals` | YES | indirect | Zero + after deposits | Not asserted in 20bps |
| `get-settlement` | YES | YES | none + some | — |
| `get-stx-deposit` | YES | YES | Zero + nonzero | — |
| `get-sbtc-deposit` | YES | YES | Zero + nonzero | — |
| `get-stx-limit` | YES | NO | Returns set limit | Not read in 20bps |
| `get-sbtc-limit` | YES | NO | Returns set limit | Not read in 20bps |
| `get-stx-depositors` | YES | NO | Empty + populated | Not checked in 20bps |
| `get-sbtc-depositors` | YES | NO | Indirect | Not checked in 20bps |
| `get-dex-source` | YES | YES | Returns XYK (u1) | — |
| `get-min-deposits` | YES | NO | Returns defaults | Not checked in 20bps |
| `get-xyk-price` | indirect | indirect | Called during settle | Never called directly |
| `get-dlmm-price` | NO | NO | — | **Never exercised (dex-source never DLMM during settle)** |
| `deposit-stx` | YES | YES | First deposit, top-up, too small, zero limit, paused, wrong phase | **Priority queue bump (50 slots) NOT tested. ERR_QUEUE_FULL (u1013) never triggered** |
| `deposit-sbtc` | YES | YES | First deposit, cancel/re-deposit, too small, zero limit, wrong phase | **Same gap: priority queue bump NOT tested. sBTC top-up not tested** |
| `cancel-stx-deposit` | YES | YES | Happy path, nothing-to-withdraw, wrong phase | — |
| `cancel-sbtc-deposit` | YES | YES | Happy path, nothing-to-withdraw, wrong phase | — |
| `set-stx-limit` | YES | NO | Success, zero rejected, no-deposit error | Not tested in 20bps |
| `set-sbtc-limit` | YES | NO | Success only | Error paths not tested for sBTC variant |
| `close-deposits` | YES | YES | Success, too early, already closed, one-sided | **Small share filtering (MIN_SHARE_BPS) NOT tested** |
| `settle` | YES | YES | Full settlement, pro-rata, limit roll (STX side), dust | **See gaps below** |
| `settle-with-refresh` | NO | NO | — | **Completely untested** |
| `close-and-settle-with-refresh` | NO | NO | — | **Completely untested** |
| `cancel-cycle` | YES | YES | Success, too early, wrong phase | ERR_ALREADY_SETTLED not tested |
| `set-treasury` | YES | NO | Success + auth guard | Not tested in 20bps |
| `set-paused` | YES | YES | Toggle + auth guard | — |
| `set-contract-owner` | YES | YES | Transfer + privilege loss | — |
| `set-dex-source` | YES | NO | XYK/DLMM/invalid | Not tested in 20bps |
| `set-min-stx-deposit` | YES | NO | Success + effect verified | Not tested in 20bps |
| `set-min-sbtc-deposit` | NO | NO | — | **Completely untested** |

### Error Code Coverage

| Error | Code | 0bps | 20bps | Notes |
|-------|------|------|-------|-------|
| ERR_DEPOSIT_TOO_SMALL | u1001 | YES | YES | |
| ERR_NOT_DEPOSIT_PHASE | u1002 | YES | YES | |
| ERR_NOT_SETTLE_PHASE | u1003 | YES | YES | via cancel-cycle |
| ERR_ALREADY_SETTLED | u1004 | **NO** | **NO** | cancel-cycle after settlement |
| ERR_STALE_PRICE | u1005 | **NO** | **NO** | can't mock with remote_data |
| ERR_PRICE_UNCERTAIN | u1006 | **NO** | **NO** | can't mock with remote_data |
| ERR_PRICE_DEX_DIVERGENCE | u1007 | **NO** | **NO** | can't mock with remote_data |
| ERR_NOTHING_TO_WITHDRAW | u1008 | YES | YES | |
| ERR_ZERO_PRICE | u1009 | **NO** | **NO** | can't mock with remote_data |
| ERR_PAUSED | u1010 | YES | YES | |
| ERR_NOT_AUTHORIZED | u1011 | YES | YES | |
| ERR_NOTHING_TO_SETTLE | u1012 | YES | **NO** | |
| ERR_QUEUE_FULL | u1013 | **NO** | **NO** | need 50-slot test |
| ERR_CANCEL_TOO_EARLY | u1014 | YES | YES | |
| ERR_CLOSE_TOO_EARLY | u1015 | YES | YES | |
| ERR_ALREADY_CLOSED | u1016 | YES | **NO** | |
| ERR_LIMIT_REQUIRED | u1017 | YES | YES | |

### High-Priority Gaps

These are testable in Clarinet and should be added for full coverage:

| Gap | Priority | Why | Testable? |
|-----|----------|-----|-----------|
| **Priority queue bump (MAX_DEPOSITORS=50)** | HIGH | Most complex code path in the contract — bump smallest depositor when queue full | YES — fill 50 STX slots with wallets, deposit a 51st larger one |
| **Small share filtering (MIN_SHARE_BPS)** | HIGH | Tiny depositors silently rolled on close-deposits | YES — deposit 1 STX vs 500+ STX total, close, verify roll |
| **sBTC limit order filtering** | HIGH | `filter-limit-violating-sbtc-depositor` never triggers | YES — set sBTC limit above clearing price |
| **Multiple sBTC depositors pro-rata** | MEDIUM | Only 1 sBTC depositor used; distribution math untested for 2+ | YES — add second sBTC depositor |
| **Unfilled rollforward after partial settlement** | MEDIUM | STX-binding and sBTC-binding paths not isolated | YES — control deposit ratios |
| **set-min-sbtc-deposit** | MEDIUM | Admin function with zero coverage | YES — same pattern as set-min-stx-deposit |
| **ERR_ALREADY_SETTLED (u1004)** | LOW | cancel-cycle after successful settlement | YES — settle then try cancel |
| **ERR_NOTHING_TO_SETTLE (u1012) in 20bps** | LOW | Only tested in 0bps | YES — same one-sided deposit test |
| **settle-with-refresh** | LOW | Production path but needs real Pyth VAAs | HARD — needs Hermes VAA fetch |
| **ERR_STALE_PRICE/UNCERTAIN/DIVERGENCE** | LOW | Oracle safety gates | NO with remote_data (can't manipulate prices) |

### Current Coverage Estimate

- **Functions:** 23/30 directly tested (77%)
- **Error codes:** 11/17 tested (65%)
- **Code paths:** ~60-65% of branching logic covered
- **Settlement math:** Core clearing price + fee + pro-rata verified for both 0bps and 20bps

## Known Issues

### VM Token Supply Bug
Clarinet SDK with `remote_data` has a known bug where `as-contract` sBTC transfers during settlement corrupt the VM's internal token supply tracking. After the first settlement, subsequent `ft-transfer?` calls on sBTC may fail with `(err u1)`.

**Impact:** Tests 14-16 (0bps) and 11-12 (20bps) gracefully skip when this occurs. Core settlement math is verified by tests that run before corruption.

**Workaround:** Run test files individually:
```bash
npx vitest run tests/sbtc-stx-0-v2.test.ts   # 16/16 pass
npx vitest run tests/sbtc-stx-20-v2.test.ts   # 12/12 pass
```

Running both together causes 20bps failures due to shared VM state.

### sBTC Funding
With `remote_data`, `Devnet.toml` `sbtc_balance` is ignored. Tests fund sBTC from mainnet whale `SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2` (~40.6 BTC). State persists across `it()` blocks within the same file.

## Complementary Testing

These Clarinet tests complement the **stxer mainnet fork simulations** in `simulations/`:
- `simul-blind-premium-zero*.js` — Full lifecycle, limit filtering, dust sweep, priority queue
- `simul-blind-premium*.js` — Same scenarios with 20bps premium

Stxer simulations don't have the VM token supply bug and test multi-cycle, priority queue, and small share scenarios end-to-end.
