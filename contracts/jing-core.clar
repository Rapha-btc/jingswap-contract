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
(define-constant ERR_ALREADY_REGISTERED (err u5003))
(define-constant ERR_NOT_APPROVED_MARKET (err u5004))

;; sBTC principal -- used by vault-side logs that still speak in
;; (string-ascii 4) asset codes ("sbtc"/"stx"). Market-side logs are fully
;; token-agnostic and don't reference this constant.
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-data-var contract-owner principal tx-sender)

(define-map approved-hashes (buff 32) bool)
(define-map user-vaults principal principal)
(define-map vault-owners principal principal)

;; Markets permitted to call log-market-* endpoints.
(define-map approved-markets principal bool)

;; Equity per (token, owner). Debits floor at 0 to absorb proportional
;; distribution rounding.
(define-map token-equity { token: principal, owner: principal } uint)
(define-map total-token-equity principal uint)

;; ----- Read-only -----

(define-read-only (is-approved-hash (code-hash (buff 32)))
  (default-to false (map-get? approved-hashes code-hash)))

(define-read-only (get-user-vault (user principal))
  (map-get? user-vaults user))

(define-read-only (get-vault-owner (vault principal))
  (map-get? vault-owners vault))

(define-read-only (is-approved-market (market principal))
  (default-to false (map-get? approved-markets market)))

(define-read-only (is-registered-vault (p principal))
  (is-some (map-get? vault-owners p)))

(define-read-only (resolve-owner (p principal))
  (default-to p (map-get? vault-owners p)))

(define-read-only (get-token-equity (token principal) (owner principal))
  (default-to u0 (map-get? token-equity { token: token, owner: owner })))

(define-read-only (get-total-token-equity (token principal))
  (default-to u0 (map-get? total-token-equity token)))

;; Zest-shaped read-only for the dual-stacking-boost cross-checks.
;; Aggregates user's total sBTC equity across all approved markets +
;; registered vaults (and reserves once their reserve principal is
;; mapped in vault-owners).
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

(define-private (credit-if-not-vault (token principal) (p principal) (amount uint))
  (if (is-registered-vault p) true (credit token p amount)))

(define-private (debit-if-not-vault (token principal) (p principal) (amount uint))
  (if (is-registered-vault p) true (debit token p amount)))

(define-private (credit-if-vault (token principal) (p principal) (amount uint))
  (if (is-registered-vault p) (credit token (resolve-owner p) amount) true))

;; ----- Admin -----

(define-public (approve-hash (code-hash (buff 32)))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (map-set approved-hashes code-hash true))))

(define-public (revoke-hash (code-hash (buff 32)))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (map-delete approved-hashes code-hash))))

(define-public (approve-market (market principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (map-set approved-markets market true)
    (print { event: "market-approved", market: market })
    (ok true)))

(define-public (revoke-market (market principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (map-delete approved-markets market)
    (print { event: "market-revoked", market: market })
    (ok true)))

(define-public (set-contract-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set contract-owner new-owner))))

;; ----- Vault registration -----

(define-public (register-vault (vault principal))
  (begin
    (asserts! (is-none (map-get? user-vaults tx-sender)) ERR_ALREADY_REGISTERED)
    (map-set user-vaults tx-sender vault)
    (map-set vault-owners vault tx-sender)
    (print { event: "vault-registered", owner: tx-sender, vault: vault })
    (ok true)))

(define-public (unregister-vault)
  (let ((vault (unwrap! (map-get? user-vaults tx-sender) ERR_NOT_AUTHORIZED)))
    (map-delete user-vaults tx-sender)
    (map-delete vault-owners vault)
    (print { event: "vault-unregistered", owner: tx-sender, vault: vault })
    (ok true)))

;; ====================================================================
;; Vault-side logs -- contract-caller is the vault
;; ====================================================================
;; Still uses (string-ascii 4) asset codes because jing-vault-v1 callers
;; pass "stx"/"sbtc". A future vault generalization can switch to token
;; principals; the equity table is already keyed generically.

(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (asserts! (>= amount u0) ERR_NOT_AUTHORIZED)
    (and (is-eq asset "sbtc") (credit SBTC_TOKEN owner amount))
    (print { event: "vault-deposit", vault: contract-caller, owner: owner,
             asset: asset, amount: amount,
             sbtc-equity: (get-token-equity SBTC_TOKEN owner) })
    (ok true)))

