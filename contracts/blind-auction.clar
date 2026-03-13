;; title: blind-auction
;; version: 0.1.0
;; summary: Blind batch auction for sBTC/STX swaps at synthetic oracle price
;; description: Deposits in epoch N settle at the average Pyth price formed during
;;   epoch N+1. No one knows their fill price at deposit time - zero MEV, zero
;;   slippage, pro-rata partial fills every 5 minutes.

;; ============================================================================
;; Traits
;; ============================================================================

;; Pyth oracle traits for price verification
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

;; Precision for price math (8 decimals)
(define-constant PRICE_PRECISION u100000000)

;; sBTC contract
;; Pyth price feed IDs
;; Source: https://pyth.network/developers/price-feed-ids#stacks-mainnet
(define-constant BTC_USD_FEED 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43)
(define-constant STX_USD_FEED 0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17)

;; Minimum price samples required per epoch for settlement
(define-constant MIN_SAMPLES u3)

;; Maximum staleness for a Pyth price sample (60 seconds)
(define-constant MAX_STALENESS u60)

;; Minimum deposit amounts (prevent dust)
(define-constant MIN_STX_DEPOSIT u1000000)   ;; 1 STX
(define-constant MIN_SBTC_DEPOSIT u1000)     ;; 0.00001 sBTC

;; Errors
(define-constant ERR_DEPOSIT_TOO_SMALL (err u1001))
(define-constant ERR_EPOCH_NOT_FINAL (err u1002))
(define-constant ERR_ALREADY_SETTLED (err u1003))
(define-constant ERR_INSUFFICIENT_SAMPLES (err u1005))
(define-constant ERR_STALE_PRICE (err u1007))
(define-constant ERR_NOTHING_TO_CLAIM (err u1008))
(define-constant ERR_NOTHING_TO_WITHDRAW (err u1009))
(define-constant ERR_EPOCH_LOCKED (err u1010))
(define-constant ERR_ZERO_PRICE (err u1011))
(define-constant ERR_PAUSED (err u1012))
(define-constant ERR_NOT_AUTHORIZED (err u1013))
(define-constant ERR_WRONG_FEED_ID (err u1014))

;; ============================================================================
;; Data vars
;; ============================================================================

;; Treasury receives fees
(define-data-var treasury principal tx-sender)

;; Contract owner for emergency pause
(define-data-var contract-owner principal tx-sender)

;; Emergency pause flag
(define-data-var paused bool false)

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
  uint  ;; epoch that will be settled (deposits target this epoch)
  { total-stx: uint, total-sbtc: uint })

;; Price accumulation: samples collected DURING this epoch
;; Used to price the PREVIOUS epoch's deposits
(define-map epoch-prices
  uint  ;; epoch during which samples were collected
  { price-sum: uint, sample-count: uint })

;; Settlement records
(define-map settlements
  uint  ;; the epoch that was settled
  { twap: uint,              ;; price in PRICE_PRECISION (STX per sBTC)
    stx-cleared: uint,       ;; total STX matched
    sbtc-cleared: uint,      ;; total sBTC matched
    stx-fee-collected: uint, ;; fee taken from STX side
    sbtc-fee-collected: uint,;; fee taken from sBTC side
    settled-at: uint })      ;; stacks-block-time when settled

;; ============================================================================
;; Read-only: Epoch helpers
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

(define-read-only (get-epoch-prices (epoch uint))
  (default-to { price-sum: u0, sample-count: u0 }
    (map-get? epoch-prices epoch)))

(define-read-only (get-settlement (epoch uint))
  (map-get? settlements epoch))

(define-read-only (get-stx-deposit (epoch uint) (depositor principal))
  (default-to u0 (map-get? stx-deposits { epoch: epoch, depositor: depositor })))

(define-read-only (get-sbtc-deposit (epoch uint) (depositor principal))
  (default-to u0 (map-get? sbtc-deposits { epoch: epoch, depositor: depositor })))

;; ============================================================================
;; Public: Deposits
;; ============================================================================

