;; jing-vault-registry
;; Approved vault code hashes and user-to-vault mapping.
;; Keepers read this to discover active vaults and verify legitimacy.

(define-constant ERR_NOT_AUTHORIZED (err u5001))
(define-constant ERR_ALREADY_REGISTERED (err u5003))

(define-data-var contract-owner principal tx-sender)

;; Approved vault template code hashes
(define-map approved-hashes (buff 32) bool)

;; User -> their vault contract address
(define-map user-vaults principal principal)

;; Vault contract -> owner (reverse lookup for keepers)
(define-map vault-owners principal principal)

;; Read-only lookups

(define-read-only (is-approved-hash (code-hash (buff 32)))
  (default-to false (map-get? approved-hashes code-hash)))

(define-read-only (get-user-vault (user principal))
  (map-get? user-vaults user))

(define-read-only (get-vault-owner (vault principal))
  (map-get? vault-owners vault))

;; Admin: approve a vault template hash

(define-public (approve-hash (code-hash (buff 32)))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (map-set approved-hashes code-hash true))))

(define-public (revoke-hash (code-hash (buff 32)))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (map-delete approved-hashes code-hash))))

;; User: register their deployed vault
;; TODO: when clarity adds get-contract-hash?, verify on-chain.
;; For now, keeper verifies off-chain before interacting.

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

;; Activity log endpoints — called by vaults. Each emits a print with
;; `vault` (contract-caller) captured natively,
;; so vaults never pass the vault principal as a param.

(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (begin
    (print { event: "vault-deposit", vault: contract-caller,asset: asset, amount: amount })
    (ok true)))

(define-public (log-withdraw (asset (string-ascii 4)) (amount uint))
  (begin
    (print { event: "vault-withdraw", vault: contract-caller,asset: asset, amount: amount })
    (ok true)))

(define-public (log-revoke (target-hash (buff 32)))
  (begin
    (print { event: "vault-revoke", vault: contract-caller,target-hash: target-hash })
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
  (begin
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
  (begin
    (print {
      event: "vault-bitflow-swap",
      vault: contract-caller,
      msg-hash: msg-hash,
      side: side,
      amount: amount,
      limit-price: limit-price,
      min-out: min-out,
    })
    (ok true)))

;; Admin transfer

(define-public (set-contract-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set contract-owner new-owner))))
