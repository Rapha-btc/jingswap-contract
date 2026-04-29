# jing-core

The hub of the Jing protocol. Five jobs:

1. **Verified-contract template registry** — owner-proposes / validator-confirms list of canonical contract templates (vault, reserve, snpl) with a 144-burn-block timelock. Adds only — no removal.
2. **Per-instance contract registry** — single map of registered ecosystem contracts (vaults, reserves, snpls), populated by hash-verified self-registration against the templates above. Adds only — no removal.
3. **Governance: owner + validators** — owner proposes templates and adds validators; validators independently confirm template additions. Validator add is timelocked; validator remove is fast. Owner cannot be a validator.
4. **Pause primitive** — protocol-wide halt of *entry* paths (deposits, settlements) while *exit* paths (withdraws, refunds, cancels) stay open. Owner-or-validator pauses instantly; owner unpauses after a 144-block cooldown.
5. **Canonical equity ledger + single event stream** — per-principal sBTC bucket tracking for the dual-stacking-boost cross-check (Stacks Labs `get-balance(user)`), plus all lifecycle events for vaults, reserves, snpls, and markets emitted through one contract so dashboards/indexers poll one place.

The contract source comment header (`jing-core.clar:1-20`) is the inline reference for the same design.

## Why one-way registration everywhere

Both registries in jing-core are append-only:

| Registry | Adds via | Removes via |
|---|---|---|
| `verified-contracts` (templates) | propose (owner) → 144 blocks → confirm (validator) | **never** |
| `registered-contracts` (instances) | hash-verified `register` from canonical bytecode | **never** |

Removal of confirmed templates or registered contracts could cascade into mid-flight settlement failures and stranded user funds. The protocol-level answer to "stop using this contract" is **pause**, not removal.

## Verified-contract template flow

```clarity
(define-map verified-contracts principal (buff 32))
(define-map pending-verified-contracts principal { hash: (buff 32), proposed-at: uint })
(define-constant TIMELOCK_BURN_BLOCKS u144)  ;; ~24h
```

Two-step add, no remove:

```
owner: propose-verified-contract(canonical)
       → reads canonical's code via (contract-hash? canonical)
       → pending-verified-contracts[canonical] = { hash, proposed-at: burn-block-height }
       
... 144 burn blocks (~24h off-chain audit window) ...

validator: confirm-verified-contract(canonical)
           → verified-contracts[canonical] = hash
           → pending-verified-contracts[canonical] cleared
           
owner: cancel-pending-contract(canonical)  -- abort before confirmation
```

**Why owner proposes but validator confirms:** keeps the owner from unilaterally promoting a template. The owner can introduce a candidate and abort it, but the trust-on-bytecode call requires a separate party (the validator) to ratify after the audit window.

**Why hash is always computed on-chain** (not optionally provided): the deployer controls the canonical principal — they can always deploy the canonical first under their own address (its only job is to be the byte-identical reference for hashing) and propose against it. Allowing off-chain hash entry would add fat-finger risk and let a forged hash bypass the on-chain bytecode check, with no real benefit (pre-deploy proposal would only pipeline the timelock with deployment, not worth the security tradeoff).

## Validator set

```clarity
(define-map validators principal bool)
(define-data-var validator-count uint u0)
(define-constant MAX_VALIDATORS u5)
(define-map pending-validators principal uint)
```

| Action | Caller | Constraint |
|---|---|---|
| `propose-validator(p)` | owner | `p ≠ owner`, `p` not already validator, no pending, count < 5 |
| `confirm-validator(p)` | **anyone** after timelock | bootstrap-friendly: a system with zero validators must be addable; once timelock elapsed, the proposal is public/auditable |
| `cancel-pending-validator(p)` | owner | abort before confirmation |
| `remove-validator(p)` | owner | **fast** (no timelock); a compromised validator must be ejectable instantly |

`set-contract-owner(new-owner)` refuses to set a new owner who is currently a validator. Owner and validator must be distinct identities.

