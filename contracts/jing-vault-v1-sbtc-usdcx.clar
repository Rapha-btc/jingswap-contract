;; jing-vault-v1-sbtc-usdcx
;; Personal vault for conditional execution into the sBTC/USDCx Jing market
;; (JING-MARKET, x=sBTC, y=USDCx) with a Bitflow
;; DLMM fallback path. Each user deploys their own instance.
;;
;; - Owner: deposits/withdraws funds, signs SIP-018 intents off-chain.
;; - Keeper: submits signed intents (jing-deposit, dlmm-swap) and
;;           triggers unsigned cancels / revocations on the owner's behalf.
;; - Funds never leave owner's control except into the registered market
;;   (JING-MARKET), into Bitflow's
;;   dlmm-pool-sbtc-usdcx-v-1-bps-10 via dlmm-swap-router-v-1-1, or back
;;   to OWNER.
;;
;; All assets and venues are pinned at compile time. There are no trait
;; or principal arguments accepted from the keeper -- substitution
;; vector closed by construction.
;;
;; Both legs are real FTs (sBTC SIP-010 + USDCx SIP-010). No native-STX
;; mechanic anywhere; every transfer goes through `with-ft` clauses and
;; FT-trait `transfer` calls. Equity ledger is exact for both tokens.

;; ---------------------------------------------------------------
;; Constants
;; ---------------------------------------------------------------

(define-constant OWNER tx-sender)

;; Precision: Pyth is 8-dec, so limit-price is USDCx/sBTC * 1e8.
(define-constant PRICE_PRECISION u100000000)
;; sBTC is 8-dec, USDCx is 6-dec. DECIMAL_FACTOR = 1e8 / 1e6 = 100.
(define-constant DECIMAL_FACTOR u100)

;; Token principals.
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant USDCX_TOKEN 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx)

;; Jing market this vault is bound to (sBTC = token-x, USDCx = token-y).
(define-constant JING-MARKET .token-x-token-y-jing-v3)

;; Bitflow DLMM router + pool used by execute-dlmm-swap. Pool layout:
;; x=sBTC, y=USDCx (matches the v3 jing market's layout).
(define-constant DLMM_ROUTER 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1)
(define-constant DLMM_POOL_SBTC_USDCX 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10)

;; Asset names: doubly used as (a) the SIP-010 ft identifier in `with-ft`
;; and (b) the side label embedded in the SIP-018 message hash. Renaming
;; changes every prior intent's hash, so these ARE part of the
;; signed-intent wire format.
(define-constant ASSET_SBTC "sbtc-token")
(define-constant ASSET_USDCX "usdcx-token")

(define-constant ERR_NOT_OWNER (err u6001))
(define-constant ERR_INVALID_SIGNATURE (err u6002))
(define-constant ERR_REPLAY (err u6003))
(define-constant ERR_EXPIRED (err u6004))
(define-constant ERR_NO_FUNDS (err u6006))
(define-constant ERR_INVALID_SIDE (err u6011))
(define-constant ERR_INVALID_PRICE (err u6013))
(define-constant ERR_ALREADY_INITIALIZED (err u6020))

;; ---------------------------------------------------------------
;; State
;; ---------------------------------------------------------------

(define-data-var owner-pubkey (buff 33) 0x000000000000000000000000000000000000000000000000000000000000000000)

(define-data-var keeper (optional principal) none)

(define-map used-pubkey-authorizations (buff 32) (buff 33))

(define-data-var initialized bool false)

;; ---------------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------------

(define-read-only (get-owner) OWNER)

(define-read-only (get-status)
  {
    owner: OWNER,
    pubkey: (var-get owner-pubkey),
    keeper: (var-get keeper),
    sbtc-balance: (unwrap-panic (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract)),
    usdcx-balance: (unwrap-panic (contract-call?
      'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
      get-balance current-contract)),
  })

(define-read-only (is-signature-used (h (buff 32)))
  (is-some (map-get? used-pubkey-authorizations h)))

(define-read-only (is-initialized) (var-get initialized))

;; ---------------------------------------------------------------
;; Initialization
;; ---------------------------------------------------------------

(define-public (initialize (canonical principal))
  (begin
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)
    (var-set initialized true)
    (try! (contract-call? .jing-core register canonical))
    (ok true)))

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

(define-public (deposit-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (contract-call? SBTC_TOKEN
      transfer amount tx-sender current-contract none))
    (try! (contract-call? .jing-core log-deposit SBTC_TOKEN amount))
    (ok true)))

(define-public (deposit-usdcx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (contract-call? USDCX_TOKEN
      transfer amount tx-sender current-contract none))
    (try! (contract-call? .jing-core log-deposit USDCX_TOKEN amount))
    (ok true)))

(define-public (withdraw-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
      (try! (contract-call? SBTC_TOKEN
        transfer amount current-contract OWNER none))))
    (try! (contract-call? .jing-core log-withdraw SBTC_TOKEN amount))
    (ok true)))

(define-public (withdraw-usdcx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-ft USDCX_TOKEN ASSET_USDCX amount))
      (try! (contract-call? USDCX_TOKEN
        transfer amount current-contract OWNER none))))
    (try! (contract-call? .jing-core log-withdraw USDCX_TOKEN amount))
    (ok true)))

;; Burn a signed intent's message hash so it can never fire. Owner or
;; keeper.
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
;; Owner or keeper can cancel an in-flight deposit on the registered
;; market. Refund lands back in the vault and is freely eligible for
;; any pre-signed intent whose balance the vault can now satisfy.

