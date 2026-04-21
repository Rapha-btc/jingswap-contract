# Multi-borrower loan setup

Draft architecture for supporting N borrowers against pooled lender sBTC
using a per-borrower **single-v2** loan contract funded on demand by a
**lender reserve** contract.

Status: design sketch. No contracts written yet.

Naming note: "vault" is already taken by `jing-vault-v1.clar` (Jing's
conditional execution layer — signed intents + keepers). This funding
layer is called the **lender reserve** to avoid overloading the term.

## The shape

```
                    ┌────────────────────────┐
                    │   lender-reserve.clar  │
                    │                        │
  lender supplies ──►  pooled sBTC           │
                    │  approvals:            │
                    │    (single → {         │
                    │      borrower,         │
                    │      limit,            │
                    │      outstanding })    │
                    │                        │
                    └──▲─────▲─────▲─────────┘
                       │     │     │
             disburse  │     │     │  (pull at borrow time,
                       │     │     │   return at repay/seize/cancel)
                       │     │     │
                  ┌─────┐┌─────┐┌─────┐
                  │single││single││single│     one per (reserve, borrower)
                  │v2 A ││v2 B ││v2 C │      LENDER = reserve, BORROWER = X
                  └──┬──┘└──┬──┘└──┬──┘
                     │      │      │
                     ▼      ▼      ▼
                    Jing   Jing   Jing      each single is its own Jing
                  depositor        depositor  principal; no cross-contamination
```

- A single lender (v1) supplies sBTC to the reserve.
- For each borrower the lender wants to enable, they approve a specific
  deployed single-v2 contract at the reserve, attaching that borrower's
  principal and a credit limit.
- The borrower calls `borrow(amount)` on **their own** single-v2. The
  single calls back into the reserve's `disburse(amount)`, which pulls
  sBTC from reserve → single in the same tx.
- From there, the flow is unchanged from single-v1: `swap-deposit`,
  `cancel-swap`, `repay`, `seize`, etc.
- On `repay`, single ships `owed` sBTC to `LENDER` = reserve. On
  `seize`, single ships STX (and any recovered sBTC) to reserve. On
  `cancel` before swap-deposit, single ships the borrowed principal
  back to the reserve. Reserve reconciles inbound flows against
  `outstanding`.

## Why per-borrower singles (unchanged from before)

`jing-loan-sbtc-stx-single` works *because* it's a one-loan-at-a-time
sealed contract. Two of its properties are what make it compose when
stamped out N times:

1. **Its Jing identity is its own contract principal.** Jing v3
   aggregates deposits by principal. Two different singles → two
   different Jing principals → Jing does not mix their deposits, their
   limit prices, their rolls, or their settlement payouts.
2. **`excess-sbtc = sbtc-balance − available-sbtc` cleanly separates
   lender capital from borrower-side recovery** — so unexpected sBTC
   inflow (Jing eviction, partial fills, airdrops) is handled
   correctly at repay/seize via `shortfall` / `refund` / `excess-sbtc`
   transfers.

In single-v2 this invariant simplifies: since funds are pulled JIT from
the reserve, there is no "prefunded but unborrowed" sBTC sitting on the
single. See the single-v2 changes section.

Neither property requires the lender to be an EOA. They hold equally
when `LENDER` is the reserve contract principal.

## Reserve responsibilities

The reserve is the funding + accounting layer. It does NOT know about
Jing, cycles, Pyth, or settlement math. It only handles:

- **LP supply.** v1: single lender, `supply` / `withdraw` gated to that
  one principal. v2 could extend to shares.
- **Approval registry.** `approvals { single: principal } → { borrower,
  limit, outstanding }`. The lender calls `approve-single(single,
  borrower, limit)` after verifying the deployed single's bytecode and
  constants. A single only becomes fundable once it's in this map.
- **`disburse(amount)`** — called by an approved single during its
  `borrow` flow. Reserve verifies `contract-caller` is an approved
  single, enforces `(outstanding + amount) <= limit`, transfers sBTC
  reserve → single, bumps `outstanding`.
- **Reconciliation.** `reconcile(single)` or implicit-on-inbound: the
  reserve needs to credit repayments, cancels, and seizures against
  `outstanding` and update pooled sBTC accordingly. Options below.
- **Blacklist / pause.** `revoke-single(single)` flips a flag so
  future `disburse` calls fail. In-flight loans keep their path back
  via the approved repay/seize/cancel flows, since those only need
  `LENDER` to be the reserve principal, not to be "approved."

The reserve's credit-limit check is at the (single, amount) level, not
(borrower, amount). Because one single is bound to one borrower, this
is equivalent — but the per-single keying is simpler to implement and
allows a borrower to have multiple parallel singles if needed (see
non-goals).

## Single-v2 changes from v1

Moving from lender-push (`fund`) to reserve-pull (`disburse`) lets
single-v2 shed a chunk of state:

- **Remove** `available-sbtc` data-var, `fund`, `withdraw-funds`.
  The reserve now owns that concept.
- **Simplify** the `excess-sbtc` invariant: with no `available-sbtc`,
  `excess-sbtc = sbtc-balance` directly. Any sBTC on the contract
  belongs to borrower-side recovery, which still produces the right
  math at repay/seize.
- **Change** `borrow(amount)` to call
  `(contract-call? LENDER disburse amount)` at the top, replacing the
  old `(asserts! (<= amount liquid) ERR-INSUFFICIENT-FUNDS)` check.
  Insufficiency is now the reserve's responsibility (and its error
  code propagates up).
- **Add** a `cancel(loan-id)` that handles the pre-swap case: ship
  borrowed sBTC back to reserve, clear `active-loan`, mark loan
  `STATUS-CANCELLED`. Reserve reconciles the inbound as
  `outstanding -= principal`.
- **Keep** `cancel-swap` as the post-swap-deposit escape hatch,
  unchanged semantically. The recovered sBTC still sits on the single
  and is handled by `repay`'s `excess-sbtc` / `shortfall` logic.
- **Keep** `repay` and `seize` as-is, with `LENDER` pointing at the
  reserve principal. Their outbound transfers now land on the reserve
  contract; the reserve reconciles.

Single-v2 does not need any Jing-v3 distribution changes to work.
`repay` / `seize` reading the contract's live balance is enough, same
as v1. See the Jing-v3 improvement section below — that's for
external protocols wanting atomic deposit+close+settle chaining,
orthogonal to this architecture.

## Approval + deployment flow

Clarity has no contract-factory primitive, so each single is a distinct
deployed contract. The reserve cannot trust arbitrary contracts that
claim to be singles — a malicious copy could redirect `repay`
destinations, skip the `LENDER` check on admin functions, etc.

Flow for onboarding a new borrower:

1. Borrower (or operator on their behalf) deploys a fresh single-v2
   with constants `BORROWER = <borrower-principal>`,
   `LENDER = <reserve-principal>` baked in.
2. Lender reviews the deployed contract. Verification path (pick one):
   - **Canonical bytecode hash.** Reserve stores an approved
     `sha512/256` of the single-v2 source. `approve-single` reads
     the deployed source via the appropriate primitive, hashes it,
     and compares. Any whitespace change rotates the hash — template
     must be re-registered on edit. Pattern reference: Faktory
     `register-wallet` / `set-verified-contract`.
   - **Operator-mediated deploy.** Only the operator deploys singles
     and immediately approves them. Reserve only ever sees contracts
     it originated. Simpler; concentrates trust in the operator.
3. Lender calls `reserve.approve-single(single, borrower, limit)`.
4. Borrower calls `single.borrow(amount)` — single pulls from reserve,
   borrower gets the loan.

Invariants the reserve must verify before `approve-single` succeeds:

- `BORROWER` constant matches the claimed borrower principal.
- `LENDER` constant matches the reserve's own principal.
- Contract bytecode matches the approved template.

## Why Jing eviction is still a non-issue

Jing's 50-depositor queue can evict the smallest sBTC deposit when a
bigger one arrives. In this model:

- Bounced sBTC lands on exactly one single's balance. It belongs to
  one borrower's one active loan. No cross-borrower contamination.
- On the single, the bounced principal shows up as `excess-sbtc`
  (balance rose; with v2, `available-sbtc` no longer exists, so
  `excess-sbtc = sbtc-balance`). Single's invariant treats it as
  borrower-side recovery, which is correct: this is the principal
  that was loaned out and never made it into Jing.
- `repay` with an evicted loan: `shortfall = owed − excess-sbtc`
  collapses to just the interest. Borrower tops up interest. Single
  ships full `owed` to the reserve. Reserve reconciles
  `outstanding -= principal`. Done.
- `seize` past deadline with an evicted loan: `excess-sbtc` (the
  bounced principal) ships to the reserve as full principal recovery,
  STX collateral ships to the reserve as zero (nothing ever cleared).
- No other single, no other borrower, no other loan is affected. The
  reserve's pooled sBTC is untouched until the reconciliation at
  repay/seize.

This works because the single enforces at-most-one-active-loan. The
evicted sBTC cannot silently overlap another loan's exposure inside
the same contract.

## Proposed Jing v3 improvement: distribution visibility

Not needed for the reserve/single-v2 model described above. The single
can already figure out what it got from Jing via its live sBTC + STX
balances at `repay` / `seize` time, and that's enough for our flow.

The motivation is a different class of consumer: **a contract that
wants to atomically chain `deposit-sbtc` → `close-deposits` →
`settle-with-refresh` in a single tx and branch on the result in the
same continuation.** That chain already works mechanically today
(phase transitions line up), but at the end of `settle` the caller
has no structured return to act on — they'd have to read balance or
re-derive pro-rata. For one-shot atomic use, a signature-level return
is the ergonomic shape.