**Asymmetry:** validator add is slow (trust establishment), remove is fast (emergency response). Removal can stall the system (no one to confirm template additions) but cannot bypass it (owner alone can't promote anything either) — so worst case is DoS, not exploit.

## Per-instance contract registration

```clarity
(define-map registered-contracts principal bool)

(define-public (register (canonical principal))
  (let (
    (caller contract-caller)
    (caller-hash (unwrap! (contract-hash? contract-caller) ERR_INVALID_CONTRACT_HASH))
    (verified-hash (unwrap! (map-get? verified-contracts canonical) ERR_NOT_VERIFIED))
  )
    (asserts! (is-eq caller-hash verified-hash) ERR_HASH_MISMATCH)
    (asserts! (is-none (map-get? registered-contracts caller)) ERR_ALREADY_REGISTERED)
    (map-set registered-contracts caller true)
    (print { event: "registered", contract: caller, canonical: canonical, hash: caller-hash })
    (ok true)))
```

**Single function, single map** for vaults, reserves, and snpls. The `canonical` principal in the event tells indexers what type the contract is (its name encodes the type, e.g. `.jing-vault-v1` vs `.loan-reserve` vs `.loan-sbtc-stx-0-jing`).

**Bool-shape (Pillar pattern):** jing-core only tracks "is this contract registered". The contract's owner (vault's `OWNER`, reserve's `lender`, snpl's `borrower`) is stored on the contract itself and read off-chain via the contract's own getter. No `vault-owners` / `resolve-owner` indirection.

**Hash-binding:** because the caller's bytecode is verified to match the canonical, and the canonical's source code dictates exactly what gets passed to `register`, no caller can forge identity. Mallory cannot register a malicious contract under the verified set — its hash won't match.

**One-way:** no `unregister`. Severing a registered contract from jing-core could break in-flight log paths and strand funds. Use **pause** instead.

### How each ecosystem contract registers

```clarity
;; jing-vault-v1.clar
(define-public (initialize (canonical principal))
  (begin
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)
    (var-set initialized true)
    (try! (contract-call? .jing-core register canonical))
    (ok true)))

;; loan-reserve.clar
(define-public (initialize (canonical principal) (init-lender principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR-NOT-DEPLOYER)
    (asserts! (is-eq (var-get lender) SAINT) ERR-ALREADY-INIT)
    (var-set lender init-lender)
    (try! (contract-call? .jing-core register canonical))
    (print { event: "initialize", lender: init-lender })
    (ok true)))

;; loan-sbtc-stx-0-jing.clar (snpl)
(define-public (initialize (canonical principal) (init-borrower principal) (init-reserve <reserve-trait>))
  (let ((init-reserve-addr (contract-of init-reserve)))
    (asserts! (is-eq tx-sender DEPLOYER) ERR-NOT-DEPLOYER)
    (asserts! (is-eq (var-get current-reserve) SAINT) ERR-ALREADY-INIT)
    (var-set borrower init-borrower)
    (var-set current-reserve init-reserve-addr)
    (try! (contract-call? .jing-core register canonical))
    (print { event: "initialize", borrower: init-borrower, reserve: init-reserve-addr, snpl: current-contract })
    (ok true)))
```

**Vault `initialize` is anyone-callable** — `OWNER` is a `define-constant` captured at deploy (`(define-constant OWNER tx-sender)`), so the caller can't substitute a different owner.

**Reserve and snpl `initialize` are deployer-only** — they take `init-lender` / `init-borrower` as args, so the deployer must be trusted to set them correctly. The deploy tx and the initialize tx are typically the same off-chain operator's actions.

## Pause primitive

```clarity
(define-data-var paused bool false)
(define-data-var paused-at uint u0)
```

Halts protocol *entries* while keeping *exits* unconditionally open. Funds never get stranded under pause.

| Action | Caller | Constraint |
|---|---|---|
| `pause` | owner OR any validator | none — instant. Re-pause refreshes `paused-at` (extends cooldown if a new threat surfaces mid-pause) |
| `unpause` | owner only | `burn-block-height >= paused-at + TIMELOCK_BURN_BLOCKS` (≈24h cooldown) |

**Distributed pause, centralized + deliberate unpause.** Anyone with skin in the game (owner or any of up to 5 validators) can hit the brake instantly. Releasing requires the owner *and* a 24h cooldown, so a panic-pause can't be reversed within minutes by a conflicting party.

