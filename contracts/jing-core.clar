;; jing-core (file rename pending -- still jing-vault-registry.clar for now)
;;
;; Responsibilities
;; ----------------
;; 1. Approved vault code hashes + user<->vault mapping.
;; 2. Approved market contracts allowlist.
;; 3. Canonical per-token equity ledger. Equity is tokens actively locked in
;;    the Jing ecosystem for an owner (vault balances + approved-market
;;    deposits), keyed by (token principal, owner principal). Alex reads
;;    get-token-equity(sbtc-principal, user) for the dual-stacking booster.
;; 4. Single event stream: vaults AND markets emit here so dashboards only
;;    poll jing-core.
;;
;; Token-agnostic market endpoints
;; -------------------------------
;; Markets declare their pair as TOKEN_X / TOKEN_Y constants and pass both
;; principals to every log-* call. jing-core doesn't assume which token is
;; "base" -- it credits/debits per-token and the indexer can aggregate
;; across pairs. Event names use -x / -y suffixes; the token-x / token-y
;; fields disambiguate.

(define-constant ERR_NOT_AUTHORIZED (err u5001))
(define-constant ERR_INVALID_CONTRACT_HASH (err u5002))
(define-constant ERR_ALREADY_REGISTERED (err u5003))
(define-constant ERR_NOT_VERIFIED (err u5005))
(define-constant ERR_HASH_MISMATCH (err u5006))
(define-constant ERR_NO_PENDING_PROPOSAL (err u5007))
(define-constant ERR_TIMELOCK_NOT_ELAPSED (err u5008))
(define-constant ERR_OWNER_CANNOT_BE_VALIDATOR (err u5009))
(define-constant ERR_ALREADY_VALIDATOR (err u5010))
(define-constant ERR_VALIDATOR_PENDING (err u5011))
(define-constant ERR_VALIDATOR_LIMIT_REACHED (err u5012))
(define-constant ERR_NO_PENDING_VALIDATOR (err u5013))
(define-constant ERR_NOT_VALIDATOR (err u5014))
(define-constant ERR_NEW_OWNER_IS_VALIDATOR (err u5015))
(define-constant ERR_PAUSED (err u5016))

;; Burn blocks (~10 min each) that must elapse between proposing and
;; confirming a verified contract or a new validator. ~24h cushion for
;; off-chain audit.
(define-constant TIMELOCK_BURN_BLOCKS u144)

;; Cap on the validator set. Validators independently confirm verified
;; contracts proposed by the contract-owner; a small set keeps coordination
;; tractable while distributing the trust away from the owner.
(define-constant MAX_VALIDATORS u5)

;; sBTC principal -- used by vault-side logs that still speak in
;; (string-ascii 4) asset codes ("sbtc"/"stx"). Market-side logs are fully
;; token-agnostic and don't reference this constant.
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-data-var contract-owner principal tx-sender)

;; Approved canonical contract templates. Keyed by the canonical contract's
;; principal (a human-readable label like 'SP....jing-vault-v1) so events
;; and reads name what the hash represents. A vault registers by passing
;; the canonical principal it claims to match; jing-core compares the
;; vault's actual code hash against the stored hash for that canonical.
(define-map verified-contracts principal (buff 32))

;; Two-step add flow. `propose-verified-contract` writes here with the
;; current burn-block-height; after TIMELOCK_BURN_BLOCKS elapse, a
;; validator (NOT the owner) calls `confirm-verified-contract` to promote
;; it into verified-contracts. The owner can `cancel-pending-contract`
;; before confirmation.
(define-map pending-verified-contracts
  principal
  { hash: (buff 32), proposed-at: uint })

;; Lifecycle is one-way. Pending PROPOSALS can still be aborted via
;; `cancel-pending-contract` before confirmation -- that doesn't touch
;; the live verified set, only discards a not-yet-promoted entry. Once a
;; contract is CONFIRMED into verified-contracts, however, it stays
;; there forever. There is no removal primitive. Removing a confirmed
;; template -- even with timelock + validator confirmation -- would
;; expose a class of failure modes where a downstream consumer (e.g. a
;; market that gates access by hash) could be cut off mid-cycle and
;; strand user funds. The correct primitive for "stop using this
;; template now" is PAUSING -- at the per-market level (each market has
;; its own paused flag), and potentially a future protocol-wide pause
;; on jing-core's *entry* paths (deposits, new positions) while *exit*
;; paths (withdraws, cancels, refunds) stay open. That preserves user
;; fund access while halting growth of any flawed surface.

