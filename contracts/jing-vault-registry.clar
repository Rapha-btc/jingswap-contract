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

;; Admin transfer

(define-public (set-contract-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set contract-owner new-owner))))
