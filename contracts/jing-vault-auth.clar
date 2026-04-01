;; jing-vault-auth
;; SIP-018 hash builders for Jing Vault signed intents

(define-constant SIP018_MSG_PREFIX 0x534950303138)

(define-read-only (get-domain-hash)
  (sha256 (unwrap-panic (to-consensus-buff? {
    name: "jing-vault",
    version: "1",
    chain-id: chain-id,
  }))))

;; Execute intent: deposit vault funds into Jing when price condition is met
(define-read-only (build-execute-hash (details {
  action: (string-ascii 8),
  side: (string-ascii 4),
  target-price: uint,
  condition: (string-ascii 2),
  nonce: uint,
  keeper-fee-bps: uint,
  expiry: uint,
}))
  (sha256 (concat SIP018_MSG_PREFIX
    (concat (get-domain-hash)
      (sha256 (unwrap-panic (to-consensus-buff? {
        action: (get action details),
        side: (get side details),
        target-price: (get target-price details),
        condition: (get condition details),
        nonce: (get nonce details),
        keeper-fee-bps: (get keeper-fee-bps details),
        expiry: (get expiry details),
      })))))))

;; Retract intent: cancel vault's deposit from Jing
(define-read-only (build-retract-hash (details {
  action: (string-ascii 8),
  nonce: uint,
  expiry: uint,
}))
  (sha256 (concat SIP018_MSG_PREFIX
    (concat (get-domain-hash)
      (sha256 (unwrap-panic (to-consensus-buff? {
        action: (get action details),
        nonce: (get nonce details),
        expiry: (get expiry details),
      })))))))