;; Validator set. Keyed by principal; presence in the map = active
;; validator. `validator-count` mirrors map size so we can enforce
;; MAX_VALIDATORS without iterating. Owner cannot be a validator (asserted
;; at propose time and on owner change).
(define-map validators principal bool)
(define-data-var validator-count uint u0)

;; Two-step add flow for validators, mirroring verified-contracts. Anyone
;; can confirm after TIMELOCK_BURN_BLOCKS -- the timelock IS the audit
;; window, and the bootstrap case (zero validators) requires a
;; non-validator confirmer.
(define-map pending-validators principal uint)

;; Protocol-wide pause. When true, ENTRY-side log-* functions (deposits,
;; jing-deposits, bitflow-swaps, market deposits, settlement chain)
;; revert. EXIT-side log-* functions (withdraws, refunds, cancels,
;; revokes, cancel-cycle) stay open so user funds remain accessible.
;; Either the owner or any validator can pause instantly (distributed
;; trip-wire); only the owner can unpause, and only after
;; TIMELOCK_BURN_BLOCKS have elapsed since the most recent pause event,
;; so a release isn't a knee-jerk reversal of an emergency call.
(define-data-var paused bool false)
(define-data-var paused-at uint u0)

;; Unified registry of jing-ecosystem contracts -- vaults, reserves, and
;; snpls all share the same registration mechanism (hash-verified
;; self-registration against a canonical template) and the same auth
;; semantics on log-* calls, so they share one map. The canonical
;; principal in the `registered` event tells indexers what kind of
;; contract it is. Bool-shape (Pillar pattern): jing-core only tracks
;; whether a contract is registered, not who owns it. Equity is keyed
;; per-principal, so each registered contract holds its own equity
;; bucket and any external aggregation per-user is off-chain.
(define-map registered-contracts principal bool)


;; Equity per (token, owner). Debits floor at 0 to absorb proportional
;; distribution rounding.
(define-map token-equity { token: principal, owner: principal } uint)
(define-map total-token-equity principal uint)

;; ----- Read-only -----

(define-read-only (is-verified-contract (contract principal))
  (is-some (map-get? verified-contracts contract)))

(define-read-only (get-verified-hash (contract principal))
  (map-get? verified-contracts contract))

(define-read-only (get-pending-verified-contract (contract principal))
  (map-get? pending-verified-contracts contract))

(define-read-only (is-validator (p principal))
  (default-to false (map-get? validators p)))

(define-read-only (get-validator-count) (var-get validator-count))

(define-read-only (get-pending-validator (p principal))
  (map-get? pending-validators p))

(define-read-only (is-paused) (var-get paused))

(define-read-only (get-paused-at) (var-get paused-at))

(define-read-only (get-unpause-eligible-at)
  (+ (var-get paused-at) TIMELOCK_BURN_BLOCKS))

(define-read-only (is-registered (p principal))
  (default-to false (map-get? registered-contracts p)))

(define-read-only (get-token-equity (token principal) (owner principal))
  (default-to u0 (map-get? token-equity { token: token, owner: owner })))

(define-read-only (get-total-token-equity (token principal))
  (default-to u0 (map-get? total-token-equity token)))

;; Zest-shaped read-only for the dual-stacking-boost cross-checks.
;; Returns the principal's DIRECT sBTC equity in the jing ecosystem
;; (their own bucket only). Per-user aggregation across vaults / reserves
;; / snpls the user owns is now off-chain: scan the `registered` event
;; stream to discover those contracts, then sum their equities. This
;; reflects the unified bool-shape registry -- jing-core no longer maps
;; vaults to owners.
(define-read-only (get-balance (user principal))
  (ok (get-token-equity SBTC_TOKEN user)))

;; ----- Private equity helpers -----

(define-private (credit (token principal) (who principal) (amount uint))
  (let (
    (current (get-token-equity token who))
    (total (get-total-token-equity token))
  )
    (map-set token-equity { token: token, owner: who } (+ current amount))
    (map-set total-token-equity token (+ total amount))
    true))

