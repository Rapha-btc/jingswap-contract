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
;; `side` is the symbol of the token being spent. For sBTC/STX vaults
;; that's "stx" or "sbtc"; for sBTC/USDCx vaults it's "usdcx" or "sbtc".
;; Width is 8 to accommodate any reasonable token symbol; the SIP-018
;; domain is bound to the calling vault, so side semantics never
;; cross-contaminate.
;; `limit-price` is the OTHER-token-per-sBTC in 8-decimal precision:
;;   - side="<other>": CEILING -- max <other>/sBTC the owner will pay
;;     (buying sBTC)
;;   - side="sbtc":    FLOOR   -- min <other>/sBTC the owner will accept
;;     (selling sBTC)
;; `auth-id` is a uniqueness salt (e.g. Date.now() in ms).
;; `expiry` is a Stacks block height after which the intent is dead.
(define-read-only (build-intent-hash (details {
  action: (string-ascii 16),
  side: (string-ascii 128),
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
