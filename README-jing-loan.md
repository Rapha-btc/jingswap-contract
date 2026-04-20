# jing-loan-sbtc-for-stx

**Swap-now-pay-later for Bitcoiners.** A whitelisted borrower locks in a cheap sats/STX rate today by borrowing sBTC against future STX rewards — fully on-chain, collateralized, no credit check.

Contract: `contracts/jing-loan-sbtc-for-stx.clar`

---

## What it does

A lender funds the contract with sBTC. A whitelisted borrower:
1. Creates a loan against those funds (`borrow`).
2. Swaps the sBTC to STX via Jing v2 (`swap` — deposits into `sbtc-stx-0-jing-v2`).
3. Repays **principal + flat interest** in sBTC anytime within ~2 PoX cycles to unlock the STX.

If the borrower fails to repay by the deadline, the lender claws back (`seize`) the STX as collateral.

---

## Roles

| Role | What they do | How set |
|---|---|---|
| **Lender** | Funds sBTC, earns interest on repay, seizes STX on default | `lender` var (default = deployer) |
| **Operator** | Proposes borrower whitelist, can veto during cooldown | `operator` var (default = deployer) |
| **Borrower** | Draws loans, swaps to STX, repays | Whitelisted by operator (veto window: lender OR operator) |

Lender and operator can be the same principal or split.

---

## Lifecycle

```
borrow → swap → (Jing settles) → record-stx-collateral → repay  ✓  (STX to borrower, sBTC + interest to lender)
                                                       \→ seize  (after deadline, STX to lender)

borrow → cancel  (pre-swap only, sBTC returns to available)
```

The borrower flow is 3 on-chain txs: `borrow`, `swap`, `repay`. `record-stx-collateral` can be called by anyone (keeper, frontend, lender) once Jing settles, so the borrower doesn't have to do it themselves.

### Status values

| Status | Meaning |
|---|---|
| `PRE-SWAP` (0) | Loan created, sBTC locked, not yet deposited in Jing |
| `SWAPPED` (1) | sBTC deposited in Jing, awaiting cycle settlement + repay/seize |
| `REPAID` (2) | Borrower repaid, STX released to borrower |
| `SEIZED` (3) | Deadline passed, lender took STX |
| `CANCELLED` (4) | Pre-swap loan cancelled by borrower |