(define-private (debit (token principal) (who principal) (amount uint))
  (let (
    (current (get-token-equity token who))
    (total (get-total-token-equity token))
    (applied (if (> amount current) current amount))
  )
    (map-set token-equity { token: token, owner: who } (- current applied))
    (map-set total-token-equity token (- total applied))
    true))

;; Equity helpers keyed on whether the principal is a registered
;; jing-ecosystem contract (vault, reserve, or snpl). Tokens at a
;; registered contract stay in the ecosystem -> tracked as equity on
;; that contract's bucket. Tokens at a non-registered principal (a user
;; wallet) leave the ecosystem -> no equity change.
(define-private (credit-if-not-registered (token principal) (p principal) (amount uint))
  (if (is-registered p) true (credit token p amount)))

(define-private (debit-if-not-registered (token principal) (p principal) (amount uint))
  (if (is-registered p) true (debit token p amount)))

(define-private (credit-if-registered (token principal) (p principal) (amount uint))
  (if (is-registered p) (credit token p amount) true))

;; Helper consumed by `try!` at the top of every entry-side log-* function.
;; Returns (ok true) when open, (err ERR_PAUSED) when paused -- so try!
;; propagates the err into the calling log function and out to the
;; caller's tx, reverting all state changes atomically.
(define-private (check-not-paused)
  (if (var-get paused) ERR_PAUSED (ok true)))

;; ----- Admin: verified-contract template management -----

;; Two-step add flow, no removal:
;; 1. `propose-verified-contract` (owner-only) reads the canonical's code
;;    hash via `(contract-hash? canonical)` -- so the canonical must be
;;    deployed first -- and writes it to `pending-verified-contracts`
;;    with the current burn-block-height. Hash is always computed
;;    on-chain (no off-chain entry, no fat-finger or forge risk).
;; 2. After TIMELOCK_BURN_BLOCKS, a VALIDATOR (not the owner) calls
;;    `confirm-verified-contract` to promote the proposal into
;;    `verified-contracts`. The owner can `cancel-pending-contract`
;;    before confirmation.
;; Lifecycle is one-way: confirmed templates stay forever. Severing a
;; template could cascade into in-flight fund paths; the protocol-level
;; response to a flawed template is `pause`, not removal.
(define-public (propose-verified-contract (contract principal))
  (let ((computed-hash (unwrap! (contract-hash? contract) ERR_INVALID_CONTRACT_HASH)))
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (map-set pending-verified-contracts contract
      { hash: computed-hash, proposed-at: burn-block-height })
    (print { event: "verified-contract-proposed",
             contract: contract,
             hash: computed-hash,
             proposed-at: burn-block-height,
             eligible-at: (+ burn-block-height TIMELOCK_BURN_BLOCKS) })
    (ok true)))

(define-public (confirm-verified-contract (contract principal))
  (let ((pending (unwrap! (map-get? pending-verified-contracts contract)
                         ERR_NO_PENDING_PROPOSAL))
        (h (get hash pending)))
    (asserts! (is-validator tx-sender) ERR_NOT_AUTHORIZED)
    (asserts! (>= burn-block-height (+ (get proposed-at pending) TIMELOCK_BURN_BLOCKS))
              ERR_TIMELOCK_NOT_ELAPSED)
    (map-set verified-contracts contract h)
    (map-delete pending-verified-contracts contract)
    (print { event: "verified-contract-confirmed",
             contract: contract,
             hash: h,
             confirmed-by: tx-sender })
    (ok true)))