Two complementary changes, each useful for a different consumer:

### A. Return the caller's distribution directly from `settle`

The cheapest + most useful variant for chained callers. `settle` (and
`settle-with-refresh`, `close-and-settle-with-refresh`) returns a
shape keyed to the calling principal:

```
(ok { cycle: uint,
      clearing-price: uint,
      caller-stx-deposited: uint,
      caller-sbtc-deposited: uint,
      caller-stx-received: uint,     ;; if caller was on the sbtc side
      caller-sbtc-received: uint,    ;; if caller was on the stx side
      caller-stx-rolled: uint,
      caller-sbtc-rolled: uint })
```

A protocol chaining `deposit-sbtc → close-deposits →
settle-with-refresh` can `let`-bind the return and route accordingly —
settle the position downstream, trigger a hedge, write to its own
book — without a second Jing call. The values are the same ones
Jing already computes inside `distribute-to-*-depositor`; the change
is plumbing the relevant entries out through the return.

Callers that don't care about the return (the normal operator
triggering settle) just ignore it.

### B. Persist per-depositor distributions in a map

For callers that settled out-of-band and want to reconstruct their
share later (audits, event-driven indexers, non-chained consumers):

```
(define-map settlement-distributions
  { cycle: uint, depositor: principal }
  { side: (string-ascii 4),     ;; "stx" or "sbtc"
    deposited: uint,
    received: uint,
    rolled: uint,
    clearing-price: uint })

(define-read-only (get-settlement-distribution (cycle uint) (who principal))
  (map-get? settlement-distributions { cycle: cycle, depositor: who }))
```

Populated inside `distribute-to-*-depositor` with the exact values
already being emitted in `print`. Storage cost: ≤100 entries per cycle
(MAX_DEPOSITORS = 50 per side). Negligible.

### Both are additive

Neither changes settlement math or existing side effects. Today's
transfers and print events still fire; the return becomes structured,
and the map is an extra persisted record. Existing consumers keep
working unchanged.

Shipping priority: **(A) only if and when we want external protocols
to chain Jing calls atomically.** (B) is a nice-to-have for indexers
and after-the-fact reconciliation. Neither is a blocker for the
reserve / single-v2 rollout.

## What this architecture does NOT support

- **A single borrower with multiple concurrent loans on one single.**
  `active-loan` gates it at the single-v2 level. If a borrower wants
  two loans simultaneously, deploy a second single with the same
  `BORROWER`; the reserve approves it as a separate (single, borrower,
  limit) entry. The reserve can apply a per-borrower aggregate limit
  on top if desired.
- **Per-loan limit prices within one Jing cycle under one principal.**
  Irrelevant — each single is its own Jing principal with its own
  independent `limit-price`.
- **Cross-lender matching inside one single.** Each single is bound to
  one lender (the reserve). Multi-LP semantics live in the reserve
  (shares, pro-rata on repayment distribution), not the single.

## Open decisions

- **STX from `seize`**: hold it on the reserve, auto-convert back to
  sBTC via a Jing market (note the reflexive loop), or distribute to
  LPs as-is?
- **Disbursement gating**: does `disburse` auto-fill up to the limit,
  or require a fresh lender signature per disbursement (SIP-018
  signed message with nonce)? Auto-fill is cheaper UX; signed
  disbursement keeps the lender in the loop and allows pausing
  without revoking.
- **Reconciliation trigger**: must `repay` / `seize` / `cancel` be
  paired with a `reserve.reconcile(single)` call in the same tx, or
  can the reserve lazy-reconcile on the next `disburse` that
  references that single? Same-tx is cleaner; lazy is cheaper.
- **Multi-LP vs single-LP v1**: start single-LP. Shares are a v2
  feature.
- **Bytecode verification transport**: inline hash check on-chain
  vs an off-chain registry with lender-signed attestations the
  reserve verifies via SIP-018.
- **Cross-borrower limit aggregation at reserve**: is
  `limit-per-single` enough, or does the reserve also enforce a
  `limit-per-borrower` across all their singles?
- **Jing-v3 distribution return**: orthogonal to this rollout. If we
  want to enable third-party protocols to chain deposit+close+settle
  atomically, ship (A) the structured `settle` return; (B) the
  persisted distributions map is a later, cheaper add. Neither is on
  the critical path for reserve / single-v2.

## File layout (proposed)

```
contracts/
  jing-loan-sbtc-stx-single.clar           (v1, existing, unchanged)
  jing-loan-sbtc-stx-single-v2.clar        (new, thinner than v1)
  jing-lender-reserve.clar                 (new, funding + approvals)
  README-multi-borrower.md                 (this file)
```

`jing-loan-sbtc-for-stx.clar` (the earlier monolithic multi-borrower
draft with in-contract whitelist + credit limits + per-loan debt map)
is superseded by this architecture. Those concerns move into the
reserve; per-loan state stays in each single. The file can be
archived once single-v2 and the reserve exist.
