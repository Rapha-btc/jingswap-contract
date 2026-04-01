;; jing-vault-v1
;; Personal vault for conditional execution into Jing Swap.
;; Each user deploys their own instance of this contract.
;;
;; - Owner: deposits/withdraws funds, signs SIP-018 intents off-chain
;; - Keeper: submits signed intents to execute/retract Jing deposits
;; - Funds never leave owner's control except into Jing

;; ---------------------------------------------------------------
;; Constants
;; ---------------------------------------------------------------

(define-constant OWNER tx-sender)
(define-constant PRICE_PRECISION u100000000)
(define-constant BPS_PRECISION u10000)

(define-constant ERR_NOT_OWNER (err u6001))
(define-constant ERR_INVALID_SIGNATURE (err u6002))
(define-constant ERR_STALE_NONCE (err u6003))
(define-constant ERR_EXPIRED (err u6004))
(define-constant ERR_CONDITION_NOT_MET (err u6005))
(define-constant ERR_NO_FUNDS (err u6006))
(define-constant ERR_ORACLE (err u6007))
(define-constant ERR_NOT_ACTIVE (err u6009))
(define-constant ERR_ALREADY_ACTIVE (err u6010))
(define-constant ERR_INVALID_SIDE (err u6011))

;; ---------------------------------------------------------------
;; State
;; ---------------------------------------------------------------

;; Owner's compressed public key (set once at initialization)
(define-data-var owner-pubkey (buff 33) 0x000000000000000000000000000000000000000000000000000000000000000000)

;; Nonce for replay protection - intents with nonce <= this are rejected
(define-data-var nonce uint u0)

;; Active Jing deposit tracking
(define-data-var active bool false)
(define-data-var active-side (string-ascii 4) "")
(define-data-var active-amount uint u0)
(define-data-var active-keeper principal OWNER)
(define-data-var active-keeper-fee-bps uint u0)

;; ---------------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------------

(define-read-only (get-owner) OWNER)

(define-read-only (get-nonce) (var-get nonce))

(define-read-only (get-status)
  {
    owner: OWNER,
    pubkey: (var-get owner-pubkey),
    nonce: (var-get nonce),
    active: (var-get active),
    active-side: (var-get active-side),
    active-amount: (var-get active-amount),
    active-keeper: (var-get active-keeper),
    active-keeper-fee-bps: (var-get active-keeper-fee-bps),
    stx-balance: (stx-get-balance current-contract),
    sbtc-balance: (unwrap-panic (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract)),
  })

(define-read-only (get-oracle-price)
  (let (
    (btc-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43) ERR_ORACLE))
    (stx-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price 0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17) ERR_ORACLE))
  )
    (ok (/ (* (to-uint (get price btc-feed)) PRICE_PRECISION)
           (to-uint (get price stx-feed))))))

;; ---------------------------------------------------------------
;; Owner-only functions
;; ---------------------------------------------------------------

;; Initialize owner pubkey (once)
(define-public (set-owner-pubkey (pubkey (buff 33)))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (ok (var-set owner-pubkey pubkey))))

;; Deposit STX into vault
(define-public (deposit-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (stx-transfer? amount tx-sender current-contract)))

;; Deposit sBTC into vault
(define-public (deposit-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender current-contract none)))

;; Withdraw all STX from vault (only when not active in Jing)
(define-public (withdraw-stx)
  (let ((balance (stx-get-balance current-contract)))
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (not (var-get active)) ERR_ALREADY_ACTIVE)
    (asserts! (> balance u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-stx balance))
      (try! (stx-transfer? balance current-contract OWNER))))
    (ok true)))