(define-public (cancel-pending-contract (contract principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (map-delete pending-verified-contracts contract)
    (print { event: "verified-contract-cancelled", contract: contract })
    (ok true)))

;; ----- Admin: validator set management -----

;; Validators are the parties authorized to call `confirm-verified-contract`
;; after the timelock elapses. The owner proposes templates; validators
;; independently confirm. Adding a validator follows the same two-step
;; pattern: owner proposes, ANYONE can confirm after TIMELOCK_BURN_BLOCKS
;; (anyone, not validator-only, because the bootstrap case starts with
;; zero validators -- and the timelock is the audit window). Removal is
;; fast: a compromised validator should be ejected immediately. The owner
;; cannot be a validator.
(define-public (propose-validator (validator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (not (is-eq validator (var-get contract-owner))) ERR_OWNER_CANNOT_BE_VALIDATOR)
    (asserts! (not (is-validator validator)) ERR_ALREADY_VALIDATOR)
    (asserts! (is-none (map-get? pending-validators validator)) ERR_VALIDATOR_PENDING)
    (asserts! (< (var-get validator-count) MAX_VALIDATORS) ERR_VALIDATOR_LIMIT_REACHED)
    (map-set pending-validators validator burn-block-height)
    (print { event: "validator-proposed",
             validator: validator,
             proposed-at: burn-block-height,
             eligible-at: (+ burn-block-height TIMELOCK_BURN_BLOCKS) })
    (ok true)))

(define-public (confirm-validator (validator principal))
  (let ((proposed-at (unwrap! (map-get? pending-validators validator)
                              ERR_NO_PENDING_VALIDATOR)))
    (asserts! (>= burn-block-height (+ proposed-at TIMELOCK_BURN_BLOCKS))
              ERR_TIMELOCK_NOT_ELAPSED)
    (asserts! (< (var-get validator-count) MAX_VALIDATORS) ERR_VALIDATOR_LIMIT_REACHED)
    (map-set validators validator true)
    (var-set validator-count (+ (var-get validator-count) u1))
    (map-delete pending-validators validator)
    (print { event: "validator-confirmed", validator: validator })
    (ok true)))

(define-public (cancel-pending-validator (validator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (map-delete pending-validators validator)
    (print { event: "validator-cancelled", validator: validator })
    (ok true)))

(define-public (remove-validator (validator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (is-validator validator) ERR_NOT_VALIDATOR)
    (map-delete validators validator)
    (var-set validator-count (- (var-get validator-count) u1))
    (print { event: "validator-removed", validator: validator })
    (ok true)))

;; ----- Admin: protocol-wide pause -----

;; Pause = halt entries, keep exits open. Either the owner OR any
;; validator can pause instantly so the trip-wire is distributed. Each
;; pause call freshens `paused-at`, so re-pausing while already paused
;; restarts the unpause-eligibility timer (intentional: if a new threat
;; surfaces mid-pause, hitting pause again extends the cooldown).
(define-public (pause)
  (begin
    (asserts! (or (is-eq tx-sender (var-get contract-owner))
                  (is-validator tx-sender)) ERR_NOT_AUTHORIZED)
    (var-set paused true)
    (var-set paused-at burn-block-height)
    (print { event: "paused",
             by: tx-sender,
             paused-at: burn-block-height,
             eligible-at: (+ burn-block-height TIMELOCK_BURN_BLOCKS) })
    (ok true)))

;; Unpause = release. Owner-only, and only callable after
;; TIMELOCK_BURN_BLOCKS have elapsed since the most recent pause event.
;; The cooldown forces deliberation on resume so a panic-pause can't be
;; reversed within minutes by the same/conflicting party.
(define-public (unpause)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (>= burn-block-height (+ (var-get paused-at) TIMELOCK_BURN_BLOCKS))
              ERR_TIMELOCK_NOT_ELAPSED)
    (var-set paused false)
    (print { event: "unpaused", by: tx-sender })
    (ok true)))

(define-public (set-contract-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (not (is-validator new-owner)) ERR_NEW_OWNER_IS_VALIDATOR)
    (ok (var-set contract-owner new-owner))))

;; ----- Contract registration (vaults, reserves, snpls) -----

;; Called by a vault, reserve, or snpl from its `initialize`. Single
;; entry point because the auth check and on-chain semantics are
;; identical for all three -- they're all hash-verified jing-ecosystem
;; contracts that get to write log-* events. The canonical principal
;; the caller passes tells indexers what kind of contract it is (its
;; name encodes the type, e.g. .jing-vault-v1 vs .loan-reserve vs
;; .loan-sbtc-stx-0-jing). One-way: no unregister, since severing a
;; registered contract from jing-core could strain in-flight funds.
;; Anyone can initiate the tx; the hash check binds correctness.
(define-public (register (canonical principal))
  (let (
    (caller contract-caller)
    (caller-hash (unwrap! (contract-hash? contract-caller) ERR_INVALID_CONTRACT_HASH))
    (verified-hash (unwrap! (map-get? verified-contracts canonical) ERR_NOT_VERIFIED))
  )
    (asserts! (is-eq caller-hash verified-hash) ERR_HASH_MISMATCH)
    (asserts! (is-none (map-get? registered-contracts caller)) ERR_ALREADY_REGISTERED)
    (map-set registered-contracts caller true)
    (print { event: "registered",
             contract: caller,
             canonical: canonical,
             hash: caller-hash })
    (ok true)))

