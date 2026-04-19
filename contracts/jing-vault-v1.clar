;; jing-vault-v1
;; Personal vault for conditional execution into Jing Swap (blind-premium)
;; with a Bitflow fallback path. Each user deploys their own instance.
;;
;; - Owner: deposits/withdraws funds, signs SIP-018 intents off-chain
;; - Keeper: submits signed intents (jing-deposit, bitflow-swap) or
;;           triggers unsigned cancels on Jing on the owner's behalf
;; - Funds never leave owner's control except into blind-premium,
;;   into Bitflow's xyk-core-v-1-2 (pinned principals), or back to OWNER
;;
;; Replay protection: each signed intent's message-hash is consumed in
;; `used-pubkey-authorizations` once spent (Pillar pattern). The owner can
;; have many outstanding intents at once -- each is independent and single-shot.
;;
;; Keepers are off-chain entities paid out-of-band (flat subscription, etc).
;; The contract does not track per-intent fees or pro-rata positions.
;;
;; Price semantics (single unit across both venues):
;;   limit-price = STX per sBTC, 8-decimal precision (Pyth convention)
;;   - side="stx"  (spending STX, receiving sBTC):  CEILING (max acceptable)
;;   - side="sbtc" (spending sBTC, receiving STX):  FLOOR   (min acceptable)
;;
;; For Bitflow the vault derives min-out from (amount, limit-price) on-chain.

;; ---------------------------------------------------------------
;; Constants
;; ---------------------------------------------------------------

(define-constant OWNER tx-sender)

;; Precision: Pyth is 8-dec, so limit-price is STX/sBTC * 1e8.
(define-constant PRICE_PRECISION u100000000)
;; sBTC is 8-dec (sats), STX is 6-dec (ustx). Conversion factor = 1e2.
(define-constant DECIMAL_FACTOR u100)

;; Bitflow principals are inlined at the call sites below because
;; Clarity requires literal principals for contract-call? targets --
;; constants cannot be used. The sbtc-stx v-1-1 pool has
;; x = sBTC, y = STX (Bitflow's token-stx-v-1-2 wrapper handles native STX).
;;   core:    'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
;;   pool:    'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
;;   x-token: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
;;   y-token: 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2

(define-constant ERR_NOT_OWNER (err u6001))
(define-constant ERR_INVALID_SIGNATURE (err u6002))
(define-constant ERR_REPLAY (err u6003))
(define-constant ERR_EXPIRED (err u6004))
(define-constant ERR_NO_FUNDS (err u6006))
(define-constant ERR_INVALID_SIDE (err u6011))
(define-constant ERR_INVALID_PRICE (err u6013))

;; ---------------------------------------------------------------
;; State
;; ---------------------------------------------------------------

;; Owner's compressed pubkey (set once, rotatable)
(define-data-var owner-pubkey (buff 33) 0x000000000000000000000000000000000000000000000000000000000000000000)

;; Trusted keeper principal -- can cancel Jing deposits and revoke
;; intents on the owner's behalf.
(define-data-var keeper (optional principal) none)

;; Replay map -- Pillar pattern. Once a message-hash is consumed (executed
;; or revoked), it cannot be used again.
(define-map used-pubkey-authorizations (buff 32) (buff 33))

;; ---------------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------------

(define-read-only (get-owner) OWNER)

(define-read-only (get-status)
  {
    owner: OWNER,
    pubkey: (var-get owner-pubkey),
    keeper: (var-get keeper),
    stx-balance: (stx-get-balance current-contract),
    sbtc-balance: (unwrap-panic (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract)),
  })

(define-read-only (is-signature-used (h (buff 32)))
  (is-some (map-get? used-pubkey-authorizations h)))

;; ---------------------------------------------------------------
;; Owner-only admin
;; ---------------------------------------------------------------

(define-public (set-owner-pubkey (pubkey (buff 33)))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (ok (var-set owner-pubkey pubkey))))

(define-public (set-keeper (new-keeper (optional principal)))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (ok (var-set keeper new-keeper))))

(define-public (deposit-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (stx-transfer? amount tx-sender current-contract))
    (try! (contract-call? .jing-core log-deposit "stx" amount))
    (ok true)))

(define-public (deposit-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender current-contract none))
    (try! (contract-call? .jing-core log-deposit "sbtc" amount))
    (ok true)))

(define-public (withdraw-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract OWNER))))
    (try! (contract-call? .jing-core log-withdraw "stx" amount))
    (ok true)))

(define-public (withdraw-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" amount))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount current-contract OWNER none))))
    (try! (contract-call? .jing-core log-withdraw "sbtc" amount))
    (ok true)))

;; Cancel a signed intent. Callable by owner or the whitelisted
;; keeper -- both are trusted principals. Marks the target hash consumed
;; so it can never fire.
(define-public (revoke-intent (target-hash (buff 32)))
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (asserts! (is-none (map-get? used-pubkey-authorizations target-hash)) ERR_REPLAY)
    (map-set used-pubkey-authorizations target-hash (var-get owner-pubkey))
    (try! (contract-call? .jing-core log-revoke target-hash))
    (ok true)))