(define-public (cancel-jing-sbtc)
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (try! (as-contract? ((with-all-assets-unsafe))
      (try! (contract-call? JING-MARKET
              cancel-token-x-deposit SBTC_TOKEN ASSET_SBTC))))
    (try! (contract-call? .jing-core log-cancel
      JING-MARKET SBTC_TOKEN))
    (ok true)))

(define-public (cancel-jing-usdcx)
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (try! (as-contract? ((with-all-assets-unsafe))
      (try! (contract-call? JING-MARKET
              cancel-token-y-deposit USDCX_TOKEN ASSET_USDCX))))
    (try! (contract-call? .jing-core log-cancel
      JING-MARKET USDCX_TOKEN))
    (ok true)))

;; ---------------------------------------------------------------
;; Signed intents
;; ---------------------------------------------------------------

(define-public (execute-jing-deposit
    (sig (buff 65))
    (side (string-ascii 128))
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
    (if (is-eq side ASSET_SBTC)
      (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
        (try! (contract-call? JING-MARKET
          deposit-token-x amount limit-price SBTC_TOKEN ASSET_SBTC))))
      (if (is-eq side ASSET_USDCX)
        (try! (as-contract? ((with-ft USDCX_TOKEN ASSET_USDCX amount))
          (try! (contract-call? JING-MARKET
            deposit-token-y amount limit-price USDCX_TOKEN ASSET_USDCX))))
        (asserts! false ERR_INVALID_SIDE)))
    (try! (contract-call? .jing-core log-jing-deposit
      msg-hash
      JING-MARKET
      (if (is-eq side ASSET_SBTC) SBTC_TOKEN USDCX_TOKEN)
      (if (is-eq side ASSET_SBTC) USDCX_TOKEN SBTC_TOKEN)
      amount limit-price))
    (ok msg-hash)))

;; Execute a signed DLMM swap intent on Bitflow's
;; dlmm-pool-sbtc-usdcx-v-1-bps-10 (pool layout: x=sBTC, y=USDCx).
;; Routes through Bitflow's dlmm-swap-router-v-1-1 which traverses up to
;; MAX_STEPS bins automatically and enforces min-received (= our
;; min-out) internally -- no bin-id arg, no post-trade assert needed.
;; SIP-018 action is "dlmm-swap" so the message hash is distinct from
;; jing-deposit.
(define-public (execute-dlmm-swap
    (sig (buff 65))
    (side (string-ascii 128))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint))
  (let (
    (msg-hash (contract-call? .jing-vault-auth build-intent-hash {
      action: "dlmm-swap",
      side: side,
      amount: amount,
      limit-price: limit-price,
      auth-id: auth-id,
      expiry: expiry,
    }))
    (min-out (derive-min-out side amount limit-price))
  )
    (asserts! (> limit-price u0) ERR_INVALID_PRICE)
    (asserts! (or (is-eq side ASSET_SBTC) (is-eq side ASSET_USDCX)) ERR_INVALID_SIDE)
    (try! (verify-and-consume msg-hash sig expiry))
    ;; side=sbtc-token: spending sBTC (x), want USDCx (y) -> swap-x-for-y-simple-multi
    ;; side=usdcx-token: spending USDCx (y), want sBTC (x) -> swap-y-for-x-simple-multi
    ;; Router returns (ok {in: uint, out: uint}); we credit equity by the
    ;; exact `out`, matching what actually landed in the vault.
    (let ((result (if (is-eq side ASSET_SBTC)
                      (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
                        (try! (contract-call?
                          DLMM_ROUTER
                          swap-x-for-y-simple-multi
                          DLMM_POOL_SBTC_USDCX
                          SBTC_TOKEN USDCX_TOKEN amount min-out))))
                      (try! (as-contract? ((with-ft USDCX_TOKEN ASSET_USDCX amount))
                        (try! (contract-call?
                          DLMM_ROUTER
                          swap-y-for-x-simple-multi
                          DLMM_POOL_SBTC_USDCX
                          SBTC_TOKEN USDCX_TOKEN amount min-out)))))))
      (try! (contract-call? .jing-core log-bitflow-swap
        msg-hash
        (if (is-eq side ASSET_SBTC) SBTC_TOKEN USDCX_TOKEN)
        (if (is-eq side ASSET_SBTC) USDCX_TOKEN SBTC_TOKEN)
        amount limit-price (get out result)))
      (ok msg-hash))))

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

;; Derive DLMM min-out from (amount, limit-price).
;;
;; limit-price = USDCx_per_sBTC * 1e8 (PRICE_PRECISION)
;; sBTC is 8-dec (sats), USDCx is 6-dec, DECIMAL_FACTOR = 1e2.
;;
;; side="sbtc-token"  (spending A sats, want >= M USDCx):
;;   M = A * limit-price / (PRICE_PRECISION * DECIMAL_FACTOR)
;; side="usdcx-token" (spending A USDCx, want >= M sats):
;;   M = A * (PRICE_PRECISION * DECIMAL_FACTOR) / limit-price
(define-private (derive-min-out
    (side (string-ascii 128))
    (amount uint)
    (limit-price uint))
  (if (is-eq side ASSET_SBTC)
    (/ (* amount limit-price) (* PRICE_PRECISION DECIMAL_FACTOR))
    (if (is-eq side ASSET_USDCX)
      (/ (* amount (* PRICE_PRECISION DECIMAL_FACTOR)) limit-price)
      u0)))