;; ====================================================================
;; Vault-side logs -- contract-caller is the vault
;; ====================================================================
;; Still uses (string-ascii 4) asset codes because jing-vault-v1 callers
;; pass "stx"/"sbtc". A future vault generalization can switch to token
;; principals; the equity table is already keyed generically.
;; VAULT LOGS
(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (and (is-eq asset "sbtc") (credit SBTC_TOKEN contract-caller amount))
    (print { event: "vault-deposit", vault: contract-caller,
             asset: asset, amount: amount,
             sbtc-equity: (get-token-equity SBTC_TOKEN contract-caller) })
    (ok true)))

(define-public (log-withdraw (asset (string-ascii 4)) (amount uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (and (is-eq asset "sbtc") (debit SBTC_TOKEN contract-caller amount))
    (print { event: "vault-withdraw", vault: contract-caller,
             asset: asset, amount: amount,
             sbtc-equity: (get-token-equity SBTC_TOKEN contract-caller) })
    (ok true)))

(define-public (log-revoke (target-hash (buff 32)))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "vault-revoke", vault: contract-caller, target-hash: target-hash })
    (ok true)))

(define-public (log-cancel (asset (string-ascii 4)))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "vault-cancel", vault: contract-caller, asset: asset })
    (ok true)))

(define-public (log-jing-deposit
    (msg-hash (buff 32))
    (side (string-ascii 4))
    (amount uint)
    (limit-price uint))
  ;; Intra-ecosystem transfer (vault -> approved market). No equity delta
  ;; here; credit happened on vault ingress, debit happens on market
  ;; cleared/refund.
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "vault-jing-deposit",
      vault: contract-caller,
      msg-hash: msg-hash,
      side: side,
      amount: amount,
      limit-price: limit-price,
    })
    (ok true)))

(define-public (log-bitflow-swap
    (msg-hash (buff 32))
    (side (string-ascii 4))
    (amount uint)
    (limit-price uint)
    (min-out uint))
  ;; side="sbtc": vault spent sBTC to Bitflow -> debit(amount).
  ;; side="stx":  vault received >= min-out sBTC from Bitflow -> credit(min-out).
  ;; Conservative undercount; actual received may be marginally higher.
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (if (is-eq side "sbtc")
      (debit SBTC_TOKEN contract-caller amount)
      (if (is-eq side "stx")
        (credit SBTC_TOKEN contract-caller min-out)
        true))
    (print {
      event: "vault-bitflow-swap",
      vault: contract-caller,
      msg-hash: msg-hash,
      side: side,
      amount: amount,
      limit-price: limit-price,
      min-out: min-out,
      sbtc-equity: (get-token-equity SBTC_TOKEN contract-caller),
    })
    (ok true)))

;; ====================================================================
;; Market-side logs -- contract-caller must be a registered market
;; ====================================================================
;;
;; Every endpoint takes token-x and token-y principals. Event names use
;; -x / -y suffixes; indexers read token-x/token-y to resolve semantics.
;;
;; `amount` in deposit logs is the user's running cycle balance (post-tx),
;; matching the market's deposit-map value so indexers can read it directly.
;; `delta` is the tx increment used for equity accounting.

(define-public (log-deposit-x
    (depositor principal)
    (amount uint)
    (delta uint)
    (limit uint)
    (cycle uint)
    (bumped (optional principal))
    (bumped-amount uint)
    (token-x principal)
    (token-y principal))
  (begin 
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (match bumped b (debit-if-not-registered token-x b bumped-amount) true)
    (credit-if-not-registered token-x depositor delta)
    (print {
      event: "deposit-x",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor,
      amount: amount, delta: delta, limit: limit, cycle: cycle,
      bumped: bumped, bumped-amount: bumped-amount,
      equity-x: (get-token-equity token-x depositor),
      bumped-equity-x: (match bumped b (some (get-token-equity token-x b)) none),
    })
    (ok true)))