;; Withdraw all sBTC from vault (only when not active in Jing)
(define-public (withdraw-sbtc)
  (let ((balance (unwrap-panic (contract-call?
    'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
    get-balance current-contract))))
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (not (var-get active)) ERR_ALREADY_ACTIVE)
    (asserts! (> balance u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" balance))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer balance current-contract OWNER none))))
    (ok true)))

;; Consume a nonce to invalidate an outstanding signed intent
(define-public (consume-nonce (new-nonce uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> new-nonce (var-get nonce)) ERR_STALE_NONCE)
    (var-set nonce new-nonce)
    (print { event: "nonce-consumed", nonce: new-nonce })
    (ok true)))

;; ---------------------------------------------------------------
;; Keeper functions (anyone can call)
;; ---------------------------------------------------------------

;; Execute: deposit vault funds into Jing when signed conditions are met
(define-public (execute-into-jing
    (sig (buff 65))
    (side (string-ascii 4))
    (target-price uint)
    (condition (string-ascii 2))
    (order-nonce uint)
    (keeper-fee-bps uint)
    (expiry uint))
  (let (
    ;; Build SIP-018 message hash
    (msg-hash (contract-call? .jing-vault-auth build-execute-hash {
      action: "execute",
      side: side,
      target-price: target-price,
      condition: condition,
      nonce: order-nonce,
      keeper-fee-bps: keeper-fee-bps,
      expiry: expiry,
    }))
    ;; Recover signer from signature
    (signer (unwrap! (secp256k1-recover? msg-hash sig) ERR_INVALID_SIGNATURE))
    ;; Read oracle price
    (oracle-price (try! (get-oracle-price)))
    ;; Vault balances
    (stx-bal (stx-get-balance current-contract))
    (sbtc-bal (unwrap-panic (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract)))
  )
    ;; Verify signer is owner
    (asserts! (is-eq signer (var-get owner-pubkey)) ERR_INVALID_SIGNATURE)
    ;; Verify nonce
    (asserts! (> order-nonce (var-get nonce)) ERR_STALE_NONCE)
    ;; Verify not expired
    (asserts! (or (is-eq expiry u0) (< stacks-block-height expiry)) ERR_EXPIRED)
    ;; Verify vault not already active in Jing
    (asserts! (not (var-get active)) ERR_ALREADY_ACTIVE)
    ;; Verify condition is met against live oracle
    (asserts! (check-condition oracle-price target-price condition) ERR_CONDITION_NOT_MET)

    ;; Consume nonce
    (var-set nonce order-nonce)

    ;; Deposit into Jing
    (if (is-eq side "stx")
      (begin
        (asserts! (> stx-bal u0) ERR_NO_FUNDS)
        (try! (as-contract? ((with-stx stx-bal))
          (try! (contract-call? .blind-auction deposit-stx stx-bal))))
        (var-set active-amount stx-bal)
        true)
      (if (is-eq side "sbtc")
        (begin
          (asserts! (> sbtc-bal u0) ERR_NO_FUNDS)
          (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-bal))
            (try! (contract-call? .blind-auction deposit-sbtc sbtc-bal))))
          (var-set active-amount sbtc-bal)
          true)
        (asserts! false ERR_INVALID_SIDE)))

    ;; Record active state
    (var-set active true)
    (var-set active-side side)
    (var-set active-keeper tx-sender)
    (var-set active-keeper-fee-bps keeper-fee-bps)

    (print {
      event: "execute-into-jing",
      owner: OWNER,
      keeper: tx-sender,
      side: side,
      amount: (var-get active-amount),
      target-price: target-price,
      condition: condition,
      oracle-price: oracle-price,
      nonce: order-nonce,
    })
    (ok true)))