A malicious validator who keeps re-pausing can be ejected via fast `remove-validator`.

### What pause gates (`(try! (check-not-paused))`)

7 entry-side log functions assert `(not paused)`:

**Vault-side (3):** `log-deposit`, `log-jing-deposit`, `log-bitflow-swap`
**Market-side (2):** `log-deposit-x`, `log-deposit-y`
**Settlement chain (2):** `log-close-deposits`, `log-settlement` — these gate their entire sub-flows by tx atomicity (when log-close-deposits asserts pause, the whole tx reverts including any earlier `log-small-share-roll-x/y`; same for log-settlement covering limit-rolls + distribute-x/y-depositor + sweep-dust)

**Reserve-side (2):** `log-reserve-supply`, `log-reserve-draw`
**SNPL-side (2):** `log-snpl-borrow`, `log-snpl-swap-deposit`

### What stays open under pause

Withdraws, refunds, cancels, position-revocations, settlement distributions of in-flight cycles, position-parameter adjustments (set-limit), credit-line management, repays, seizures. User funds are always extractable.

## Equity model — per-principal buckets

```clarity
(define-map token-equity { token: principal, owner: principal } uint)
(define-map total-token-equity principal uint)
```

The `owner` key is a principal (a vault, a reserve, or a direct user) — **not an indirected user owner**. Every principal that holds sBTC inside the Jing ecosystem has its own bucket.

### Three equity helpers

```clarity
(define-private (credit-if-not-registered (token principal) (p principal) (amount uint))
  (if (is-registered p) true (credit token p amount)))

(define-private (debit-if-not-registered (token principal) (p principal) (amount uint))
  (if (is-registered p) true (debit token p amount)))

(define-private (credit-if-registered (token principal) (p principal) (amount uint))
  (if (is-registered p) (credit token p amount) true))
```

**Equity philosophy:** equity tracks "tokens inside the Jing ecosystem." A token at a registered contract (vault, reserve, snpl) is in-ecosystem; at a non-registered principal (user wallet) it's out-of-ecosystem.

- **`credit-if-not-registered`** — used on market deposits / refunds. Skips when depositor is a registered contract (their bucket already counts it, or in SNPL's case, shouldn't have one). Credits direct users.
- **`debit-if-not-registered`** — symmetric for refunds back to depositor.
- **`credit-if-registered`** — used on settlement distributions. Credits when recipient is a registered contract (received tokens stay in ecosystem). Skips for direct users (tokens went to their wallet, left ecosystem).

### Buckets per contract type

| Contract type | Bucket grows on | Stays put on | Bucket shrinks on |
|---|---|---|---|
| **Vault** | `log-deposit` (vault.deposit-stx/sbtc) | `log-jing-deposit` (vault → market — equity stays at vault), market deposits where vault is depositor (`credit-if-not-registered` skips because vault IS registered) | `log-withdraw` (vault → user) |
| **Reserve** | `log-reserve-supply` when lender is a direct user; skipped when lender is a vault (vault bucket already counts) | `log-reserve-draw` (reserve → snpl — equity stays at reserve), `log-reserve-notify-return` | `log-reserve-withdraw-sbtc` |
| **SNPL** | **never** | always (no log-snpl-* function ever credits or debits) | **never** |
| **Direct user** | direct market deposits (`log-deposit-x/y` when user is depositor); direct lending (`log-reserve-supply` when user is lender); `credit-if-registered` no-ops for them so settlement distributions don't add equity (tokens went to their wallet) | various | `log-refund-x/y` when user is depositor |

### Why SNPL never has a bucket

SNPL holds *borrowed* sBTC — debt for the borrower, exposure for the lender. The lender's exposure is already counted on the reserve side; counting it again on the SNPL would double-count and create a borrow-to-boost loophole.