(define-public (log-deposit-y
    (depositor principal)
    (amount uint)
    (delta uint)
    (limit uint)
    (cycle uint)
    (bumped (optional principal))
    (bumped-amount uint)
    (token-x principal)
    (token-y principal))
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (match bumped b (debit-if-not-registered token-y b bumped-amount) true)
    (credit-if-not-registered token-y depositor delta)
    (print {
      event: "deposit-y",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor,
      amount: amount, delta: delta, limit: limit, cycle: cycle,
      bumped: bumped, bumped-amount: bumped-amount,
      equity-y: (get-token-equity token-y depositor),
      bumped-equity-y: (match bumped b (some (get-token-equity token-y b)) none),
    })
    (ok true)))

(define-public (log-refund-x
    (depositor principal)
    (amount uint)
    (cycle uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit-if-not-registered token-x depositor amount)
    (print {
      event: "refund-x",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor,
      amount: amount, cycle: cycle,
      equity-x: (get-token-equity token-x depositor),
    })
    (ok true)))

(define-public (log-refund-y
    (depositor principal)
    (amount uint)
    (cycle uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit-if-not-registered token-y depositor amount)
    (print {
      event: "refund-y",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor,
      amount: amount, cycle: cycle,
      equity-y: (get-token-equity token-y depositor),
    })
    (ok true)))

(define-public (log-set-limit-x
    (depositor principal)
    (limit uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "set-limit-x",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, limit: limit,
    })
    (ok true)))

(define-public (log-set-limit-y
    (depositor principal)
    (limit uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "set-limit-y",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, limit: limit,
    })
    (ok true)))

(define-public (log-close-deposits
    (cycle uint)
    (closed-at-block uint)
    (elapsed-blocks uint)
    (token-x principal)
    (token-y principal))
  (begin
    ;; Gates the close-deposits + small-share-roll branch via tx atomicity:
    ;; small-share-rolls are logged earlier in the same tx but the whole tx
    ;; reverts when this assert trips, undoing those logs as well.
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "close-deposits",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      cycle: cycle, closed-at-block: closed-at-block, elapsed-blocks: elapsed-blocks,
    })
    (ok true)))

(define-public (log-small-share-roll-x
    (depositor principal)
    (cycle uint)
    (amount uint)
    (token-x principal)
    (token-y principal))
  (begin
    ;; No-op assert: provides a concrete err type so callers' try! works.
    ;; Auth is enforced transitively by the parent log-close-deposits assert
    ;; firing in the same tx and reverting any earlier sub-branch logs.
    (asserts! true ERR_NOT_AUTHORIZED)
    (print {
      event: "small-share-roll-x",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, cycle: cycle, amount: amount,
    })
    (ok true)))

(define-public (log-small-share-roll-y
    (depositor principal)
    (cycle uint)
    (amount uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! true ERR_NOT_AUTHORIZED)
    (print {
      event: "small-share-roll-y",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, cycle: cycle, amount: amount,
    })
    (ok true)))

(define-public (log-limit-roll-x
    (depositor principal)
    (cycle uint)
    (amount uint)
    (limit uint)
    (clearing uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! true ERR_NOT_AUTHORIZED)
    (print {
      event: "limit-roll-x",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, cycle: cycle, amount: amount,
      limit: limit, clearing: clearing,
    })
    (ok true)))

(define-public (log-limit-roll-y
    (depositor principal)
    (cycle uint)
    (amount uint)
    (limit uint)
    (clearing uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! true ERR_NOT_AUTHORIZED)
    (print {
      event: "limit-roll-y",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, cycle: cycle, amount: amount,
      limit: limit, clearing: clearing,
    })
    (ok true)))

