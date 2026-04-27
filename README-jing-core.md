# jing-core

The hub of the Jing protocol. Three jobs:

1. **Canonical equity ledger** — single source of truth for "how much sBTC (or any token) does user X have committed to the Jing ecosystem right now". Read by Stacks Labs for the dual-stacking-boost cross-check via the `get-balance` read-only.
2. **Allowlists** — gates which contracts are permitted to participate (vault code hashes, market principals, eventually SNPL reserves).
3. **Single event stream** — every contract in the ecosystem (vaults and markets) emits its lifecycle events through jing-core, so dashboards/indexers only have to poll one contract.

The contract's source comment header (`jing-core.clar:1-20`) is the inline reference for the same design.

## Why a hub at all

Without a hub, integrators (Stacks Labs, indexers, third-party UIs) would have to:

- Walk every approved market contract and aggregate per-user sBTC deposits across cycle states (active, rolled, refunded).
- Walk every personal vault contract and read its sBTC balance.
- Eventually walk SNPL reserves to count passive-lender deposits.
- Reconcile the lot, including per-cycle pro-rata distributions and settlement rounding.

Each new market or product would force an integration rewrite. Instead, jing-core's `token-equity` map is debited/credited atomically with every fund movement, and `get-balance(user)` is one read away.

## Four product categories

Per the architecture, four contract types are designed to plug into jing-core (each category has its own allowlist and integration pattern):

| Category | What | Integration pattern |
|---|---|---|
| **Jing markets** | Auction contracts (`sbtc-stx-0-jing-v2`, `sbtc-stx-20-jing-v2`, `sbtc-usdcx-jing-v2`, future pairs) | `is-approved-market` allowlist; calls `log-deposit-x/y`, `log-refund-x/y`, `log-distribute-*-depositor` with explicit `(token-x, token-y, depositor)` args |
| **Jing vaults** | Personal vault contracts deployed per user (`jing-vault-v1`) | `register-vault` maps vault → owner; vault calls `log-deposit/log-withdraw` with `(asset, amount)` and `contract-caller` resolves to owner |
| **Jing SNPL** | Per-borrower swap-now-pay-later loan contracts (`loan-sbtc-stx-0-jing` etc.) | Trust-by-bytecode-hash via approved snpl trait; no direct equity reporting (the snpl borrows from a reserve, not from a user, so its in-flight sBTC isn't user equity — it's lender capital) |
| **Jing reserves** | Pooled lender capital backing SNPL (`loan-reserve`) | Calls `log-deposit/log-withdraw` like vaults; lender principal must be mapped to the reserve so equity attributes correctly (open architectural item — see end of doc) |

## The equity ledger

```clarity
(define-map token-equity { token: principal, owner: principal } uint)
(define-map total-token-equity principal uint)
```

Keyed by `(token, owner)`. Today only sBTC entries matter for `get-balance` (dual-stacking-boost is sBTC-only), but the same map can track any token a market or vault credits — adding USDCx, future-pair tokens, etc. requires zero schema change.

### Read-only surface

```clarity
(define-read-only (get-token-equity (token principal) (owner principal)) ...)
(define-read-only (get-total-token-equity (token principal)) ...)

;; Zest-shaped wrapper for Stacks Labs dual-stacking-boost.
(define-read-only (get-balance (user principal))
  (ok (get-token-equity SBTC_TOKEN user)))
```

The `get-balance(user)` shape matches Zest's `zsbtc-v2-0.get-balance` reference contract (takes a principal, returns `(response uint uint)`).

### Credit / debit semantics

Two private helpers:

```clarity
(define-private (credit (token principal) (who principal) (amount uint))
  ;; map-set token-equity { token, owner: who } (+ current amount)
  ;; map-set total-token-equity token (+ total amount))

(define-private (debit (token principal) (who principal) (amount uint))
  ;; floor at 0 so pro-rata rounding can't drive equity negative
  ;; (let ((applied (if (> amount current) current amount))) ...))
```

Plus three vault-aware wrappers used by market-side endpoints:

| Helper | Behavior |
|---|---|
| `credit-if-not-vault` | Credit only if the principal is NOT a registered vault. Avoids double-counting when a vault deposits into a market — equity was already credited at vault ingress. |
| `debit-if-not-vault` | Symmetric — debit only on non-vault principals. |
| `credit-if-vault` | Credit ONLY if the principal IS a registered vault, and walk to the owner via `resolve-owner`. Used at distribute-time to credit the human, not the vault contract. |

## Two integration patterns: vaults vs markets

### Vault-side endpoints (sBTC-only, contract-caller-implicit)

```clarity
(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (and (is-eq asset "sbtc") (credit SBTC_TOKEN owner amount))
    ...))

(define-public (log-withdraw (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (and (is-eq asset "sbtc") (debit SBTC_TOKEN owner amount))
    ...))
```

- The asset is identified by a 4-char string `"sbtc"` or `"stx"`. Only `"sbtc"` updates the equity map; `"stx"` flows are event-stream-only (because dual-stacking-boost is sBTC-only by design).
- `contract-caller` is the calling vault. `resolve-owner` walks the `vault-owners` map to attribute equity to the human.
- Same pattern is used by `loan-reserve.clar` (sBTC-only contract) — see the SNPL reserve open item below.

