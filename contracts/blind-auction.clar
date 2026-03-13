;; title: blind-auction
;; version: 0.4.0
;; summary: Blind batch auction for sBTC/STX swaps at synthetic oracle price
;; description:
;;   8-minute cycle: 5 min deposit, 1 min buffer, 2 min settle window.
;;   Deposits in cycle N settle during cycle N's settle window at Pyth spot price.
;;   Unfilled remainder auto-rolls into cycle N+1.
;;   Three safety gates: staleness, confidence, DEX sanity.

;; ============================================================================
;; Traits (for Pyth refresh path)
;; ============================================================================

(use-trait pyth-storage-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.storage-trait)
(use-trait pyth-decoder-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-traits-v2.core-trait)

;; ============================================================================
;; Constants
;; ============================================================================

;; Cycle timing (seconds)
(define-constant CYCLE_LENGTH u480)    ;; 8 minutes
(define-constant DEPOSIT_END u300)     ;; 0:00 - 5:00 deposit window
(define-constant SETTLE_START u360)    ;; 6:00 settle window opens (1 min buffer)
(define-constant SETTLE_END u480)      ;; 8:00 settle window closes

;; Phases
(define-constant PHASE_DEPOSIT u0)
(define-constant PHASE_BUFFER u1)
(define-constant PHASE_SETTLE u2)

;; Fee: 10 bps (0.10%) taken from BOTH sides
(define-constant FEE_BPS u10)
(define-constant BPS_PRECISION u10000)

;; Precision for price math (8 decimals, matches Pyth expo -8)
(define-constant PRICE_PRECISION u100000000)

;; Pyth price feed IDs
;; Source: https://pyth.network/developers/price-feed-ids#stacks-mainnet
(define-constant BTC_USD_FEED 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43)
(define-constant STX_USD_FEED 0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17)

;; Safety gates
(define-constant MAX_STALENESS u60)       ;; price must be < 60s old
(define-constant MAX_CONF_RATIO u50)      ;; conf < 2% of price (1/50)
(define-constant MAX_DEX_DEVIATION u10)   ;; oracle vs pool < 10% (1/10)

;; Minimum deposits (prevent dust)
(define-constant MIN_STX_DEPOSIT u1000000)   ;; 1 STX
(define-constant MIN_SBTC_DEPOSIT u1000)     ;; 0.00001 sBTC

;; DEX source options
(define-constant DEX_SOURCE_XYK u1)
(define-constant DEX_SOURCE_DLMM u2)

;; Errors
(define-constant ERR_DEPOSIT_TOO_SMALL (err u1001))
(define-constant ERR_NOT_DEPOSIT_PHASE (err u1002))
(define-constant ERR_NOT_SETTLE_PHASE (err u1003))
(define-constant ERR_ALREADY_SETTLED (err u1004))
(define-constant ERR_STALE_PRICE (err u1005))
(define-constant ERR_PRICE_UNCERTAIN (err u1006))
(define-constant ERR_PRICE_DEX_DIVERGENCE (err u1007))
(define-constant ERR_NOTHING_TO_CLAIM (err u1008))
(define-constant ERR_NOTHING_TO_WITHDRAW (err u1009))
(define-constant ERR_ZERO_PRICE (err u1010))
(define-constant ERR_PAUSED (err u1011))
(define-constant ERR_NOT_AUTHORIZED (err u1012))
(define-constant ERR_NOTHING_TO_SETTLE (err u1013))

;; ============================================================================
;; Data vars
;; ============================================================================

(define-data-var treasury principal tx-sender)
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var dex-source uint DEX_SOURCE_XYK)

;; ============================================================================
;; Data maps
;; ============================================================================

;; Individual deposits per cycle per user
(define-map stx-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map sbtc-deposits
  { cycle: uint, depositor: principal }
  uint)

;; Aggregate totals per cycle (includes auto-rolled amounts)
(define-map cycle-totals
  uint
  { total-stx: uint, total-sbtc: uint })

;; Settlement records
(define-map settlements
  uint
  { price: uint,
    stx-cleared: uint,
    sbtc-cleared: uint,
    stx-fee: uint,
    sbtc-fee: uint,
    settled-at: uint })