(define-public (log-settlement
    (cycle uint)
    (oracle-price uint)
    (clearing-price uint)
    (x-cleared uint)
    (y-cleared uint)
    (x-unfilled uint)
    (y-unfilled uint)
    (x-fee uint)
    (y-fee uint)
    (x-is-binding bool)
    (token-x principal)
    (token-y principal))
  (begin
    ;; Gates the entire settle branch via tx atomicity. Limit-rolls run
    ;; earlier in execute-settlement and are reverted when this trips;
    ;; distribute-x/y-depositor and sweep-dust run AFTER log-settlement
    ;; in the calling settle/settle-with-refresh, so they never reach
    ;; their log calls when this reverts.
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "settlement",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      cycle: cycle,
      oracle-price: oracle-price, clearing-price: clearing-price,
      x-cleared: x-cleared, y-cleared: y-cleared,
      x-unfilled: x-unfilled, y-unfilled: y-unfilled,
      x-fee: x-fee, y-fee: y-fee,
      binding-side: (if x-is-binding "x" "y"),
    })
    (ok true)))

(define-public (log-distribute-x-depositor
    (depositor principal)
    (cycle uint)
    (y-received uint)
    (x-cleared uint)
    (x-rolled uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! true ERR_NOT_AUTHORIZED)
    (if (> x-cleared u0) (debit token-x depositor x-cleared) true)
    (credit-if-registered token-y depositor y-received)
    (print {
      event: "distribute-x-depositor",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      x-cleared: x-cleared, y-received: y-received, x-rolled: x-rolled,
      equity-x: (get-token-equity token-x depositor),
      equity-y: (get-token-equity token-y depositor),
    })
    (ok true)))

(define-public (log-distribute-y-depositor
    (depositor principal)
    (cycle uint)
    (x-received uint)
    (y-cleared uint)
    (y-rolled uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! true ERR_NOT_AUTHORIZED)
    (if (> y-cleared u0) (debit token-y depositor y-cleared) true)
    (credit-if-registered token-x depositor x-received)
    (print {
      event: "distribute-y-depositor",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      y-cleared: y-cleared, x-received: x-received, y-rolled: y-rolled,
      equity-x: (get-token-equity token-x depositor),
      equity-y: (get-token-equity token-y depositor),
    })
    (ok true)))

(define-public (log-sweep-dust
    (x-unfilled uint)
    (y-unfilled uint)
    (x-dust uint)
    (x-payout-dust uint)
    (x-roll-dust uint)
    (y-dust uint)
    (y-payout-dust uint)
    (y-roll-dust uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "sweep-dust",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      x-unfilled: x-unfilled, y-unfilled: y-unfilled,
      x-dust: x-dust, x-payout-dust: x-payout-dust, x-roll-dust: x-roll-dust,
      y-dust: y-dust, y-payout-dust: y-payout-dust, y-roll-dust: y-roll-dust,
    })
    (ok true)))

(define-public (log-cancel-cycle
    (cycle uint)
    (x-rolled uint)
    (y-rolled uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "cancel-cycle",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      cycle: cycle,
      x-rolled: x-rolled, y-rolled: y-rolled,
    })
    (ok true)))

;; ====================================================================
;; Reserve-side logs -- contract-caller must be a registered reserve
;; ====================================================================
;;
;; Equity bucket lives on the reserve itself (contract-caller). Mirrors
;; how vaults work -- the contract holds its own bucket; off-chain
;; aggregation reads `(contract-call? <reserve> get-lender)` to attribute
;; the bucket to a user. NOTE: if a vault is the lender, the vault still
;; has its own bucket from `log-deposit`. Off-chain summation must skip
;; the reserve in that case (or skip the vault) to avoid double-counting.

(define-public (log-reserve-supply (amount uint))
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (credit SBTC_TOKEN contract-caller amount)
    (print { event: "reserve-supply",
             reserve: contract-caller,
             amount: amount,
             sbtc-equity: (get-token-equity SBTC_TOKEN contract-caller) })
    (ok true)))

(define-public (log-reserve-withdraw-sbtc (amount uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit SBTC_TOKEN contract-caller amount)
    (print { event: "reserve-withdraw-sbtc",
             reserve: contract-caller,
             amount: amount,
             sbtc-equity: (get-token-equity SBTC_TOKEN contract-caller) })
    (ok true)))

(define-public (log-reserve-withdraw-stx (amount uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-withdraw-stx",
             reserve: contract-caller, amount: amount })
    (ok true)))

(define-public (log-reserve-open-credit-line
    (snpl principal) (borrower principal)
    (cap-sbtc uint) (interest-bps uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-open-credit-line",
             reserve: contract-caller,
             snpl: snpl, borrower: borrower,
             cap-sbtc: cap-sbtc, interest-bps: interest-bps })
    (ok true)))

