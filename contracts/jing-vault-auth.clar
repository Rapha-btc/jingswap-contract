;; jing-vault-auth
;; SIP-018 hash builder for Jing Vault signed intents.
;;
;; Both intent types (jing-deposit, bitflow-swap) share the same tuple
;; shape. The `action` field distinguishes them and keeps hashes distinct.

(define-constant SIP018_MSG_PREFIX 0x534950303138)

(define-read-only (get-domain-hash)
  (sha256 (unwrap-panic (to-consensus-buff? {
    name: "jing-vault",
    version: "1",
    chain-id: chain-id,
  }))))

;; `action` is "jing-deposit" or "bitflow-swap" (ASCII, up to 16 chars).
;; `side` is "stx" (spending STX) or "sbtc" (spending sBTC).
;; `limit-price` is STX-per-sBTC in 8-decimal precision:
;;   - side="stx":  CEILING -- max STX/sBTC the owner will pay (buying sBTC)
;;   - side="sbtc": FLOOR   -- min STX/sBTC the owner will accept (selling sBTC)
;; `auth-id` is a uniqueness salt (e.g. Date.now() in ms).
;; `expiry` is a Stacks block height after which the intent is dead.
(define-read-only (build-intent-hash (details {
  action: (string-ascii 16),
  side: (string-ascii 4),
  amount: uint,
  limit-price: uint,
  auth-id: uint,
  expiry: uint,
}))
  (sha256 (concat SIP018_MSG_PREFIX
    (concat (get-domain-hash)
      (sha256 (unwrap-panic (to-consensus-buff? {
        action: (get action details),
        side: (get side details),
        amount: (get amount details),
        limit-price: (get limit-price details),
        auth-id: (get auth-id details),
        expiry: (get expiry details),
      })))))))