;; Deposit STX to be swapped for sBTC at next epoch's price
(define-public (deposit-stx (amount uint))
  (let (
    (current-epoch (get-current-epoch))
    (settle-epoch (+ current-epoch u1))
    (existing (get-stx-deposit settle-epoch tx-sender))
    (totals (get-epoch-totals settle-epoch))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (>= amount MIN_STX_DEPOSIT) ERR_DEPOSIT_TOO_SMALL)

    ;; Transfer STX to contract
    (try! (stx-transfer? amount tx-sender current-contract))

    ;; Update user deposit
    (map-set stx-deposits
      { epoch: settle-epoch, depositor: tx-sender }
      (+ existing amount))

    ;; Update epoch totals
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

;; Deposit sBTC to be swapped for STX at next epoch's price
(define-public (deposit-sbtc (amount uint))
  (let (
    (current-epoch (get-current-epoch))
    (settle-epoch (+ current-epoch u1))
    (existing (get-sbtc-deposit settle-epoch tx-sender))
    (totals (get-epoch-totals settle-epoch))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (>= amount MIN_SBTC_DEPOSIT) ERR_DEPOSIT_TOO_SMALL)

    ;; Transfer sBTC to contract
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender current-contract none))

    ;; Update user deposit
    (map-set sbtc-deposits
      { epoch: settle-epoch, depositor: tx-sender }
      (+ existing amount))

    ;; Update epoch totals
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

;; Cancel deposit - only during the SAME epoch you deposited
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
;; Public: Price recording (Pyth oracle)
;; ============================================================================

;; Anyone can call this to record a Pyth price sample for the current epoch.
;; The price recorded during epoch N+1 is used to settle epoch N deposits.
;;
;; Caller fetches fresh VAAs from Pyth Hermes (https://hermes.pyth.network)
;; and submits them on-chain. We verify via Wormhole signatures and check
;; staleness against stacks-block-time (Clarity 4).
;;
;; Feed IDs from: https://pyth.network/developers/price-feed-ids#stacks-mainnet
(define-public (record-price-sample
  (btc-vaa (buff 8192))
  (stx-vaa (buff 8192))
  (pyth-storage <pyth-storage-trait>)
  (pyth-decoder <pyth-decoder-trait>)
  (wormhole-core <wormhole-core-trait>))
  (let (
    (current-epoch (get-current-epoch))
    (existing (get-epoch-prices current-epoch))
    ;; Verify and decode BTC/USD price via Pyth
    (btc-result (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds btc-vaa
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core })))
    (btc-entry (unwrap-panic (element-at? btc-result u0)))
    ;; Verify and decode STX/USD price via Pyth
    (stx-result (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds stx-vaa
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core })))
    (stx-entry (unwrap-panic (element-at? stx-result u0)))
    ;; Extract prices and timestamps
    (btc-price (to-uint (get price btc-entry)))
    (stx-price (to-uint (get price stx-entry)))
    (btc-publish-time (get publish-time btc-entry))
    (stx-publish-time (get publish-time stx-entry))
    ;; BTC/STX ratio = how many STX per 1 sBTC
    (ratio (/ (* btc-price PRICE_PRECISION) stx-price))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    ;; Verify correct feed IDs
    (asserts! (is-eq (get price-identifier btc-entry) BTC_USD_FEED) ERR_WRONG_FEED_ID)
    (asserts! (is-eq (get price-identifier stx-entry) STX_USD_FEED) ERR_WRONG_FEED_ID)
    ;; Staleness check: price must be < 60s old
    (asserts! (> btc-publish-time (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
    (asserts! (> stx-publish-time (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
    ;; Sanity check
    (asserts! (> btc-price u0) ERR_ZERO_PRICE)
    (asserts! (> stx-price u0) ERR_ZERO_PRICE)

    ;; Accumulate into epoch TWAP
    (map-set epoch-prices current-epoch
      { price-sum: (+ (get price-sum existing) ratio),
        sample-count: (+ (get sample-count existing) u1) })

    (print {
      event: "price-sample",
      epoch: current-epoch,
      btc-price: btc-price,
      stx-price: stx-price,
      ratio: ratio,
      btc-publish-time: btc-publish-time,
      stx-publish-time: stx-publish-time,
      sample-count: (+ (get sample-count existing) u1),
      timestamp: stacks-block-time
    })
    (ok ratio)))

;; ============================================================================
;; Public: Settlement
;; ============================================================================

;; Settle epoch N using the TWAP from epoch N+1.
;; Can only be called after epoch N+1 has fully ended.
;; Anyone can trigger - permissionless.
(define-public (settle (epoch uint))
  (let (
    (price-epoch (+ epoch u1))
    (current-epoch (get-current-epoch))
    (prices (get-epoch-prices price-epoch))
    (twap (/ (get price-sum prices) (get sample-count prices)))
    (totals (get-epoch-totals epoch))
    (total-stx (get total-stx totals))
    (total-sbtc (get total-sbtc totals))
    ;; How much STX is the sBTC bucket worth at TWAP?
    ;; twap = STX per sBTC (in PRICE_PRECISION)
    (stx-value-of-sbtc (/ (* total-sbtc twap) PRICE_PRECISION))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (> current-epoch price-epoch) ERR_EPOCH_NOT_FINAL)
    (asserts! (is-none (map-get? settlements epoch)) ERR_ALREADY_SETTLED)
    (asserts! (>= (get sample-count prices) MIN_SAMPLES) ERR_INSUFFICIENT_SAMPLES)
    (asserts! (> twap u0) ERR_ZERO_PRICE)

    ;; Determine which side is binding and settle
    (if (<= stx-value-of-sbtc total-stx)
      (settle-sbtc-bound epoch twap total-stx total-sbtc stx-value-of-sbtc)
      (settle-stx-bound epoch twap total-stx total-sbtc))))

;; sBTC bucket is smaller - all sBTC depositors fully filled
(define-private (settle-sbtc-bound
  (epoch uint) (twap uint)
  (total-stx uint) (total-sbtc uint)
  (stx-clearing uint))
  (let (
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-clearing total-sbtc)
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (stx-unfilled (- total-stx stx-clearing))
  )
    (map-set settlements epoch
      { twap: twap,
        stx-cleared: stx-clearing,
        sbtc-cleared: sbtc-clearing,
        stx-fee-collected: stx-fee,
        sbtc-fee-collected: sbtc-fee,
        settled-at: stacks-block-time })

    ;; Transfer fees to treasury
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
      twap: twap,
      stx-cleared: stx-clearing,
      sbtc-cleared: sbtc-clearing,
      stx-unfilled: stx-unfilled,
      sbtc-unfilled: u0,
      stx-fee: stx-fee,
      sbtc-fee: sbtc-fee,
      binding-side: "sbtc"
    })
    (ok { twap: twap, stx-cleared: stx-clearing, sbtc-cleared: sbtc-clearing,
          stx-fee: stx-fee, sbtc-fee: sbtc-fee })))

;; STX bucket is smaller - all STX depositors fully filled
(define-private (settle-stx-bound
  (epoch uint) (twap uint)
  (total-stx uint) (total-sbtc uint))
  (let (
    (stx-clearing total-stx)
    (sbtc-clearing (/ (* total-stx PRICE_PRECISION) twap))
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-unfilled (- total-sbtc sbtc-clearing))
  )
    (map-set settlements epoch
      { twap: twap,
        stx-cleared: stx-clearing,
        sbtc-cleared: sbtc-clearing,
        stx-fee-collected: stx-fee,
        sbtc-fee-collected: sbtc-fee,
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
      twap: twap,
      stx-cleared: stx-clearing,
      sbtc-cleared: sbtc-clearing,
      stx-unfilled: u0,
      sbtc-unfilled: sbtc-unfilled,
      stx-fee: stx-fee,
      sbtc-fee: sbtc-fee,
      binding-side: "stx"
    })
    (ok { twap: twap, stx-cleared: stx-clearing, sbtc-cleared: sbtc-clearing,
          stx-fee: stx-fee, sbtc-fee: sbtc-fee })))

;; ============================================================================
;; Public: Claims
;; ============================================================================

;; STX depositors claim sBTC (minus sBTC fee). Unfilled STX returned.
(define-public (claim-as-stx-depositor (epoch uint))
  (let (
    (settlement (unwrap! (map-get? settlements epoch) ERR_EPOCH_NOT_FINAL))
    (caller tx-sender)
    (my-deposit (get-stx-deposit epoch caller))
    (totals (get-epoch-totals epoch))
    (total-stx (get total-stx totals))
    (stx-cleared (get stx-cleared settlement))
    (sbtc-cleared (get sbtc-cleared settlement))
    (sbtc-fee (get sbtc-fee-collected settlement))
    (my-stx-filled (/ (* my-deposit stx-cleared) total-stx))
    (sbtc-after-fee (- sbtc-cleared sbtc-fee))
    (my-sbtc-received (/ (* my-stx-filled sbtc-after-fee) stx-cleared))
    (my-stx-unfilled (- my-deposit my-stx-filled))
  )
    (asserts! (> my-deposit u0) ERR_NOTHING_TO_CLAIM)

    ;; Clear deposit to prevent double-claim
    (map-delete stx-deposits { epoch: epoch, depositor: caller })

    ;; Transfer sBTC to depositor
    (if (> my-sbtc-received u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer my-sbtc-received current-contract caller none))
      true)

    ;; Refund unfilled STX
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

;; sBTC depositors claim STX (minus STX fee). Unfilled sBTC returned.
(define-public (claim-as-sbtc-depositor (epoch uint))
  (let (
    (settlement (unwrap! (map-get? settlements epoch) ERR_EPOCH_NOT_FINAL))
    (caller tx-sender)
    (my-deposit (get-sbtc-deposit epoch caller))
    (totals (get-epoch-totals epoch))
    (total-sbtc (get total-sbtc totals))
    (stx-cleared (get stx-cleared settlement))
    (sbtc-cleared (get sbtc-cleared settlement))
    (stx-fee (get stx-fee-collected settlement))
    ;; My pro-rata share of sBTC that was filled
    (my-sbtc-filled (/ (* my-deposit sbtc-cleared) total-sbtc))
    ;; My STX received (fee already deducted from pool)
    (stx-after-fee (- stx-cleared stx-fee))
    (my-stx-received (/ (* my-sbtc-filled stx-after-fee) sbtc-cleared))
    ;; My unfilled sBTC remainder
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