(define-public (log-reserve-set-credit-line-cap (snpl principal) (cap-sbtc uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-set-credit-line-cap",
             reserve: contract-caller, snpl: snpl, cap-sbtc: cap-sbtc })
    (ok true)))

(define-public (log-reserve-set-credit-line-interest (snpl principal) (interest-bps uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-set-credit-line-interest",
             reserve: contract-caller, snpl: snpl, interest-bps: interest-bps })
    (ok true)))

(define-public (log-reserve-close-credit-line (snpl principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-close-credit-line",
             reserve: contract-caller, snpl: snpl })
    (ok true)))

;; Reserve's OWN paused flag (per-reserve, separate from jing-core's
;; protocol-wide pause). Logged here for index visibility.
(define-public (log-reserve-set-paused (paused-state bool))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-set-paused",
             reserve: contract-caller, paused: paused-state })
    (ok true)))

(define-public (log-reserve-set-min-sbtc-draw (amount uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-set-min-sbtc-draw",
             reserve: contract-caller, amount: amount })
    (ok true)))

(define-public (log-reserve-draw
    (snpl principal) (amount uint) (new-outstanding-sbtc uint))
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-draw",
             reserve: contract-caller,
             snpl: snpl,
             amount: amount,
             new-outstanding-sbtc: new-outstanding-sbtc })
    (ok true)))

(define-public (log-reserve-notify-return
    (snpl principal) (amount uint) (new-outstanding-sbtc uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "reserve-notify-return",
             reserve: contract-caller,
             snpl: snpl,
             amount: amount,
             new-outstanding-sbtc: new-outstanding-sbtc })
    (ok true)))

;; ====================================================================
;; SNPL-side logs -- contract-caller must be a registered snpl. SNPL never
;; accumulates an equity bucket: the sBTC inside an SNPL is borrowed (debt
;; for borrower, exposure already counted on the reserve side for the
;; lender), so none of these log functions credit/debit the equity table.
;; ====================================================================

(define-public (log-snpl-set-reserve (reserve principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "snpl-set-reserve",
             snpl: contract-caller, reserve: reserve })
    (ok true)))

(define-public (log-snpl-borrow
    (loan-id uint) (borrower principal) (amount uint)
    (interest-bps uint) (deadline uint) (reserve principal))
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "snpl-borrow",
             snpl: contract-caller,
             loan-id: loan-id,
             borrower: borrower,
             amount: amount,
             interest-bps: interest-bps,
             deadline: deadline,
             reserve: reserve })
    (ok true)))

(define-public (log-snpl-swap-deposit
    (loan-id uint) (amount uint) (limit uint) (cycle uint))
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "snpl-swap-deposit",
             snpl: contract-caller,
             loan-id: loan-id,
             amount: amount,
             limit: limit,
             cycle: cycle })
    (ok true)))

(define-public (log-snpl-cancel-swap (loan-id uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "snpl-cancel-swap",
             snpl: contract-caller, loan-id: loan-id })
    (ok true)))

(define-public (log-snpl-set-swap-limit (loan-id uint) (limit-price uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "snpl-set-swap-limit",
             snpl: contract-caller,
             loan-id: loan-id,
             limit-price: limit-price })
    (ok true)))

(define-public (log-snpl-repay
    (loan-id uint)
    (payoff-sbtc uint) (lender-payoff-sbtc uint) (fee-sbtc uint)
    (delta-sbtc uint) (is-shortfall bool)
    (stx-released uint) (reserve principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "snpl-repay",
             snpl: contract-caller,
             loan-id: loan-id,
             payoff-sbtc: payoff-sbtc,
             lender-payoff-sbtc: lender-payoff-sbtc,
             fee-sbtc: fee-sbtc,
             delta-sbtc: delta-sbtc,
             is-shortfall: is-shortfall,
             stx-released: stx-released,
             reserve: reserve })
    (ok true)))

(define-public (log-snpl-seize
    (loan-id uint) (stx-seized uint) (sbtc-seized uint) (reserve principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print { event: "snpl-seize",
             snpl: contract-caller,
             loan-id: loan-id,
             stx-seized: stx-seized,
             sbtc-seized: sbtc-seized,
             reserve: reserve })
    (ok true)))