;; ============================================================================
;; Read-only: Cycle & phase helpers
;; ============================================================================

(define-read-only (get-current-cycle)
  (/ stacks-block-time CYCLE_LENGTH))

(define-read-only (get-cycle-phase)
  (let ((elapsed (mod stacks-block-time CYCLE_LENGTH)))
    (if (<= elapsed DEPOSIT_END) PHASE_DEPOSIT
      (if (< elapsed SETTLE_START) PHASE_BUFFER
        PHASE_SETTLE))))

(define-read-only (get-cycle-start-time (cycle uint))
  (* cycle CYCLE_LENGTH))

(define-read-only (get-cycle-totals (cycle uint))
  (default-to { total-stx: u0, total-sbtc: u0 }
    (map-get? cycle-totals cycle)))

(define-read-only (get-settlement (cycle uint))
  (map-get? settlements cycle))

(define-read-only (get-stx-deposit (cycle uint) (depositor principal))
  (default-to u0 (map-get? stx-deposits { cycle: cycle, depositor: depositor })))

(define-read-only (get-sbtc-deposit (cycle uint) (depositor principal))
  (default-to u0 (map-get? sbtc-deposits { cycle: cycle, depositor: depositor })))

(define-read-only (get-dex-source)
  (var-get dex-source))

;; ============================================================================
;; Public: Deposits (only during deposit phase)
;; ============================================================================

(define-public (deposit-stx (amount uint))
  (let (
    (current-cycle (get-current-cycle))
    (existing (get-stx-deposit current-cycle tx-sender))
    (totals (get-cycle-totals current-cycle))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount MIN_STX_DEPOSIT) ERR_DEPOSIT_TOO_SMALL)

    (try! (stx-transfer? amount tx-sender current-contract))

    (map-set stx-deposits
      { cycle: current-cycle, depositor: tx-sender }
      (+ existing amount))
    (map-set cycle-totals current-cycle
      (merge totals { total-stx: (+ (get total-stx totals) amount) }))

    (print {
      event: "deposit-stx",
      depositor: tx-sender,
      amount: amount,
      cycle: current-cycle,
      timestamp: stacks-block-time
    })
    (ok current-cycle)))

(define-public (deposit-sbtc (amount uint))
  (let (
    (current-cycle (get-current-cycle))
    (existing (get-sbtc-deposit current-cycle tx-sender))
    (totals (get-cycle-totals current-cycle))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount MIN_SBTC_DEPOSIT) ERR_DEPOSIT_TOO_SMALL)

    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender current-contract none))

    (map-set sbtc-deposits
      { cycle: current-cycle, depositor: tx-sender }
      (+ existing amount))
    (map-set cycle-totals current-cycle
      (merge totals { total-sbtc: (+ (get total-sbtc totals) amount) }))

    (print {
      event: "deposit-sbtc",
      depositor: tx-sender,
      amount: amount,
      cycle: current-cycle,
      timestamp: stacks-block-time
    })
    (ok current-cycle)))

;; Cancel - only during deposit phase of the SAME cycle
(define-public (cancel-stx-deposit (cycle uint))
  (let (
    (caller tx-sender)
    (amount (get-stx-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-current-cycle) cycle) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (stx-transfer? amount current-contract caller))

    (map-delete stx-deposits { cycle: cycle, depositor: caller })
    (map-set cycle-totals cycle
      (merge totals { total-stx: (- (get total-stx totals) amount) }))

    (print { event: "cancel-stx", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

(define-public (cancel-sbtc-deposit (cycle uint))
  (let (
    (caller tx-sender)
    (amount (get-sbtc-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-current-cycle) cycle) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount current-contract caller none))

    (map-delete sbtc-deposits { cycle: cycle, depositor: caller })
    (map-set cycle-totals cycle
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))

    (print { event: "cancel-sbtc", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

;; ============================================================================
;; Public: Settlement (only during settle phase)
;; ============================================================================

;; Settle using stored Pyth prices (free). Try this first.
(define-public (settle (cycle uint))
  (let (
    (btc-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price BTC_USD_FEED) ERR_ZERO_PRICE))
    (stx-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price STX_USD_FEED) ERR_ZERO_PRICE))
  )
    (execute-settlement cycle btc-feed stx-feed)))

;; Settle with fresh Pyth VAAs when stored prices are stale (~2 uSTX).
(define-public (settle-with-refresh
  (cycle uint)
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
      (btc-feed (unwrap! (contract-call?
        'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
        get-price BTC_USD_FEED) ERR_ZERO_PRICE))
      (stx-feed (unwrap! (contract-call?
        'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
        get-price STX_USD_FEED) ERR_ZERO_PRICE))
    )
      (execute-settlement cycle btc-feed stx-feed))))