**Symmetry with vault → market:** the boost stays at the source of the funds. Vault deposits into market: equity stays on vault (`log-jing-deposit` doesn't touch equity; market's `log-deposit-x` skips because vault is registered). Reserve drains into snpl: equity stays on reserve (`log-reserve-draw` doesn't touch equity; SNPL never credits).

## Off-chain owner aggregation for dual-stacking

Because jing-core no longer maps vault → owner, per-user aggregation is off-chain.

Stacks Labs flow for "Alice's total sBTC equity in the Jing ecosystem":

```typescript
// 1. Alice's direct bucket (her own deposits / direct lending).
const directEquity = await callReadOnly(
  'jing-core', 'get-token-equity', [SBTC_TOKEN, alice]
);

// 2. Discover Alice's vaults / reserves via event scan.
const events = await scanEvents('jing-core', 'registered');
//   each: { contract, canonical, hash }

const aliceContracts = [];
for (const { contract, canonical } of events) {
  let owner;
  if (canonical.endsWith('.jing-vault-v1')) {
    owner = await callReadOnly(contract, 'get-owner');     // vault has OWNER constant
  } else if (canonical.endsWith('.loan-reserve')) {
    owner = await callReadOnly(contract, 'get-lender');    // reserve has lender data-var
  }
  // SNPLs intentionally have no equity bucket; skip.
  if (owner === alice) aliceContracts.push(contract);
}

// 3. Sum buckets.
let total = directEquity;
for (const c of aliceContracts) {
  total += await callReadOnly('jing-core', 'get-token-equity', [SBTC_TOKEN, c]);
}

return total;
```

**Source of truth for ownership** is the contract itself (vault's `OWNER` constant, reserve's `lender` data-var). jing-core's only role is "is this principal a registered ecosystem contract? what's its bucket?" — the user-aggregate is a frontend concern.

```clarity
;; Zest-shaped read-only kept for backwards-compatibility. Returns Alice's
;; DIRECT bucket only -- frontends do the per-user-vault aggregation above.
(define-read-only (get-balance (user principal))
  (ok (get-token-equity SBTC_TOKEN user)))
```

## Markets — same unified flow

Markets register through the same `register` function as vaults / reserves / snpls. Their bytecode hash is verified against `verified-contracts[canonical]` at registration time; their per-instance configuration (`token-x`, `token-y`, `oracle-feed` — or two feeds in the dual-feed variant — see `README-dual-feed-pricing.md`) is set inside the same atomic `initialize` call before `register` fires:

```clarity
;; token-x-token-y-jing-v3.clar
(define-public (initialize
  (canonical principal)
  (x principal) (y principal)
  (min-x uint) (min-y uint)
  (feed (buff 32)))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)
    (var-set token-x x) (var-set token-y y)
    (var-set min-token-x-deposit min-x) (var-set min-token-y-deposit min-y)
    (var-set oracle-feed feed)
    (var-set initialized true)
    (try! (contract-call? .jing-core register canonical))
    (ok true)))
```

**Trust model:** the hash check guarantees the market's *bytecode* is canonical; the operator (`tx-sender = operator` on `initialize`) is trusted to set `token-x` / `token-y` / `oracle-feed` correctly. Misconfiguration (e.g. wrong oracle for the pair) is an operator concern, not a protocol concern — same trust model as reserves (deployer trusted to set lender) and snpls (deployer trusted to set borrower / current-reserve).

**Same one-way semantics:** once a market is registered, it stays registered. The protocol-level response to a misconfigured or compromised market is **pause** (which halts all entry-side log calls including `log-deposit-x/y` and the settlement chain) plus the market's own per-instance pause flag (`paused` data-var on the market itself).

## Event stream

Every lifecycle event in the Jing ecosystem flows through jing-core's print events, so an indexer only polls one contract.

**Vault events:** `vault-deposit`, `vault-withdraw`, `vault-jing-deposit`, `vault-bitflow-swap`, `vault-revoke`, `vault-cancel`

**Market events:** `deposit-x/y`, `refund-x/y`, `set-limit-x/y`, `close-deposits`, `small-share-roll-x/y`, `limit-roll-x/y`, `settlement`, `distribute-x-depositor`, `distribute-y-depositor`, `sweep-dust`, `cancel-cycle`

**Reserve events:** `reserve-supply`, `reserve-withdraw-sbtc`, `reserve-withdraw-stx`, `reserve-open-credit-line`, `reserve-set-credit-line-cap`, `reserve-set-credit-line-interest`, `reserve-close-credit-line`, `reserve-set-paused`, `reserve-set-min-sbtc-draw`, `reserve-draw`, `reserve-notify-return`

**SNPL events:** `snpl-set-reserve`, `snpl-borrow`, `snpl-swap-deposit`, `snpl-cancel-swap`, `snpl-set-swap-limit`, `snpl-repay`, `snpl-seize`

**Governance events:** `verified-contract-proposed`, `verified-contract-confirmed`, `verified-contract-cancelled`, `validator-proposed`, `validator-confirmed`, `validator-cancelled`, `validator-removed`, `paused`, `unpaused`, `registered`, `market-approved`, `market-revoked`

**Note on initialize events:** each ecosystem contract still emits its own local `initialize` event because that fires *before* the contract is in `registered-contracts` (chicken-and-egg with auth). Once registered, all subsequent events go through jing-core.

## Error code map

| Code | Meaning |
|---|---|
| 5001 `ERR_NOT_AUTHORIZED` | Caller isn't the owner / a validator / a registered contract / etc. |
| 5002 `ERR_INVALID_CONTRACT_HASH` | `(contract-hash? p)` returned `none` (caller isn't a contract, or contract doesn't exist) |
| 5003 `ERR_ALREADY_REGISTERED` | Trying to register something already registered |
| 5005 `ERR_NOT_VERIFIED` | `register` called against a canonical not in `verified-contracts` |
| 5006 `ERR_HASH_MISMATCH` | Caller's bytecode hash ≠ verified-contracts[canonical] |
| 5007 `ERR_NO_PENDING_PROPOSAL` | confirm/cancel called on something that wasn't proposed |
| 5008 `ERR_TIMELOCK_NOT_ELAPSED` | confirm called before 144 burn blocks elapsed; or unpause before cooldown |
| 5009 `ERR_OWNER_CANNOT_BE_VALIDATOR` | Tried to add the owner as a validator |
| 5010 `ERR_ALREADY_VALIDATOR` | Validator add for an existing validator |
| 5011 `ERR_VALIDATOR_PENDING` | Validator add for one already in pending |
| 5012 `ERR_VALIDATOR_LIMIT_REACHED` | More than `MAX_VALIDATORS` (5) |
| 5013 `ERR_NO_PENDING_VALIDATOR` | Confirm-validator with no proposal |
| 5014 `ERR_NOT_VALIDATOR` | Remove-validator on a non-validator |
| 5015 `ERR_NEW_OWNER_IS_VALIDATOR` | set-contract-owner to an existing validator |
| 5016 `ERR_PAUSED` | Entry-side log called while paused |

## File map

```
contracts/jing-core.clar                  ;; this contract
contracts/jing-vault-v1.clar              ;; reference vault — registers via .register
contracts/jing-vault-auth.clar            ;; SIP-018 intent helpers used by jing-vault-v1
contracts/loan/loan-reserve.clar          ;; reserve — registers via .register
contracts/loan/loan-sbtc-stx-0-jing.clar  ;; snpl (per-market specialization)
contracts/loan/reserve-trait.clar         ;; reserve-trait used by snpl
contracts/loan/snpl-trait.clar            ;; snpl-trait used by reserve
contracts/v3/token-x-token-y-jing-v3.clar          ;; single-feed market template
contracts/v3/token-x-token-y-jing-v3-stx-sbtc.clar ;; dual-feed market template (sBTC/STX)
```

## See also

- **`README-dual-feed-pricing.md`** — pricing / Pyth-expo handling for the dual-feed market variant
- **`README-blind-premium.md`** — pre-v3 market design (sbtc-stx-0-jing-v2 etc.) still live
- **`README-jing-loan.md`** — SNPL borrower-side flow
- **`jing-core.clar`** header comment (lines 1–20) for the in-source design rationale

## Open follow-ups

- Replace dummy `(asserts! (>= amount u0) ERR_NOT_AUTHORIZED)` in `log-deposit` / `log-withdraw` with `(asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)` (the `>= u0` check is always true since `amount` is `uint`; meaningful auth check now requires the unified registry).
- Tests for the unified `register`, the validator + timelock flows, the pause / unpause cooldown, and the equity helper semantics across vault / reserve / snpl / market interactions.
