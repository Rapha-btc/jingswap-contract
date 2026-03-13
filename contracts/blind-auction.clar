;; title: blind-auction
;; version: 0.3.0
;; summary: Blind batch auction for sBTC/STX swaps at synthetic oracle price
;; description: Deposits in epoch N settle at the Pyth spot price read at
;;   settlement time (after epoch N+1 ends). No one knows their fill price at
;;   deposit time - zero MEV, zero slippage, pro-rata partial fills every 5 min.
;;   Three safety gates: staleness, confidence, DEX sanity check.
;;   settle reads stored Pyth prices (free). settle-with-refresh pushes fresh
;;   VAAs if stored prices are stale (~2 uSTX fee).

;; ============================================================================
;; Traits (for Pyth refresh path)
;; ============================================================================

(use-trait pyth-storage-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.storage-trait)
(use-trait pyth-decoder-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-traits-v2.core-trait)

;; ============================================================================
;; Constants
;; ============================================================================

;; Epoch length in seconds (5 minutes)
(define-constant EPOCH_LENGTH u300)

;; Fee in basis points (10 = 0.10%), taken from BOTH sides
(define-constant FEE_BPS u10)
(define-constant BPS_PRECISION u10000)

;; Precision for price math (8 decimals, matches Pyth expo)
(define-constant PRICE_PRECISION u100000000)

;; Pyth price feed IDs
;; Source: https://pyth.network/developers/price-feed-ids#stacks-mainnet
(define-constant BTC_USD_FEED 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43)
(define-constant STX_USD_FEED 0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17)

;; Maximum staleness for Pyth price (60 seconds)
(define-constant MAX_STALENESS u60)

;; Confidence gate: conf must be < 2% of price (1/50)
(define-constant MAX_CONF_RATIO u50)

;; DEX sanity gate: oracle vs pool must be within 10% (1/10)
(define-constant MAX_DEX_DEVIATION u10)

;; Minimum deposit amounts (prevent dust)
(define-constant MIN_STX_DEPOSIT u1000000)   ;; 1 STX
(define-constant MIN_SBTC_DEPOSIT u1000)     ;; 0.00001 sBTC

;; Errors
(define-constant ERR_DEPOSIT_TOO_SMALL (err u1001))
(define-constant ERR_EPOCH_NOT_FINAL (err u1002))
(define-constant ERR_ALREADY_SETTLED (err u1003))
(define-constant ERR_STALE_PRICE (err u1004))
(define-constant ERR_PRICE_UNCERTAIN (err u1005))
(define-constant ERR_PRICE_DEX_DIVERGENCE (err u1006))
(define-constant ERR_NOTHING_TO_CLAIM (err u1007))
(define-constant ERR_NOTHING_TO_WITHDRAW (err u1008))
(define-constant ERR_EPOCH_LOCKED (err u1009))
(define-constant ERR_ZERO_PRICE (err u1010))
(define-constant ERR_PAUSED (err u1011))
(define-constant ERR_NOT_AUTHORIZED (err u1012))
(define-constant ERR_NOTHING_TO_SETTLE (err u1013))

;; DEX source options
(define-constant DEX_SOURCE_XYK u1)
(define-constant DEX_SOURCE_DLMM u2)

;; ============================================================================
;; Data vars
;; ============================================================================

(define-data-var treasury principal tx-sender)
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)

;; Admin-switchable DEX source for sanity check
;; u1 = BitFlow XYK pool (deeper liquidity, default)
;; u2 = BitFlow DLMM pool (concentrated, tighter spread)
(define-data-var dex-source uint DEX_SOURCE_XYK)

;; ============================================================================
;; Data maps
;; ============================================================================

;; Individual deposits per epoch per user
(define-map stx-deposits
  { epoch: uint, depositor: principal }
  uint)

(define-map sbtc-deposits
  { epoch: uint, depositor: principal }
  uint)

;; Aggregate totals per epoch
(define-map epoch-totals
  uint
  { total-stx: uint, total-sbtc: uint })

;; Settlement records
(define-map settlements
  uint
  { price: uint,               ;; settlement price in PRICE_PRECISION (STX per sBTC)
    stx-cleared: uint,
    sbtc-cleared: uint,
    stx-fee: uint,
    sbtc-fee: uint,
    settled-at: uint })

;; ============================================================================
;; Read-only helpers
;; ============================================================================