**Invariant:** at most ONE loan in `SWAPPED` state at a time. Multiple `PRE-SWAP` loans can coexist — borrower queues borrows and swaps them serially as Jing cycles allow. Clean STX attribution (contract's STX balance is always fully owned by the one active swapped loan).

---

## Why 2 steps (borrow + swap)

Splitting avoids atomic `deposit + close + settle` (which needs Pyth VAAs + iterates 100+ depositors in one tx — runtime-cost prohibitive).

- `borrow` is cheap — pure state write, no Jing interaction, works anytime.
- `swap` does the Jing `deposit-sbtc` call only. If Jing's deposit phase is closed or queue is full, only `swap` fails; the loan remains valid for retry.
- Settlement is async — whoever calls Jing's `settle` triggers it; not our problem.
- Once Jing settles, STX lands in this contract and is released via `repay` / `seize` inline.

---

## Parameters

| Constant | Value | Meaning |
|---|---|---|
| `MIN-SBTC-BORROW` | `u1000000` | 0.01 sBTC minimum per borrow |
| `CLAWBACK-DELAY` | `u4200` | ~2 PoX cycles — deadline starts at `swap` time |
| `WHITELIST-COOLDOWN` | `u1` | Symbolic 1 burn block before whitelist takes effect |
| `interest-bps` (var) | default `u200` (2%), suggested `u100` (1%) | Flat fee, locked per-loan at `borrow` time |

---

## Rate economics

**Interest is a flat fee**, not time-weighted. The borrower pays the same whether they repay on day 1 or day 29.

Formula: `owed = principal + (principal × interest-bps / 10_000)`

### Suggested rates

| Setting | Flat fee on 0.4 sBTC | APR equivalent (29-day window) | Rationale |
|---|---|---|---|
| `u32` (0.32%) | 0.00128 sBTC (~$97) | ~4% APR (Zest parity) | Competitive with permissionless markets |
| `u48` (0.48%) | 0.00192 sBTC (~$145) | ~6% APR | Small premium for bilateral convenience |
| `u100` (1%) | 0.004 sBTC (~$302) | ~12.5% APR | **PoC default** — round, attractive to lender |
| `u400` (4%) | 0.016 sBTC (~$1,210) | ~50% APR | Premium pricing for optionality value |

Annualization: `bps × (52,560 / 4200) / 100 = APR%` (where 52,560 is BTC blocks/year)

### Market comparison

| Product | Effective APR | Collateral | Access |
|---|---|---|---|
| Affirm/Klarna "Pay in 4" | 0% consumer | None | Merchant-subsidized |
| Affirm/Klarna installment (3-12 mo) | 10-30% | None | Credit check |
| Credit card revolving | 22-29% | None | Credit-based |
| **jing-loan @ 1% flat** | **~12.5%** | **STX (100% of draw)** | **Whitelist, on-chain** |
| Zest sBTC borrow | 3.39% | Over-collateralized (~150%) | Permissionless |

**Positioning:** cheaper than credit cards and most BNPL installment plans, more expensive than Zest — the premium over Zest reflects bilateral/whitelist overhead and single-borrower capital concentration.

---

## Worked example

**Setup:** Friedger borrows 0.4 sBTC at 1% flat (`interest-bps = u100`), swaps on Jing v2 (oracle 297 sats/STX, Jing fee 0.10%).

| Step | Amount |
|---|---|
| Borrow | 0.4 sBTC (40,000,000 sats) |
| STX received after Jing 0.10% fee | **134,545.45 STX** |
| Repay (principal × 1.01) | **0.404 sBTC** |

**Effective rate:** 40,400,000 / 134,545.45 = **300.26 sats/STX**
(vs oracle 297 → **~1.1% premium** = 1% loan + 0.1% Jing)

**Cost:** ~$302 for a 29-day lock-in at today's cheap sats/STX.

**Downside:** none material. STX collateral covers the lender on default. The real penalty is reputational — miss the repay, lose whitelist access, future loans cost more.

**Why it's worth it:** a 5% move in sats/STX wipes out the 1.1% fee. If Friedger believes 297 is near the cycle low, this is cheap insurance against the rate running up before his BTC yield arrives.

---

## Whitelist flow (2 steps, explicit confirm)

1. **Lender** calls `propose-whitelist(borrower)` → records proposal at current burn-block.
2. Cooldown = `WHITELIST-COOLDOWN` burn blocks (default: 1 — symbolic).
3. After cooldown: **operator** calls `confirm-whitelist(borrower)` to activate. Nothing happens automatically — confirmation is required.
4. Once confirmed, `is-whitelisted?(borrower)` returns `true` and the borrower can call `borrow`.

Safety relies on the cooldown + explicit confirm: if something looks wrong, the operator simply doesn't confirm. No separate veto path needed.

### Blacklist

At any point (pre- or post-confirmation), the **lender** can call `blacklist-borrower(who)` to remove a borrower from both the active and proposed maps. Typical use: punitive removal after a default or misconduct. Borrower can be re-proposed later if forgiven.

---

## Public functions

### Admin
| Function | Caller | Effect |
|---|---|---|
| `set-operator(new)` | operator | Transfer operator role |
| `set-interest-bps(bps)` | lender | Update default rate (locks per-loan at borrow time) |

**Lender is immutable.** Rotating the lender would let a new principal withdraw funds and seize STX on loans they didn't originate, breaking the bilateral trust model. To rotate: withdraw all sBTC, wait for active loans to close, redeploy with new lender.

### Funding
| Function | Caller | Effect |
|---|---|---|
| `fund(amount)` | lender | Deposit sBTC into contract |
| `withdraw-funds(amount)` | lender | Pull unused sBTC back |

### Whitelist
| Function | Caller | Effect |
|---|---|---|
| `propose-whitelist(who)` | lender | Start cooldown |
| `confirm-whitelist(who)` | operator | Activate after cooldown (required) |
| `blacklist-borrower(who)` | lender | Remove from active + proposed maps (e.g., after default) |

### Loan lifecycle
| Function | Caller | Effect |
|---|---|---|
| `borrow(amount)` | whitelisted borrower | Create loan, lock sBTC |
| `swap(loan-id, limit-price)` | loan's borrower | Deposit sBTC into Jing, start deadline |
| `record-stx-collateral(loan-id)` | anyone | After Jing settles, write STX amount to loan record |
| `cancel(loan-id)` | loan's borrower | Refund pre-swap loan |
| `repay(loan-id)` | loan's borrower | Send sBTC + interest to lender, receive STX |
| `seize(loan-id)` | lender | Take STX after deadline |

### Read-only
`get-lender`, `get-operator`, `get-interest-bps`, `get-available-sbtc`, `get-swapped-loan`, `get-loan(id)`, `is-whitelisted(who)`, `owed-on-loan(id)`

---

## External dependencies

| Contract | Purpose |
|---|---|
| `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | sBTC SIP-010 |
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2` | Jing v2 market (market-price sBTC/STX) |

Jing v2 is a blind batch auction; `deposit-sbtc` must be called during the market's `PHASE_DEPOSIT`. The contract reads `get-current-cycle` to determine when settlement has occurred (new cycle → prior cycle settled).

---

## Integration roadmap

### Standalone (today)
Friedger (as Fastpool admin) directly calls `borrow` / `swap` / `repay` on this contract.

### Jing Vault layer (next)
Jing-loan becomes a primitive called by jing-vault orchestration:

```
Fastpool admin signs SIP-018 intent
  → jing-vault validates intent + policy
  → jing-vault calls jing-loan-sbtc-for-stx.borrow() + .swap()
  → keeper/operator fires tx
```

Use case: *"if sats/STX drops below 280, borrow 0.4 sBTC and swap"* — signed intent, keeper executes when trigger hits. Friedger doesn't babysit the chart.

### jSTX connection (future)
STX received via `repay` flows into a liquid stacking product (jSTX pool). Rewards distributed in sBTC, auto-servicing future borrow-repay cycles.

---

## Testing

```bash
clarinet check contracts/jing-loan-sbtc-for-stx.clar
npm test  # vitest tests TBD
```

## Status

**PoC / draft.** Not deployed. Not audited. Not committed until reviewed.
