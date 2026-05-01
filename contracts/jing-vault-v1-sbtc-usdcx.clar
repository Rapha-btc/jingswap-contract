;; jing-vault-v1
;; Personal vault for conditional execution into the sBTC/STX Jing market
;; (.token-x-token-y-jing-v3-stx-special-sbtc) with a Bitflow xyk fallback path.
;; Each user deploys their own instance.
;;
;; - Owner: deposits/withdraws funds, signs SIP-018 intents off-chain.
;; - Keeper: submits signed intents (jing-deposit, bitflow-swap) and
;;           triggers unsigned cancels / revocations on the owner's behalf.
;; - Funds never leave owner's control except into the registered market
;;   (.token-x-token-y-jing-v3-stx-special-sbtc), into Bitflow's xyk-core-v-1-2
;;   sBTC/STX pool (pinned principals), or back to OWNER.
;;
;; All assets and venues are pinned at compile time. There are no trait
;; or principal arguments accepted from the keeper -- substitution
;; vector closed by construction.
;;
;; STX handling
;; ------------
;; The vault holds native STX throughout. WSTX_TOKEN
;; ('SM179...token-stx-v-1-2) is just a SIP-010 facade -- its `transfer`
;; is `stx-transfer?`, its `get-balance` is `stx-get-balance`, no
;; minted FT supply. So when v3-stx-sbtc / DLMM / xyk call
;; `t.transfer(...)` with `t = WSTX_TOKEN`, native STX moves directly.
;; The vault never calls deposit-stx/withdraw-stx on the wrapper.
;; Every STX-side egress just needs `with-stx amount` on the as-contract
;; clause; no `with-ft` ever applies on the STX leg.
;;
;; Equity ledger: vault and market both denominate STX-side equity in
;; WSTX_TOKEN (the wstx wrapper principal). Single bucket end-to-end:
;; vault credits on deposit-stx, market's distribute path debits on
;; settle (unconditional), refunds skip via debit-if-not-registered, and
;; vault debits on withdraw-stx. STX-side and sBTC-side are both exact.
;; Native STX is the user-facing form only -- at the deposit/withdraw
;; boundary -- and never appears as a ledger label.

;; ---------------------------------------------------------------
;; Constants
;; ---------------------------------------------------------------

(define-constant OWNER tx-sender)

;; Precision: Pyth is 8-dec, so limit-price is STX/sBTC * 1e8.
(define-constant PRICE_PRECISION u100000000)
;; sBTC is 8-dec (sats), STX/wstx is 6-dec (ustx). Conversion factor = 1e2.
(define-constant DECIMAL_FACTOR u100)

;; Token principals. The STX side is denominated in wstx everywhere on
;; the ledger (matches what the market emits) -- single bucket, no
;; parallel STX/wstx tracking. Native STX is just the user-facing form
;; at the deposit/withdraw boundary; internally and in events, it's wstx.
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant WSTX_TOKEN 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2)

;; Bitflow xyk pool used by execute-bitflow-swap. Pool layout: x=sBTC,
;; y=wstx (handled with native STX via xyk-core's wrapping).
(define-constant XYK_CORE 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2)
(define-constant XYK_POOL_SBTC_STX 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1)

;; Asset names: doubly used as (a) the SIP-010 ft identifier in `with-ft`
;; and (b) the side label embedded in the SIP-018 message hash. Renaming
;; changes every prior intent's hash, so these ARE part of the
;; signed-intent wire format.
(define-constant ASSET_WSTX "wstx")
(define-constant ASSET_SBTC "sbtc-token")

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
    stx-balance: (stx-get-balance current-contract),
    sbtc-balance: (unwrap-panic (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
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

(define-public (deposit-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (stx-transfer? amount tx-sender current-contract))
    (try! (contract-call? .jing-core log-deposit WSTX_TOKEN amount))
    (ok true)))

(define-public (deposit-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (contract-call? SBTC_TOKEN
      transfer amount tx-sender current-contract none))
    (try! (contract-call? .jing-core log-deposit SBTC_TOKEN amount))
    (ok true)))

(define-public (withdraw-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) ERR_NOT_OWNER)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract OWNER))))
    (try! (contract-call? .jing-core log-withdraw WSTX_TOKEN amount))
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
;; cancel-jing-stx unwraps the wstx refund back to native STX.

(define-public (cancel-jing-stx)
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (try! (as-contract? ((with-all-assets-unsafe))
      (try! (contract-call? .token-x-token-y-jing-v3-stx-special-sbtc
              cancel-token-y-deposit WSTX_TOKEN ASSET_WSTX))))
    (try! (contract-call? .jing-core log-cancel
      .token-x-token-y-jing-v3-stx-special-sbtc WSTX_TOKEN))
    (ok true)))

(define-public (cancel-jing-sbtc)
  (begin
    (asserts! (or (is-eq tx-sender OWNER)
                  (is-eq (some tx-sender) (var-get keeper)))
              ERR_NOT_OWNER)
    (try! (as-contract? ((with-all-assets-unsafe))
      (try! (contract-call? .token-x-token-y-jing-v3-stx-special-sbtc
              cancel-token-x-deposit SBTC_TOKEN ASSET_SBTC))))
    (try! (contract-call? .jing-core log-cancel
      .token-x-token-y-jing-v3-stx-special-sbtc SBTC_TOKEN))
    (ok true)))

;; ---------------------------------------------------------------
;; Signed intents
;; ---------------------------------------------------------------

