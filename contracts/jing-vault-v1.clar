;; jing-vault-v1
;; Personal vault for conditional execution into Jing Swap (sBTC/STX market).
;; Each user deploys their own instance.
;;
;; - Owner: deposits/withdraws funds, signs SIP-018 intents off-chain
;; - Keeper: submits signed intents to execute Jing deposits when price hits
;; - Funds never leave owner's control except into Jing
;;
;; Replay protection: each signed intent's message-hash is consumed in
;; `used-pubkey-authorizations` once spent (Pillar pattern). The owner can
;; have many outstanding intents at once — each is independent.
;;
;; Keepers are off-chain entities paid out-of-band (flat subscription, etc).
;; The contract does not track per-intent fees or pro-rata positions.

(use-trait pyth-storage-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.storage-trait)
(use-trait pyth-decoder-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-traits-v2.core-trait)

;; ---------------------------------------------------------------
;; Constants
;; ---------------------------------------------------------------

(define-constant OWNER tx-sender)
(define-constant PRICE_PRECISION u100000000)
(define-constant MAX_STALENESS u60)

(define-constant BTC_USD_FEED 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43)
(define-constant STX_USD_FEED 0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17)

(define-constant ERR_NOT_OWNER (err u6001))
(define-constant ERR_INVALID_SIGNATURE (err u6002))
(define-constant ERR_REPLAY (err u6003))
(define-constant ERR_EXPIRED (err u6004))
(define-constant ERR_CONDITION_NOT_MET (err u6005))
(define-constant ERR_NO_FUNDS (err u6006))
(define-constant ERR_ORACLE (err u6007))
(define-constant ERR_INVALID_SIDE (err u6011))
(define-constant ERR_STALE_PRICE (err u6012))

;; ---------------------------------------------------------------
;; State
;; ---------------------------------------------------------------

;; Owner's compressed pubkey (set once, rotatable)
(define-data-var owner-pubkey (buff 33) 0x000000000000000000000000000000000000000000000000000000000000000000)

;; Trusted keeper principal — can revoke on the owner's behalf.
(define-data-var keeper (optional principal) none)

;; Replay map — Pillar pattern. Once a message-hash is consumed (executed
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

;; Read stored Pyth prices. Returns the STX-per-BTC ratio and the oldest
;; of the two feeds' publish-time so the caller can enforce staleness.
(define-read-only (read-oracle-price)
  (let (
    (btc-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price BTC_USD_FEED) ERR_ORACLE))
    (stx-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price STX_USD_FEED) ERR_ORACLE))
    (btc-pub (get publish-time btc-feed))
    (stx-pub (get publish-time stx-feed))
  )
    (ok {
      price: (/ (* (to-uint (get price btc-feed)) PRICE_PRECISION)
                (to-uint (get price stx-feed))),
      oldest-publish: (if (< btc-pub stx-pub) btc-pub stx-pub),
    })))

;; ---------------------------------------------------------------
;; Owner-only
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
    (try! (contract-call? .jing-vault-registry log-deposit "stx" amount))
    (ok true)))

(define-public (deposit-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender current-contract none))
    (try! (contract-call? .jing-vault-registry log-deposit "sbtc" amount))
    (ok true)))

(define-public (withdraw-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract OWNER))))
    (try! (contract-call? .jing-vault-registry log-withdraw "stx" amount))
    (ok true)))

(define-public (withdraw-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" amount))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount current-contract OWNER none))))
    (try! (contract-call? .jing-vault-registry log-withdraw "sbtc" amount))
    (ok true)))

;; Cancel a signed execute intent. Callable by owner or the whitelisted
;; keeper — both are trusted principals. Marks the target hash consumed
;; so it can never fire.
(define-public (revoke-intent (target-hash (buff 32)))
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (asserts! (is-none (map-get? used-pubkey-authorizations target-hash)) ERR_REPLAY)
    (map-set used-pubkey-authorizations target-hash (var-get owner-pubkey))
    (try! (contract-call? .jing-vault-registry log-revoke target-hash))
    (ok true)))