;; Retract: cancel vault's deposit from Jing (during deposit phase)
(define-public (retract-from-jing
    (sig (buff 65))
    (order-nonce uint)
    (expiry uint))
  (let (
    (msg-hash (contract-call? .jing-vault-auth build-retract-hash {
      action: "retract",
      nonce: order-nonce,
      expiry: expiry,
    }))
    (signer (unwrap! (secp256k1-recover? msg-hash sig) ERR_INVALID_SIGNATURE))
  )
    (asserts! (is-eq signer (var-get owner-pubkey)) ERR_INVALID_SIGNATURE)
    (asserts! (> order-nonce (var-get nonce)) ERR_STALE_NONCE)
    (asserts! (or (is-eq expiry u0) (< stacks-block-height expiry)) ERR_EXPIRED)
    (asserts! (var-get active) ERR_NOT_ACTIVE)

    (var-set nonce order-nonce)

    ;; Cancel from Jing - funds return to vault
    (if (is-eq (var-get active-side) "stx")
      (try! (as-contract? ()
        (try! (contract-call? .blind-auction cancel-stx-deposit))))
      (try! (as-contract? ()
        (try! (contract-call? .blind-auction cancel-sbtc-deposit)))))

    (var-set active false)
    (var-set active-side "")
    (var-set active-amount u0)

    (print { event: "retract-from-jing", owner: OWNER, keeper: tx-sender, nonce: order-nonce })
    (ok true)))

;; Claim: after Jing settlement, send proceeds to owner (keeper gets fee)
;; Anyone can call - permissionless because it only benefits the owner
(define-public (claim)
  (let (
    (stx-bal (stx-get-balance current-contract))
    (sbtc-bal (unwrap-panic (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract)))
    (keeper (var-get active-keeper))
    (fee-bps (var-get active-keeper-fee-bps))
    (side (var-get active-side))
  )
    (asserts! (var-get active) ERR_NOT_ACTIVE)

    ;; If deposited STX, proceeds are sBTC. If deposited sBTC, proceeds are STX.
    ;; Keeper fee is on the proceeds side only.
    (if (is-eq side "stx")
      (let (
        ;; Proceeds are sBTC - keeper fee on sBTC
        (keeper-sbtc-fee (/ (* sbtc-bal fee-bps) BPS_PRECISION))
        (owner-sbtc (- sbtc-bal keeper-sbtc-fee))
      )
        (if (> keeper-sbtc-fee u0)
          (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" keeper-sbtc-fee))
            (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              transfer keeper-sbtc-fee current-contract keeper none))))
          true)
        (if (> owner-sbtc u0)
          (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" owner-sbtc))
            (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              transfer owner-sbtc current-contract OWNER none))))
          true)
        ;; Return any rolled STX to owner
        (if (> stx-bal u0)
          (try! (as-contract? ((with-stx stx-bal))
            (try! (stx-transfer? stx-bal current-contract OWNER))))
          true))
      (let (
        ;; Proceeds are STX - keeper fee on STX
        (keeper-stx-fee (/ (* stx-bal fee-bps) BPS_PRECISION))
        (owner-stx (- stx-bal keeper-stx-fee))
      )
        (if (> keeper-stx-fee u0)
          (try! (as-contract? ((with-stx keeper-stx-fee))
            (try! (stx-transfer? keeper-stx-fee current-contract keeper))))
          true)
        (if (> owner-stx u0)
          (try! (as-contract? ((with-stx owner-stx))
            (try! (stx-transfer? owner-stx current-contract OWNER))))
          true)
        ;; Return any rolled sBTC to owner
        (if (> sbtc-bal u0)
          (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-bal))
            (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              transfer sbtc-bal current-contract OWNER none))))
          true)))

    ;; Reset state
    (var-set active false)
    (var-set active-side "")
    (var-set active-amount u0)
    (var-set active-keeper-fee-bps u0)

    (print { event: "claim", owner: OWNER, keeper: keeper, fee-bps: fee-bps })
    (ok true)))

;; ---------------------------------------------------------------
;; Internal helpers
;; ---------------------------------------------------------------

(define-private (check-condition (oracle-price uint) (target uint) (cond (string-ascii 2)))
  (if (is-eq cond "le")
    (<= oracle-price target)
    (if (is-eq cond "ge")
      (>= oracle-price target)
      false)))