;; ---------------------------------------------------------------
;; Trusted-principal Jing cancels (no signature required)
;; ---------------------------------------------------------------
;;
;; Owner or keeper can cancel an in-flight deposit on blind-premium.
;; Refund lands back in the vault and is then freely eligible for any
;; pre-signed intent whose balance the vault can now satisfy.
;; blind-premium only permits cancel during PHASE_DEPOSIT of the current
;; cycle -- outside that window the underlying call reverts and no state
;; changes here.

(define-public (cancel-jing-stx)
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (try! (as-contract (contract-call? .blind-premium cancel-stx-deposit)))
    (try! (contract-call? .jing-core log-cancel "stx"))
    (ok true)))

(define-public (cancel-jing-sbtc)
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (try! (as-contract (contract-call? .blind-premium cancel-sbtc-deposit)))
    (try! (contract-call? .jing-core log-cancel "sbtc"))
    (ok true)))

;; ---------------------------------------------------------------
;; Signed intents
;; ---------------------------------------------------------------

;; Execute a signed Jing deposit intent on blind-premium. limit-price is
;; passed through to blind-premium directly (same unit, same precision).
(define-public (execute-jing-deposit
    (sig (buff 65))
    (side (string-ascii 4))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint))
  (let (
    (msg-hash (contract-call? .jing-vault-auth build-intent-hash {
      action: "jing-deposit",
      side: side,
      amount: amount,
      limit-price: limit-price,
      auth-id: auth-id,
      expiry: expiry,
    }))
  )
    (try! (verify-and-consume msg-hash sig expiry))
    (if (is-eq side "stx")
      (try! (as-contract? ((with-stx amount))
        (try! (contract-call? .blind-premium deposit-stx amount limit-price))))
      (if (is-eq side "sbtc")
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" amount))
          (try! (contract-call? .blind-premium deposit-sbtc amount limit-price))))
        (asserts! false ERR_INVALID_SIDE)))
    (try! (contract-call? .jing-core log-jing-deposit
      msg-hash side amount limit-price))
    (ok msg-hash)))

;; Execute a signed Bitflow swap intent. min-out is derived on-chain from
;; (amount, limit-price) so the owner signs a price policy, not a raw
;; token amount. All Bitflow principals are pinned constants -- no trait
;; args, no substitution vector.
(define-public (execute-bitflow-swap
    (sig (buff 65))
    (side (string-ascii 4))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint))
  (let (
    (msg-hash (contract-call? .jing-vault-auth build-intent-hash {
      action: "bitflow-swap",
      side: side,
      amount: amount,
      limit-price: limit-price,
      auth-id: auth-id,
      expiry: expiry,
    }))
    (min-out (derive-min-out side amount limit-price))
  )
    (asserts! (> limit-price u0) ERR_INVALID_PRICE)
    (try! (verify-and-consume msg-hash sig expiry))
    ;; side = "stx"  -> spending STX (y), receiving sBTC (x) -> swap-y-for-x
    ;; side = "sbtc" -> spending sBTC (x), receiving STX (y) -> swap-x-for-y
    (if (is-eq side "stx")
      (try! (as-contract? ((with-stx amount))
        (try! (contract-call?
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
          swap-y-for-x
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
          'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
          amount min-out))))
      (if (is-eq side "sbtc")
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" amount))
          (try! (contract-call?
            'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
            swap-x-for-y
            'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
            'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
            amount min-out))))
        (asserts! false ERR_INVALID_SIDE)))
    (try! (contract-call? .jing-core log-bitflow-swap
      msg-hash side amount limit-price min-out))
    (ok msg-hash)))

;; ---------------------------------------------------------------
;; Internal helpers
;; ---------------------------------------------------------------

(define-private (verify-and-consume
    (msg-hash (buff 32))
    (sig (buff 65))
    (expiry uint))
  (let (
    (signer (unwrap! (secp256k1-recover? msg-hash sig) ERR_INVALID_SIGNATURE))
  )
    (asserts! (is-eq signer (var-get owner-pubkey)) ERR_INVALID_SIGNATURE)
    (asserts! (is-none (map-get? used-pubkey-authorizations msg-hash)) ERR_REPLAY)
    (asserts! (or (is-eq expiry u0) (< stacks-block-height expiry)) ERR_EXPIRED)
    (map-set used-pubkey-authorizations msg-hash signer)
    (ok true)))

;; Derive Bitflow min-out from (amount, limit-price).
;;
;; limit-price = STX_per_sBTC * 1e8 (PRICE_PRECISION)
;; sBTC is 8-dec (sats), STX is 6-dec (ustx), DECIMAL_FACTOR = 1e8/1e6 = 100
;;
;; side="stx"  (spending A ustx, want >= M sats):
;;   M = A * (PRICE_PRECISION * DECIMAL_FACTOR) / limit-price
;; side="sbtc" (spending A sats, want >= M ustx):
;;   M = A * limit-price / (PRICE_PRECISION * DECIMAL_FACTOR)
(define-private (derive-min-out
    (side (string-ascii 4))
    (amount uint)
    (limit-price uint))
  (if (is-eq side "stx")
    (/ (* amount (* PRICE_PRECISION DECIMAL_FACTOR)) limit-price)
    (if (is-eq side "sbtc")
      (/ (* amount limit-price) (* PRICE_PRECISION DECIMAL_FACTOR))
      u0)))