(define-read-only (get-current-epoch)
  (/ stacks-block-time EPOCH_LENGTH))

(define-read-only (get-epoch-start-time (epoch uint))
  (* epoch EPOCH_LENGTH))

(define-read-only (get-epoch-end-time (epoch uint))
  (* (+ epoch u1) EPOCH_LENGTH))

(define-read-only (get-epoch-totals (epoch uint))
  (default-to { total-stx: u0, total-sbtc: u0 }
    (map-get? epoch-totals epoch)))

(define-read-only (get-settlement (epoch uint))
  (map-get? settlements epoch))

(define-read-only (get-stx-deposit (epoch uint) (depositor principal))
  (default-to u0 (map-get? stx-deposits { epoch: epoch, depositor: depositor })))

(define-read-only (get-sbtc-deposit (epoch uint) (depositor principal))
  (default-to u0 (map-get? sbtc-deposits { epoch: epoch, depositor: depositor })))

(define-read-only (get-dex-source)
  (var-get dex-source))

;; ============================================================================
;; Public: Deposits
;; ============================================================================

(define-public (deposit-stx (amount uint))
  (let (
    (current-epoch (get-current-epoch))
    (settle-epoch (+ current-epoch u1))
    (existing (get-stx-deposit settle-epoch tx-sender))
    (totals (get-epoch-totals settle-epoch))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (>= amount MIN_STX_DEPOSIT) ERR_DEPOSIT_TOO_SMALL)

    (try! (stx-transfer? amount tx-sender current-contract))

    (map-set stx-deposits
      { epoch: settle-epoch, depositor: tx-sender }
      (+ existing amount))
    (map-set epoch-totals settle-epoch
      (merge totals { total-stx: (+ (get total-stx totals) amount) }))

    (print {
      event: "deposit-stx",
      depositor: tx-sender,
      amount: amount,
      settle-epoch: settle-epoch,
      timestamp: stacks-block-time
    })
    (ok settle-epoch)))

(define-public (deposit-sbtc (amount uint))
  (let (
    (current-epoch (get-current-epoch))
    (settle-epoch (+ current-epoch u1))
    (existing (get-sbtc-deposit settle-epoch tx-sender))
    (totals (get-epoch-totals settle-epoch))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (>= amount MIN_SBTC_DEPOSIT) ERR_DEPOSIT_TOO_SMALL)

    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender current-contract none))

    (map-set sbtc-deposits
      { epoch: settle-epoch, depositor: tx-sender }
      (+ existing amount))
    (map-set epoch-totals settle-epoch
      (merge totals { total-sbtc: (+ (get total-sbtc totals) amount) }))

    (print {
      event: "deposit-sbtc",
      depositor: tx-sender,
      amount: amount,
      settle-epoch: settle-epoch,
      timestamp: stacks-block-time
    })
    (ok settle-epoch)))

;; Cancel - only during the SAME epoch you deposited
(define-public (cancel-stx-deposit (settle-epoch uint))
  (let (
    (current-epoch (get-current-epoch))
    (deposit-epoch (- settle-epoch u1))
    (caller tx-sender)
    (amount (get-stx-deposit settle-epoch caller))
    (totals (get-epoch-totals settle-epoch))
  )
    (asserts! (is-eq current-epoch deposit-epoch) ERR_EPOCH_LOCKED)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (stx-transfer? amount current-contract caller))

    (map-delete stx-deposits { epoch: settle-epoch, depositor: caller })
    (map-set epoch-totals settle-epoch
      (merge totals { total-stx: (- (get total-stx totals) amount) }))

    (print { event: "cancel-stx", depositor: caller, amount: amount, settle-epoch: settle-epoch })
    (ok amount)))

(define-public (cancel-sbtc-deposit (settle-epoch uint))
  (let (
    (current-epoch (get-current-epoch))
    (deposit-epoch (- settle-epoch u1))
    (caller tx-sender)
    (amount (get-sbtc-deposit settle-epoch caller))
    (totals (get-epoch-totals settle-epoch))
  )
    (asserts! (is-eq current-epoch deposit-epoch) ERR_EPOCH_LOCKED)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount current-contract caller none))

    (map-delete sbtc-deposits { epoch: settle-epoch, depositor: caller })
    (map-set epoch-totals settle-epoch
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))

    (print { event: "cancel-sbtc", depositor: caller, amount: amount, settle-epoch: settle-epoch })
    (ok amount)))