### Market-side endpoints (token-agnostic, depositor-explicit)

```clarity
(define-public (log-deposit-x
    (depositor principal)
    (amount uint) (delta uint) (limit uint) (cycle uint)
    (bumped (optional principal)) (bumped-amount uint)
    (token-x principal) (token-y principal))
  (let ((owner (resolve-owner depositor)))
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (match bumped b (debit-if-not-vault token-x b bumped-amount) true)
    (credit-if-not-vault token-x depositor delta)
    ...))
```

- The market passes its own `(token-x, token-y)` constants. jing-core doesn't hardcode which token is "base"; the indexer aggregates across pairs.
- `depositor` is passed explicitly because markets settle for many users in one tx — `contract-caller` would just be the market itself.
- `is-approved-market` allowlist gates these endpoints so only sanctioned markets can mutate equity.
- Mirrored on the y-side (`log-deposit-y`), refunds (`log-refund-x/y`), and distributions (`log-distribute-x-depositor`, `log-distribute-y-depositor`).

### Why both patterns

Vaults are 1:1 with users (each user deploys their own vault, registers it, and operates as the only depositor) — `contract-caller` plus an owner-resolution map is enough.

Markets are N:1 (one market, many depositors) — the depositor must be passed explicitly because they're not the tx-sender, the market is.

## The `resolve-owner` chain

Why a vault contract can call `log-deposit` and have the equity attributed to the human owner:

```clarity
(define-read-only (resolve-owner (p principal))
  (default-to p (map-get? vault-owners p)))
```

If `p` is a registered vault, return its owner. Otherwise return `p` as-is.

So:
- User deploys vault, calls `register-vault(vault-id)` → `vault-owners[vault] = user`.
- Vault deposits sBTC, calls `log-deposit "sbtc" amount`.
- Inside jing-core: `(resolve-owner contract-caller)` = `(resolve-owner vault)` = `user`.
- `(credit SBTC_TOKEN user amount)` → `token-equity[(SBTC, user)] += amount`.
- `get-balance(user)` returns the user's sBTC, including what's sitting in their vault.

The same chain works through `register-vault` for any contract that holds funds on behalf of a single principal — which is the open question for SNPL reserves.

## Allowlists

```clarity
(define-map approved-hashes (buff 32) bool)       ;; vault bytecode hashes
(define-map approved-markets principal bool)       ;; market principals
```

- `approved-hashes` gates which vault bytecodes are recognized — a user deploys a vault, its source compiles to a known hash, jing-core's owner approves the hash, then `register-vault` is allowed for any contract with that hash. (Today `register-vault` doesn't enforce hash-checking — the design space leaves this to a registrar wrapper or future hardening.)
- `approved-markets` gates which contract principals can call the `log-*-x/y` market endpoints. Without this, anyone could fabricate equity by calling `log-deposit-x` from an arbitrary contract.

Future allowlists per the four-category split: an approved-snpl set (gates which loan-snpl bytecodes a reserve will fund) and an approved-reserve set (gates which reserve principals are recognized for SNPL lender attribution).

## Open architectural item: SNPL reserve attribution

The recently-added `loan-reserve.clar` follows the vault-side pattern: `supply` calls `log-deposit "sbtc"`, `withdraw-sbtc` calls `log-withdraw "sbtc"`. This works for crediting equity *somewhere*, but right now the credits land on the **reserve principal**, not the lender, because the reserve isn't in `vault-owners`.

Three options:

1. **Manual `register-vault` per reserve** — lender calls `register-vault(reserve-id)` once before supplying. Reuses existing infrastructure. Constraint: a lender who already has a personal vault registered can't also register a reserve (the `user-vaults` slot is 1:1).

2. **Auto-register inside reserve `initialize`** — same effect, packaged as one extra contract-call inside the reserve's init. Same constraint.

3. **`link-reserve` endpoint with a parallel map** — add a separate `reserve-lenders { reserve: principal -> lender: principal }` map and extend `resolve-owner` to consult it. No conflict with personal-vault registrations; cleanest long-term, matches the four-category architecture (vaults and reserves as parallel concepts).

Option 3 is the natural fit for the four-category design and avoids the user-vaults conflict. To be decided before SNPL ships to mainnet — until then, the reserve's log calls fire but credits attribute to the reserve principal rather than the lender.

## File map

```
contracts/jing-core.clar             ;; this contract
contracts/jing-vault-v1.clar         ;; reference vault implementation
contracts/jing-vault-auth.clar       ;; SIP-018 intent helpers used by jing-vault-v1
contracts/loan/loan-reserve.clar     ;; SNPL reserve (calls log-deposit/log-withdraw)
contracts/loan/loan-sbtc-stx-0-jing.clar  ;; SNPL borrower contract (no direct equity reporting)
```

## See also

- **Email thread with Stacks Labs** (Alex / Adam) for the dual-stacking-boost ask and the Zest `get-balance` reference shape.
- **`jing-vault-v1.clar`** lines 102–136 for the reference pattern of `log-deposit` / `log-withdraw` calls.
- **`loan-reserve.clar`** lines 89–103 for the SNPL reserve's analogous wiring.
- **`jing-core.clar`** header comment (lines 1–20) for the in-source design rationale.