;; Shared settlement logic
(define-private (execute-settlement
  (cycle uint)
  (btc-feed { price: int, conf: uint, expo: int, ema-price: int,
              ema-conf: uint, publish-time: uint, prev-publish-time: uint })
  (stx-feed { price: int, conf: uint, expo: int, ema-price: int,
              ema-conf: uint, publish-time: uint, prev-publish-time: uint }))
  (let (
    (current-cycle (get-current-cycle))
    (totals (get-cycle-totals cycle))
    (total-stx (get total-stx totals))
    (total-sbtc (get total-sbtc totals))

    (btc-price (to-uint (get price btc-feed)))
    (stx-price (to-uint (get price stx-feed)))
    (btc-conf (get conf btc-feed))
    (stx-conf (get conf stx-feed))
    (btc-publish-time (get publish-time btc-feed))
    (stx-publish-time (get publish-time stx-feed))

    ;; Oracle price: STX per sBTC
    (oracle-price (/ (* btc-price PRICE_PRECISION) stx-price))

    ;; DEX price for sanity check
    (dex-price (get-dex-price))
    (price-diff (if (> oracle-price dex-price)
      (- oracle-price dex-price)
      (- dex-price oracle-price)))
    (max-allowed-diff (/ oracle-price MAX_DEX_DEVIATION))

    ;; sBTC bucket value in STX terms
    (stx-value-of-sbtc (/ (* total-sbtc oracle-price) PRICE_PRECISION))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    ;; Must be in settle phase of this cycle
    (asserts! (is-eq current-cycle cycle) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    ;; Not already settled
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    ;; Must have deposits
    (asserts! (or (> total-stx u0) (> total-sbtc u0)) ERR_NOTHING_TO_SETTLE)
    ;; Valid prices
    (asserts! (> btc-price u0) ERR_ZERO_PRICE)
    (asserts! (> stx-price u0) ERR_ZERO_PRICE)

    ;; Gate 1: Staleness
    (asserts! (> btc-publish-time (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
    (asserts! (> stx-publish-time (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)

    ;; Gate 2: Confidence < 2%
    (asserts! (< btc-conf (/ btc-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
    (asserts! (< stx-conf (/ stx-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)

    ;; Gate 3: DEX sanity < 10%
    (asserts! (< price-diff max-allowed-diff) ERR_PRICE_DEX_DIVERGENCE)

    ;; Execute pro-rata fill and auto-roll unfilled into next cycle
    (if (<= stx-value-of-sbtc total-stx)
      (settle-sbtc-bound cycle oracle-price total-stx total-sbtc stx-value-of-sbtc)
      (settle-stx-bound cycle oracle-price total-stx total-sbtc))))

;; sBTC side is binding - all sBTC fills, STX partial
(define-private (settle-sbtc-bound
  (cycle uint) (price uint)
  (total-stx uint) (total-sbtc uint)
  (stx-clearing uint))
  (let (
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-clearing total-sbtc)
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (stx-unfilled (- total-stx stx-clearing))
    (next-cycle (+ cycle u1))
    (next-totals (get-cycle-totals next-cycle))
  )
    ;; Record settlement
    (map-set settlements cycle
      { price: price,
        stx-cleared: stx-clearing,
        sbtc-cleared: sbtc-clearing,
        stx-fee: stx-fee,
        sbtc-fee: sbtc-fee,
        settled-at: stacks-block-time })

    ;; Fees to treasury
    (if (> stx-fee u0)
      (try! (stx-transfer? stx-fee current-contract (var-get treasury)))
      true)
    (if (> sbtc-fee u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer sbtc-fee current-contract (var-get treasury) none))
      true)

    ;; Auto-roll unfilled STX into next cycle
    (if (> stx-unfilled u0)
      (map-set cycle-totals next-cycle
        (merge next-totals { total-stx: (+ (get total-stx next-totals) stx-unfilled) }))
      true)

    (print {
      event: "settlement",
      cycle: cycle,
      price: price,
      stx-cleared: stx-clearing,
      sbtc-cleared: sbtc-clearing,
      stx-unfilled: stx-unfilled,
      sbtc-unfilled: u0,
      stx-fee: stx-fee,
      sbtc-fee: sbtc-fee,
      stx-rolled-to: next-cycle,
      binding-side: "sbtc"
    })
    (ok { price: price, stx-cleared: stx-clearing, sbtc-cleared: sbtc-clearing,
          stx-fee: stx-fee, sbtc-fee: sbtc-fee })))

;; STX side is binding - all STX fills, sBTC partial
(define-private (settle-stx-bound
  (cycle uint) (price uint)
  (total-stx uint) (total-sbtc uint))
  (let (
    (stx-clearing total-stx)
    (sbtc-clearing (/ (* total-stx PRICE_PRECISION) price))
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-unfilled (- total-sbtc sbtc-clearing))
    (next-cycle (+ cycle u1))
    (next-totals (get-cycle-totals next-cycle))
  )
    (map-set settlements cycle
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

    ;; Auto-roll unfilled sBTC into next cycle
    (if (> sbtc-unfilled u0)
      (map-set cycle-totals next-cycle
        (merge next-totals { total-sbtc: (+ (get total-sbtc next-totals) sbtc-unfilled) }))
      true)

    (print {
      event: "settlement",
      cycle: cycle,
      price: price,
      stx-cleared: stx-clearing,
      sbtc-cleared: sbtc-clearing,
      stx-unfilled: u0,
      sbtc-unfilled: sbtc-unfilled,
      stx-fee: stx-fee,
      sbtc-fee: sbtc-fee,
      sbtc-rolled-to: next-cycle,
      binding-side: "stx"
    })
    (ok { price: price, stx-cleared: stx-clearing, sbtc-cleared: sbtc-clearing,
          stx-fee: stx-fee, sbtc-fee: sbtc-fee })))

;; ============================================================================
;; Read-only: DEX price
;; ============================================================================

(define-read-only (get-dex-price)
  (if (is-eq (var-get dex-source) DEX_SOURCE_XYK)
    (get-xyk-price)
    (get-dlmm-price)))

;; BitFlow XYK: price = stx-reserve / sbtc-reserve
(define-read-only (get-xyk-price)
  (let (
    (pool (unwrap-panic (contract-call?
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
      get-pool)))
    ;; x = sBTC (8 dec), y = STX (6 dec), adjust by 10^2
    (x-bal (get x-balance pool))
    (y-bal (get y-balance pool))
  )
    (/ (* y-bal u100 PRICE_PRECISION) x-bal)))

;; BitFlow DLMM: active bin price
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
    bin-price))

;; ============================================================================
;; Public: Claims
;; ============================================================================

;; STX depositors claim sBTC. Unfilled STX was auto-rolled.
(define-public (claim-as-stx-depositor (cycle uint))
  (let (
    (settlement (unwrap! (map-get? settlements cycle) ERR_NOTHING_TO_CLAIM))
    (caller tx-sender)
    (my-deposit (get-stx-deposit cycle caller))
    (totals (get-cycle-totals cycle))
    (total-stx (get total-stx totals))
    (stx-cleared (get stx-cleared settlement))
    (sbtc-cleared (get sbtc-cleared settlement))
    (sbtc-fee (get sbtc-fee settlement))
    ;; My pro-rata share
    (my-stx-filled (/ (* my-deposit stx-cleared) total-stx))
    (sbtc-after-fee (- sbtc-cleared sbtc-fee))
    (my-sbtc-received (/ (* my-stx-filled sbtc-after-fee) stx-cleared))
    ;; Unfilled portion was auto-rolled into next cycle's totals.
    ;; Track user's rolled amount for next cycle.
    (my-stx-unfilled (- my-deposit my-stx-filled))
    (next-cycle (+ cycle u1))
    (existing-next (get-stx-deposit next-cycle caller))
  )
    (asserts! (> my-deposit u0) ERR_NOTHING_TO_CLAIM)

    ;; Clear this cycle's deposit
    (map-delete stx-deposits { cycle: cycle, depositor: caller })

    ;; Credit unfilled to next cycle's individual deposit
    (if (> my-stx-unfilled u0)
      (map-set stx-deposits
        { cycle: next-cycle, depositor: caller }
        (+ existing-next my-stx-unfilled))
      true)

    ;; Transfer sBTC to depositor
    (if (> my-sbtc-received u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer my-sbtc-received current-contract caller none))
      true)

    (print {
      event: "claim-stx-depositor",
      depositor: caller,
      cycle: cycle,
      sbtc-received: my-sbtc-received,
      stx-rolled: my-stx-unfilled,
      rolled-to-cycle: next-cycle
    })
    (ok { sbtc-received: my-sbtc-received, stx-rolled: my-stx-unfilled })))

;; sBTC depositors claim STX. Unfilled sBTC was auto-rolled.
(define-public (claim-as-sbtc-depositor (cycle uint))
  (let (
    (settlement (unwrap! (map-get? settlements cycle) ERR_NOTHING_TO_CLAIM))
    (caller tx-sender)
    (my-deposit (get-sbtc-deposit cycle caller))
    (totals (get-cycle-totals cycle))
    (total-sbtc (get total-sbtc totals))
    (stx-cleared (get stx-cleared settlement))
    (sbtc-cleared (get sbtc-cleared settlement))
    (stx-fee (get stx-fee settlement))
    (my-sbtc-filled (/ (* my-deposit sbtc-cleared) total-sbtc))
    (stx-after-fee (- stx-cleared stx-fee))
    (my-stx-received (/ (* my-sbtc-filled stx-after-fee) sbtc-cleared))
    (my-sbtc-unfilled (- my-deposit my-sbtc-filled))
    (next-cycle (+ cycle u1))
    (existing-next (get-sbtc-deposit next-cycle caller))
  )
    (asserts! (> my-deposit u0) ERR_NOTHING_TO_CLAIM)

    (map-delete sbtc-deposits { cycle: cycle, depositor: caller })

    ;; Credit unfilled to next cycle
    (if (> my-sbtc-unfilled u0)
      (map-set sbtc-deposits
        { cycle: next-cycle, depositor: caller }
        (+ existing-next my-sbtc-unfilled))
      true)

    (if (> my-stx-received u0)
      (try! (stx-transfer? my-stx-received current-contract caller))
      true)

    (print {
      event: "claim-sbtc-depositor",
      depositor: caller,
      cycle: cycle,
      stx-received: my-stx-received,
      sbtc-rolled: my-sbtc-unfilled,
      rolled-to-cycle: next-cycle
    })
    (ok { stx-received: my-stx-received, sbtc-rolled: my-sbtc-unfilled })))

;; Withdraw rolled funds - cancel your auto-rolled position from a previous cycle
;; Must be during deposit phase of the cycle the funds rolled into
(define-public (withdraw-rolled-stx (cycle uint))
  (let (
    (caller tx-sender)
    (amount (get-stx-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-current-cycle) cycle) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (stx-transfer? amount current-contract caller))

    (map-delete stx-deposits { cycle: cycle, depositor: caller })
    (map-set cycle-totals cycle
      (merge totals { total-stx: (- (get total-stx totals) amount) }))

    (print { event: "withdraw-rolled-stx", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

(define-public (withdraw-rolled-sbtc (cycle uint))
  (let (
    (caller tx-sender)
    (amount (get-sbtc-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-current-cycle) cycle) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount current-contract caller none))

    (map-delete sbtc-deposits { cycle: cycle, depositor: caller })
    (map-set cycle-totals cycle
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))

    (print { event: "withdraw-rolled-sbtc", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

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

(define-public (set-dex-source (source uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (or (is-eq source DEX_SOURCE_XYK) (is-eq source DEX_SOURCE_DLMM)) ERR_NOT_AUTHORIZED)
    (ok (var-set dex-source source))))