;; ============================================================================
;; Public: Settlement
;; ============================================================================

;; Settle epoch N. Can only be called after epoch N+1 ends.
;; Settle using stored Pyth prices (free, no VAA needed).
;; Bot should try this first. If ERR_STALE_PRICE, use settle-with-refresh.
;; Anyone can trigger - permissionless.
(define-public (settle (epoch uint))
  (let (
    ;; Read latest Pyth prices from storage (free read-only)
    (btc-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price BTC_USD_FEED) ERR_ZERO_PRICE))
    (stx-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price STX_USD_FEED) ERR_ZERO_PRICE))
  )
    (execute-settlement epoch btc-feed stx-feed)))

;; Settle with fresh Pyth VAAs when stored prices are stale.
;; Costs ~2 uSTX (Pyth update fee per feed).
;; Anyone can trigger - permissionless.
(define-public (settle-with-refresh
  (epoch uint)
  (btc-vaa (buff 8192))
  (stx-vaa (buff 8192))
  (pyth-storage <pyth-storage-trait>)
  (pyth-decoder <pyth-decoder-trait>)
  (wormhole-core <wormhole-core-trait>))
  (begin
    ;; Refresh BTC/USD price via Pyth (~1 uSTX fee)
    (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds btc-vaa
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core }))
    ;; Refresh STX/USD price via Pyth (~1 uSTX fee)
    (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds stx-vaa
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core }))
    ;; Now read freshly updated prices and settle
    (let (
      (btc-feed (unwrap! (contract-call?
        'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
        get-price BTC_USD_FEED) ERR_ZERO_PRICE))
      (stx-feed (unwrap! (contract-call?
        'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
        get-price STX_USD_FEED) ERR_ZERO_PRICE))
    )
      (execute-settlement epoch btc-feed stx-feed))))