;; ---------------------------------------------------------------
;; Keeper functions
;; ---------------------------------------------------------------

;; Execute against current stored Pyth prices (free path). Asserts freshness.
(define-public (execute-into-jing
    (sig (buff 65))
    (side (string-ascii 4))
    (amount uint)
    (target-price uint)
    (condition (string-ascii 2))
    (auth-id uint)
    (expiry uint))
  (let (
    (msg-hash (contract-call? .jing-vault-auth build-execute-hash {
      action: "execute",
      side: side,
      amount: amount,
      target-price: target-price,
      condition: condition,
      auth-id: auth-id,
      expiry: expiry,
    }))
    (oracle (try! (read-oracle-price)))
  )
    (asserts! (> (get oldest-publish oracle) (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
    (try! (run-execute msg-hash sig side amount target-price condition expiry (get price oracle)))
    (ok msg-hash)))

;; Execute path that first refreshes Pyth from VAAs, then runs the same logic.
(define-public (execute-into-jing-with-refresh
    (sig (buff 65))
    (side (string-ascii 4))
    (amount uint)
    (target-price uint)
    (condition (string-ascii 2))
    (auth-id uint)
    (expiry uint)
    (btc-vaa (buff 8192))
    (stx-vaa (buff 8192))
    (pyth-storage <pyth-storage-trait>)
    (pyth-decoder <pyth-decoder-trait>)
    (wormhole-core <wormhole-core-trait>))
  (begin
    (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds btc-vaa
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core }))
    (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds stx-vaa
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core }))
    (let (
      (msg-hash (contract-call? .jing-vault-auth build-execute-hash {
        action: "execute",
        side: side,
        amount: amount,
        target-price: target-price,
        condition: condition,
        auth-id: auth-id,
        expiry: expiry,
      }))
      (oracle (try! (read-oracle-price)))
    )
      (asserts! (> (get oldest-publish oracle) (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
      (try! (run-execute msg-hash sig side amount target-price condition expiry (get price oracle)))
      (ok msg-hash))))

;; ---------------------------------------------------------------
;; Internal helpers
;; ---------------------------------------------------------------

(define-private (run-execute
    (msg-hash (buff 32))
    (sig (buff 65))
    (side (string-ascii 4))
    (amount uint)
    (target-price uint)
    (condition (string-ascii 2))
    (expiry uint)
    (oracle-price uint))
  (let (
    (signer (unwrap! (secp256k1-recover? msg-hash sig) ERR_INVALID_SIGNATURE))
  )
    (asserts! (is-eq signer (var-get owner-pubkey)) ERR_INVALID_SIGNATURE)
    (asserts! (is-none (map-get? used-pubkey-authorizations msg-hash)) ERR_REPLAY)
    (asserts! (or (is-eq expiry u0) (< stacks-block-height expiry)) ERR_EXPIRED)
    (asserts! (check-condition oracle-price target-price condition) ERR_CONDITION_NOT_MET)
    (map-set used-pubkey-authorizations msg-hash signer)

    ;; Perform the deposit — underlying transfers error natively on
    ;; insufficient balance.
    (if (is-eq side "stx")
      (try! (as-contract? ((with-stx amount))
        (try! (contract-call? .blind-auction deposit-stx amount))))
      (if (is-eq side "sbtc")
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" amount))
          (try! (contract-call? .blind-auction deposit-sbtc amount))))
        (asserts! false ERR_INVALID_SIDE)))

    (try! (contract-call? .jing-vault-registry log-execute
      msg-hash side amount target-price condition oracle-price))
    (ok true)))

(define-private (check-condition (oracle-price uint) (target uint) (cond (string-ascii 2)))
  (if (is-eq cond "le")
    (<= oracle-price target)
    (if (is-eq cond "ge")
      (>= oracle-price target)
      false)))