;; Execute a signed Jing deposit intent. STX side wraps native STX to
;; wstx via token-stx-v-1-2 before depositing into the market.
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
    (if (is-eq side ASSET_WSTX)
      (try! (as-contract? ((with-stx amount))
        (try! (contract-call? .token-x-token-y-jing-v3-stx-special-sbtc
          deposit-token-y amount limit-price WSTX_TOKEN ASSET_WSTX))))
      (if (is-eq side ASSET_SBTC)
        (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
          (try! (contract-call? .token-x-token-y-jing-v3-stx-special-sbtc
            deposit-token-x amount limit-price SBTC_TOKEN ASSET_SBTC))))
        (asserts! false ERR_INVALID_SIDE)))
    (try! (contract-call? .jing-core log-jing-deposit
      msg-hash
      .token-x-token-y-jing-v3-stx-special-sbtc
      (if (is-eq side ASSET_WSTX) WSTX_TOKEN SBTC_TOKEN)
      (if (is-eq side ASSET_WSTX) SBTC_TOKEN WSTX_TOKEN)
      amount limit-price))
    (ok msg-hash)))

;; Execute a signed Bitflow swap intent on the sBTC/STX xyk pool.
;; min-out is derived on-chain from (amount, limit-price). All Bitflow
;; principals are pinned constants. xyk-core handles the wstx wrap
;; internally on the STX leg, so the vault sends/receives native STX
;; here -- no transient wrap.
(define-public (execute-bitflow-swap
    (sig (buff 65))
    (side (string-ascii 128))
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
    (asserts! (or (is-eq side ASSET_WSTX) (is-eq side ASSET_SBTC)) ERR_INVALID_SIDE)
    (try! (verify-and-consume msg-hash sig expiry))
    ;; side=wstx: spending STX (y), receiving sBTC (x) -> swap-y-for-x. Returns dx (uint).
    ;; side=sbtc: spending sBTC (x), receiving STX (y) -> swap-x-for-y. Returns dy (uint).
    (let ((out (if (is-eq side ASSET_WSTX)
                   (try! (as-contract? ((with-stx amount))
                     (try! (contract-call? XYK_CORE
                       swap-y-for-x XYK_POOL_SBTC_STX SBTC_TOKEN WSTX_TOKEN
                       amount min-out))))
                   (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
                     (try! (contract-call? XYK_CORE
                       swap-x-for-y XYK_POOL_SBTC_STX SBTC_TOKEN WSTX_TOKEN
                       amount min-out)))))))
      (try! (contract-call? .jing-core log-bitflow-swap
        msg-hash
        (if (is-eq side ASSET_WSTX) WSTX_TOKEN SBTC_TOKEN)
        (if (is-eq side ASSET_WSTX) SBTC_TOKEN WSTX_TOKEN)
        amount limit-price out))
      (ok msg-hash))))

;; Execute a signed DLMM swap intent on Bitflow's
;; dlmm-pool-stx-sbtc-v-1-bps-15 (pool layout: x=wstx, y=sBTC).
;; Routes through Bitflow's dlmm-swap-router-v-1-1 which traverses up
;; to MAX_STEPS bins automatically and enforces min-received (= our
;; min-out) internally -- no bin-id arg, no post-trade assert needed.
;; SIP-018 action is "dlmm-swap" so the message hash is distinct from
;; bitflow-swap.
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
    (asserts! (or (is-eq side ASSET_WSTX) (is-eq side ASSET_SBTC)) ERR_INVALID_SIDE)
    (try! (verify-and-consume msg-hash sig expiry))
    ;; side=wstx: spending wstx (x), want sBTC (y) -> swap-x-for-y-simple-multi
    ;; side=sbtc-token: spending sBTC (y), want wstx (x) -> swap-y-for-x-simple-multi
    ;; Router returns (ok {in: uint, out: uint}); we credit equity by the
    ;; exact `out`, matching what actually landed in the vault.
    (let ((result (if (is-eq side ASSET_WSTX)
                      (try! (as-contract? ((with-stx amount))
                        (try! (contract-call?
                          'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1
                          swap-x-for-y-simple-multi
                          'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15
                          WSTX_TOKEN SBTC_TOKEN amount min-out))))
                      (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
                        (try! (contract-call?
                          'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1
                          swap-y-for-x-simple-multi
                          'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15
                          WSTX_TOKEN SBTC_TOKEN amount min-out)))))))
      (try! (contract-call? .jing-core log-bitflow-swap
        msg-hash
        (if (is-eq side ASSET_WSTX) WSTX_TOKEN SBTC_TOKEN)
        (if (is-eq side ASSET_WSTX) SBTC_TOKEN WSTX_TOKEN)
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

;; Derive Bitflow min-out from (amount, limit-price).
;;
;; limit-price = STX_per_sBTC * 1e8 (PRICE_PRECISION)
;; sBTC is 8-dec (sats), STX/wstx is 6-dec (ustx), DECIMAL_FACTOR = 1e2.
;;
;; side="stx"  (spending A ustx, want >= M sats):
;;   M = A * (PRICE_PRECISION * DECIMAL_FACTOR) / limit-price
;; side="sbtc" (spending A sats, want >= M ustx):
;;   M = A * limit-price / (PRICE_PRECISION * DECIMAL_FACTOR)
(define-private (derive-min-out
    (side (string-ascii 128))
    (amount uint)
    (limit-price uint))
  (if (is-eq side ASSET_WSTX)
    (/ (* amount (* PRICE_PRECISION DECIMAL_FACTOR)) limit-price)
    (if (is-eq side ASSET_SBTC)
      (/ (* amount limit-price) (* PRICE_PRECISION DECIMAL_FACTOR))
      u0)))