;; Shared settlement logic - validates gates and executes pro-rata fill
(define-private (execute-settlement
  (epoch uint)
  (btc-feed { price: int, conf: uint, expo: int, ema-price: int,
              ema-conf: uint, publish-time: uint, prev-publish-time: uint })
  (stx-feed { price: int, conf: uint, expo: int, ema-price: int,
              ema-conf: uint, publish-time: uint, prev-publish-time: uint }))
  (let (
    (price-epoch (+ epoch u1))
    (current-epoch (get-current-epoch))
    (totals (get-epoch-totals epoch))
    (total-stx (get total-stx totals))
    (total-sbtc (get total-sbtc totals))

    ;; Extract values (both feeds share expo -8)
    (btc-price (to-uint (get price btc-feed)))
    (stx-price (to-uint (get price stx-feed)))
    (btc-conf (get conf btc-feed))
    (stx-conf (get conf stx-feed))
    (btc-publish-time (get publish-time btc-feed))
    (stx-publish-time (get publish-time stx-feed))

    ;; Oracle price: STX per sBTC
    (oracle-price (/ (* btc-price PRICE_PRECISION) stx-price))

    ;; DEX price from BitFlow pool (admin-switchable source)
    (dex-price (get-dex-price))

    ;; Deviation: |oracle - dex|
    (price-diff (if (> oracle-price dex-price)
      (- oracle-price dex-price)
      (- dex-price oracle-price)))
    (max-allowed-diff (/ oracle-price MAX_DEX_DEVIATION))

    ;; sBTC bucket value in STX terms
    (stx-value-of-sbtc (/ (* total-sbtc oracle-price) PRICE_PRECISION))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (> current-epoch price-epoch) ERR_EPOCH_NOT_FINAL)
    (asserts! (is-none (map-get? settlements epoch)) ERR_ALREADY_SETTLED)
    (asserts! (or (> total-stx u0) (> total-sbtc u0)) ERR_NOTHING_TO_SETTLE)
    (asserts! (> btc-price u0) ERR_ZERO_PRICE)
    (asserts! (> stx-price u0) ERR_ZERO_PRICE)

    ;; Gate 1: Staleness - prices must be < 60s old
    (asserts! (> btc-publish-time (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
    (asserts! (> stx-publish-time (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)

    ;; Gate 2: Confidence - sources must agree within 2%
    (asserts! (< btc-conf (/ btc-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
    (asserts! (< stx-conf (/ stx-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)

    ;; Gate 3: DEX sanity - oracle vs pool within 10%
    (asserts! (< price-diff max-allowed-diff) ERR_PRICE_DEX_DIVERGENCE)

    ;; Determine which side is binding and settle
    (if (<= stx-value-of-sbtc total-stx)
      (settle-sbtc-bound epoch oracle-price total-stx total-sbtc stx-value-of-sbtc)
      (settle-stx-bound epoch oracle-price total-stx total-sbtc))))

;; Read DEX price based on admin-configured source
(define-read-only (get-dex-price)
  (if (is-eq (var-get dex-source) DEX_SOURCE_XYK)
    (get-xyk-price)
    (get-dlmm-price)))

;; BitFlow XYK pool: price = stx-reserve / sbtc-reserve
(define-read-only (get-xyk-price)
  (let (
    (pool (unwrap-panic (contract-call?
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
      get-pool)))
    ;; x = sBTC (8 decimals), y = STX (6 decimals)
    ;; price = y-balance * 10^2 * PRICE_PRECISION / x-balance
    ;; (10^2 adjusts for 8-6=2 decimal difference)
    (x-bal (get x-balance pool))
    (y-bal (get y-balance pool))
  )
    (/ (* y-bal u100 PRICE_PRECISION) x-bal)))

;; BitFlow DLMM pool: read active bin price from core
(define-read-only (get-dlmm-price)
  (let (
    (pool (unwrap-panic (contract-call?
      'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15
      get-pool)))
    (active-bin-id (get active-bin-id pool))
    (bin-step (get bin-step pool))
    (initial-price (get initial-price pool))
    (bin-price (unwrap-panic (contract-call?
      'SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1
      get-bin-price initial-price bin-step active-bin-id)))
  )
    ;; bin-price is in PRICE_SCALE_BPS (10^8), same as our PRICE_PRECISION
    bin-price))

;; sBTC bucket is smaller - all sBTC depositors fully filled
(define-private (settle-sbtc-bound
  (epoch uint) (price uint)
  (total-stx uint) (total-sbtc uint)
  (stx-clearing uint))
  (let (
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-clearing total-sbtc)
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (stx-unfilled (- total-stx stx-clearing))
  )
    (map-set settlements epoch
      { price: price,
        stx-cleared: stx-clearing,
        sbtc-cleared: sbtc-clearing,
        stx-fee: stx-fee,
        sbtc-fee: sbtc-fee,
        settled-at: stacks-block-time })

    (if (> stx-fee u0)
      (try! (stx-transfer? stx-fee current-contract (var-get treasury)))
      true)
    (if (> sbtc-fee u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer sbtc-fee current-contract (var-get treasury) none))
      true)

    (print {
      event: "settlement",
      epoch: epoch,
      price: price,
      stx-cleared: stx-clearing,
      sbtc-cleared: sbtc-clearing,
      stx-unfilled: stx-unfilled,
      sbtc-unfilled: u0,
      stx-fee: stx-fee,
      sbtc-fee: sbtc-fee,
      binding-side: "sbtc"
    })
    (ok { price: price, stx-cleared: stx-clearing, sbtc-cleared: sbtc-clearing,
          stx-fee: stx-fee, sbtc-fee: sbtc-fee })))

;; STX bucket is smaller - all STX depositors fully filled
(define-private (settle-stx-bound
  (epoch uint) (price uint)
  (total-stx uint) (total-sbtc uint))
  (let (
    (stx-clearing total-stx)
    (sbtc-clearing (/ (* total-stx PRICE_PRECISION) price))
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-unfilled (- total-sbtc sbtc-clearing))
  )
    (map-set settlements epoch
      { price: price,
        stx-cleared: stx-clearing,
        sbtc-cleared: sbtc-clearing,
        stx-fee: stx-fee,
        sbtc-fee: sbtc-fee,
        settled-at: stacks-block-time })

    (if (> stx-fee u0)
      (try! (stx-transfer? stx-fee current-contract (var-get treasury)))
      true)
    (if (> sbtc-fee u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer sbtc-fee current-contract (var-get treasury) none))
      true)

    (print {
      event: "settlement",
      epoch: epoch,
      price: price,
      stx-cleared: stx-clearing,
      sbtc-cleared: sbtc-clearing,
      stx-unfilled: u0,
      sbtc-unfilled: sbtc-unfilled,
      stx-fee: stx-fee,
      sbtc-fee: sbtc-fee,
      binding-side: "stx"
    })
    (ok { price: price, stx-cleared: stx-clearing, sbtc-cleared: sbtc-clearing,
          stx-fee: stx-fee, sbtc-fee: sbtc-fee })))

;; ============================================================================
;; Public: Claims
;; ============================================================================

;; STX depositors claim sBTC. Unfilled STX returned.
(define-public (claim-as-stx-depositor (epoch uint))
  (let (
    (settlement (unwrap! (map-get? settlements epoch) ERR_EPOCH_NOT_FINAL))
    (caller tx-sender)
    (my-deposit (get-stx-deposit epoch caller))
    (totals (get-epoch-totals epoch))
    (total-stx (get total-stx totals))
    (stx-cleared (get stx-cleared settlement))
    (sbtc-cleared (get sbtc-cleared settlement))
    (sbtc-fee (get sbtc-fee settlement))
    (my-stx-filled (/ (* my-deposit stx-cleared) total-stx))
    (sbtc-after-fee (- sbtc-cleared sbtc-fee))
    (my-sbtc-received (/ (* my-stx-filled sbtc-after-fee) stx-cleared))
    (my-stx-unfilled (- my-deposit my-stx-filled))
  )
    (asserts! (> my-deposit u0) ERR_NOTHING_TO_CLAIM)

    (map-delete stx-deposits { epoch: epoch, depositor: caller })

    (if (> my-sbtc-received u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer my-sbtc-received current-contract caller none))
      true)
    (if (> my-stx-unfilled u0)
      (try! (stx-transfer? my-stx-unfilled current-contract caller))
      true)

    (print {
      event: "claim-stx-depositor",
      depositor: caller,
      epoch: epoch,
      sbtc-received: my-sbtc-received,
      stx-refunded: my-stx-unfilled
    })
    (ok { sbtc-received: my-sbtc-received, stx-refunded: my-stx-unfilled })))

;; sBTC depositors claim STX. Unfilled sBTC returned.
(define-public (claim-as-sbtc-depositor (epoch uint))
  (let (
    (settlement (unwrap! (map-get? settlements epoch) ERR_EPOCH_NOT_FINAL))
    (caller tx-sender)
    (my-deposit (get-sbtc-deposit epoch caller))
    (totals (get-epoch-totals epoch))
    (total-sbtc (get total-sbtc totals))
    (stx-cleared (get stx-cleared settlement))
    (sbtc-cleared (get sbtc-cleared settlement))
    (stx-fee (get stx-fee settlement))
    (my-sbtc-filled (/ (* my-deposit sbtc-cleared) total-sbtc))
    (stx-after-fee (- stx-cleared stx-fee))
    (my-stx-received (/ (* my-sbtc-filled stx-after-fee) sbtc-cleared))
    (my-sbtc-unfilled (- my-deposit my-sbtc-filled))
  )
    (asserts! (> my-deposit u0) ERR_NOTHING_TO_CLAIM)

    (map-delete sbtc-deposits { epoch: epoch, depositor: caller })

    (if (> my-stx-received u0)
      (try! (stx-transfer? my-stx-received current-contract caller))
      true)
    (if (> my-sbtc-unfilled u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer my-sbtc-unfilled current-contract caller none))
      true)

    (print {
      event: "claim-sbtc-depositor",
      depositor: caller,
      epoch: epoch,
      stx-received: my-stx-received,
      sbtc-refunded: my-sbtc-unfilled
    })
    (ok { stx-received: my-stx-received, sbtc-refunded: my-sbtc-unfilled })))

;; ============================================================================
;; Admin
;; ============================================================================

(define-public (set-treasury (new-treasury principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set treasury new-treasury))))

(define-public (set-paused (is-paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set paused is-paused))))

(define-public (set-contract-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set contract-owner new-owner))))

;; Switch DEX source for sanity check
;; u1 = XYK pool (default, deeper liquidity)
;; u2 = DLMM pool (concentrated, tighter spread)
(define-public (set-dex-source (source uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (or (is-eq source DEX_SOURCE_XYK) (is-eq source DEX_SOURCE_DLMM)) ERR_NOT_AUTHORIZED)
    (ok (var-set dex-source source))))