(define-public (log-withdraw (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (asserts! (>= amount u0) ERR_NOT_AUTHORIZED)
    (and (is-eq asset "sbtc") (debit SBTC_TOKEN owner amount))
    (print { event: "vault-withdraw", vault: contract-caller, owner: owner,
             asset: asset, amount: amount,
             sbtc-equity: (get-token-equity SBTC_TOKEN owner) })
    (ok true)))

(define-public (log-revoke (target-hash (buff 32)))
  (begin
    (print { event: "vault-revoke", vault: contract-caller, target-hash: target-hash })
    (ok true)))

(define-public (log-cancel (asset (string-ascii 4)))
  (begin
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
    (print {
      event: "vault-jing-deposit",
      vault: contract-caller,
      owner: (resolve-owner contract-caller),
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
  (let ((owner (resolve-owner contract-caller)))
    (if (is-eq side "sbtc")
      (debit SBTC_TOKEN owner amount)
      (if (is-eq side "stx")
        (credit SBTC_TOKEN owner min-out)
        true))
    (print {
      event: "vault-bitflow-swap",
      vault: contract-caller,
      owner: owner,
      msg-hash: msg-hash,
      side: side,
      amount: amount,
      limit-price: limit-price,
      min-out: min-out,
      sbtc-equity: (get-token-equity SBTC_TOKEN owner),
    })
    (ok true)))

;; ====================================================================
;; Market-side logs -- contract-caller must be an approved market
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
  (let ((owner (resolve-owner depositor)))
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (match bumped b (debit-if-not-vault token-x b bumped-amount) true)
    (credit-if-not-vault token-x depositor delta)
    (print {
      event: "deposit-x",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, owner: owner,
      amount: amount, delta: delta, limit: limit, cycle: cycle,
      bumped: bumped, bumped-amount: bumped-amount,
      equity-x: (get-token-equity token-x owner),
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
  (let ((owner (resolve-owner depositor)))
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (match bumped b (debit-if-not-vault token-y b bumped-amount) true)
    (credit-if-not-vault token-y depositor delta)
    (print {
      event: "deposit-y",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, owner: owner,
      amount: amount, delta: delta, limit: limit, cycle: cycle,
      bumped: bumped, bumped-amount: bumped-amount,
      equity-y: (get-token-equity token-y owner),
    })
    (ok true)))

(define-public (log-refund-x
    (depositor principal)
    (amount uint)
    (cycle uint)
    (token-x principal)
    (token-y principal))
  (let ((owner (resolve-owner depositor)))
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (debit-if-not-vault token-x depositor amount)
    (print {
      event: "refund-x",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, owner: owner,
      amount: amount, cycle: cycle,
      equity-x: (get-token-equity token-x owner),
    })
    (ok true)))

(define-public (log-refund-y
    (depositor principal)
    (amount uint)
    (cycle uint)
    (token-x principal)
    (token-y principal))
  (let ((owner (resolve-owner depositor)))
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (debit-if-not-vault token-y depositor amount)
    (print {
      event: "refund-y",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, owner: owner,
      amount: amount, cycle: cycle,
      equity-y: (get-token-equity token-y owner),
    })
    (ok true)))

(define-public (log-set-limit-x
    (depositor principal)
    (limit uint)
    (token-x principal)
    (token-y principal))
  (begin
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
  (let ((owner (resolve-owner depositor)))
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (if (> x-cleared u0) (debit token-x owner x-cleared) true)
    (credit-if-vault token-y depositor y-received)
    (print {
      event: "distribute-x-depositor",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, owner: owner,
      cycle: cycle,
      x-cleared: x-cleared, y-received: y-received, x-rolled: x-rolled,
      equity-x: (get-token-equity token-x owner),
      equity-y: (get-token-equity token-y owner),
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
  (let ((owner (resolve-owner depositor)))
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (if (> y-cleared u0) (debit token-y owner y-cleared) true)
    (credit-if-vault token-x depositor x-received)
    (print {
      event: "distribute-y-depositor",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      depositor: depositor, owner: owner,
      cycle: cycle,
      y-cleared: y-cleared, x-received: x-received, y-rolled: y-rolled,
      equity-x: (get-token-equity token-x owner),
      equity-y: (get-token-equity token-y owner),
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
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
    (asserts! (is-approved-market contract-caller) ERR_NOT_APPROVED_MARKET)
    (print {
      event: "cancel-cycle",
      market: contract-caller,
      token-x: token-x, token-y: token-y,
      cycle: cycle,
      x-rolled: x-rolled, y-rolled: y-rolled,
    })
    (ok true)))
