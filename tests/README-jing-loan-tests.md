# jing-loan-sbtc-stx-single Test Suite

Tests for `contracts/jing-loan-sbtc-stx-single.clar` using Clarinet SDK + vitest with `remote_data` (mainnet fork). Hits the deployed Jing market `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2`.

## Running

```bash
npx vitest run tests/jing-loan-sbtc-stx-single.test.ts
```

Requires:
- `remote_data.enabled = true` in `Clarinet.toml`
- `clarity_version = 5`, `epoch = "3.4"` for the loan contract (needed for constant-based `contract-call?`)
- `@stacks/clarinet-sdk` >= 3.16

## Coverage (23 tests, all passing)

### Initial state
- `initial state`: constants exposed correctly, zero available, no active loan

### Admin
- `set-interest-bps: rejects non-lender`
- `set-interest-bps: lender updates rate`

### Funding
- `fund: rejects non-lender`
- `fund: lender deposits sBTC, available-sbtc increases`
- `withdraw-funds: lender-only, decrements available-sbtc`
- `withdraw-funds: rejects if amount exceeds available`

### Borrow
- `borrow: rejects non-borrower`
- `borrow: rejects below minimum`
- `borrow: rejects exceeding available-sbtc`
- `borrow: creates loan, decrements available, sets active-loan`
- `borrow: rejects if active loan exists`

### Swap-deposit
- `swap-deposit: rejects non-borrower`
- `swap-deposit: rejects unknown loan-id`
- `swap-deposit: moves sBTC to Jing, flips status`
- `swap-deposit: rejects if already swapped`

### Cancel-swap
- `cancel-swap: rejects non-borrower before deadline`
- `cancel-swap: borrower pulls sBTC back from Jing`
- `cancel-swap: lender can cancel after deadline`

### Repay
- `repay: after full cancel, borrower pays only interest` (full-cancel edge case — verifies shortfall math and 0-STX path)

### Seize
- `seize: rejects non-lender`
- `seize: rejects before deadline`
- `seize: lender seizes after deadline + cancel, recovers sBTC`

## Gaps — not yet tested

### Happy path (end-to-end with real Jing settlement)
- **Borrow → swap → Jing cycle settles → repay with STX collateral released**
  - Requires orchestrating another STX-side depositor on Jing, calling `close-deposits` + `settle-with-refresh` (with Pyth VAA buffers), then verifying the loan contract receives STX pro-rata
  - Missing: interest math verification across multiple bps values
  - Missing: STX transfer to borrower on successful repay
- **Borrow → swap → Jing settles → seize STX collateral**
  - Same orchestration + fast-forward past deadline + lender calls seize with real STX balance

### Partial-cancel scenarios
- **Cancel after partial Jing clear**
  - Borrower swapped, one cycle cleared partially (some STX received, some sBTC rolled), then borrower cancels
  - Verify: STX collateral stays in contract, sBTC comes back, repay uses both
- **Cancel mid-rollover**
  - Sbtc rolled to cycle N+1, borrower cancels in that cycle

### Repay variants
- **Repay without any cancel** (normal flow: Jing fully clears, borrower repays owed in sBTC, gets STX)
- **Repay with partial cancel** (some STX in contract + some sBTC; borrower's shortfall = owed - excess-sbtc)
- **Repay when excess-sbtc > owed** (refund path — rare but covered by code)
- **Refund math correctness** across different (owed, excess) ratios

### Seize variants
- **Seize without cancel** (borrower defaulted with sBTC still in Jing — needs lender to `cancel-swap` first, then seize)
- **Seize with both STX collateral and recovered sBTC** (verify both flow to lender)

### Record-stx-collateral (optional audit path)
- `record-stx-collateral: rejects if not fully resolved`
- `record-stx-collateral: snapshots contract STX balance`
- `record-stx-collateral: can be called multiple times (idempotent update)`
- `record-stx-collateral: rejects if status != SWAP-DEPOSITED`

### set-swap-limit
- `set-swap-limit: updates Jing limit-price without cancelling`
- `set-swap-limit: rejects non-borrower`
- `set-swap-limit: rejects if not in SWAP-DEPOSITED`

### Invariants
- `contract sBTC balance = available-sbtc + (active-loan's sbtc-principal if it's in contract)` across every state transition
- STX balance invariant: only moves out on repay or seize
- `active-loan` toggling: set on borrow, cleared on repay/seize

### Edge cases
- Fund when already funded (cumulative behavior)
- Withdraw exact available amount (boundary)
- Borrow exact available amount
- Borrow at exact `min-sbtc-borrow` (boundary)
- Repay at deadline burn-block (exact boundary)
- Multiple sequential loans (borrow → swap → repay → borrow again)
- Re-swap after cancel-swap (verify new swap uses sBTC returned to contract)

### Multi-cycle scenarios
- sBTC rolls across 2-3 Jing cycles before fully clearing
- Partial clears cumulating STX in contract across cycles

## Notes for future test authors

- **Isolation**: each `it` runs with fresh simnet state. Tests must be self-contained. Helpers `setupFunded`, `setupBorrowed`, `setupSwapped` handle common preambles.
- **Whale funding**: `fundSbtc(recipient, amount)` pulls from `SBTC_WHALE` (mainnet account with sBTC via remote_data).
- **Hardcoded addresses**: BORROWER and LENDER in the contract are mainnet SP addresses. Tests call as those principals directly — simnet accepts arbitrary principal senders in remote_data mode.
- **Deadline fast-forward**: `simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1)` skips past the clawback window.
- **Full settlement orchestration**: requires Pyth VAA buffers. See `sbtc-stx-0-v2.test.ts` for the pattern with `close-and-settle-with-refresh`.
