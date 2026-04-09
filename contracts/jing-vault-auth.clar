;; jing-vault-auth
;; SIP-018 hash builders for Jing Vault signed intents

(define-constant SIP018_MSG_PREFIX 0x534950303138)

(define-read-only (get-domain-hash)
  (sha256 (unwrap-panic (to-consensus-buff? {
    name: "jing-vault",
    version: "1",
    chain-id: chain-id,
  }))))

;; Execute intent: deposit a specific `amount` from the vault into Jing
;; when the price condition is met. `auth-id` is uniqueness salt (e.g.
;; Date.now() in ms) — replay protection is by message-hash, not nonce.
(define-read-only (build-execute-hash (details {
  action: (string-ascii 8),
  side: (string-ascii 4),
  amount: uint,
  target-price: uint,
  condition: (string-ascii 2),
  auth-id: uint,
  expiry: uint,
}))
  (sha256 (concat SIP018_MSG_PREFIX
    (concat (get-domain-hash)
      (sha256 (unwrap-panic (to-consensus-buff? {
        action: (get action details),
        side: (get side details),
        amount: (get amount details),
        target-price: (get target-price details),
        condition: (get condition details),
        auth-id: (get auth-id details),
        expiry: (get expiry details),
      })))))))
