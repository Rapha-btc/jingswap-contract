;; title: blind-auction
;; version: 0.5.0
;; summary: Blind batch auction for sBTC/STX swaps at synthetic oracle price
;; description:
;;   8-minute cycle: 5 min deposit, 1 min buffer, 2 min settle window.
;;   Settlement reads Pyth spot price, validates 3 safety gates, then
;;   pushes tokens directly to depositors (no claim step).
;;   Unfilled remainder auto-rolls into next cycle.

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
(define-constant ERR_NOTHING_TO_WITHDRAW (err u1008))
(define-constant ERR_ZERO_PRICE (err u1009))
(define-constant ERR_PAUSED (err u1010))
(define-constant ERR_NOT_AUTHORIZED (err u1011))
(define-constant ERR_NOTHING_TO_SETTLE (err u1012))

;; ============================================================================
;; Data vars
;; ============================================================================

(define-data-var treasury principal tx-sender)
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var dex-source uint DEX_SOURCE_XYK)

;; Admin-adjustable minimum deposits (start low, raise if dust spam)
(define-data-var min-stx-deposit uint u1000000)    ;; 1 STX default
(define-data-var min-sbtc-deposit uint u1000)       ;; 0.00001 sBTC default

;; Settlement context (set by execute-settlement, read by distribute functions)
(define-data-var settle-cycle uint u0)
(define-data-var settle-stx-cleared uint u0)
(define-data-var settle-sbtc-cleared uint u0)
(define-data-var settle-total-stx uint u0)
(define-data-var settle-total-sbtc uint u0)
(define-data-var settle-sbtc-after-fee uint u0)
(define-data-var settle-stx-after-fee uint u0)

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

(define-read-only (get-min-deposits)
  { min-stx: (var-get min-stx-deposit), min-sbtc: (var-get min-sbtc-deposit) })

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
    (asserts! (>= amount (var-get min-stx-deposit)) ERR_DEPOSIT_TOO_SMALL)

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
    (asserts! (>= amount (var-get min-sbtc-deposit)) ERR_DEPOSIT_TOO_SMALL)

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

;; Withdraw auto-rolled funds from a previous cycle
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
;; Public: Settlement (only during settle phase)
;; ============================================================================

;; Settle and distribute: reads stored Pyth prices (free), computes fill,
;; then pushes tokens directly to all depositors. No claim step.
;; Settler passes lists of depositors on each side (from deposit events).
(define-public (settle
  (cycle uint)
  (stx-depositors (list 50 principal))
  (sbtc-depositors (list 50 principal)))
  (let (
    (btc-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price BTC_USD_FEED) ERR_ZERO_PRICE))
    (stx-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price STX_USD_FEED) ERR_ZERO_PRICE))
  )
    (try! (execute-settlement cycle btc-feed stx-feed))
    ;; Distribute to all depositors
    (map distribute-to-stx-depositor stx-depositors)
    (map distribute-to-sbtc-depositor sbtc-depositors)
    (ok true)))

;; Settle with fresh Pyth VAAs when stored prices are stale (~2 uSTX).
(define-public (settle-with-refresh
  (cycle uint)
  (stx-depositors (list 50 principal))
  (sbtc-depositors (list 50 principal))
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
      (try! (execute-settlement cycle btc-feed stx-feed))
      (map distribute-to-stx-depositor stx-depositors)
      (map distribute-to-sbtc-depositor sbtc-depositors)
      (ok true))))

;; ============================================================================
;; Private: Settlement logic
;; ============================================================================

;; Validate gates, record settlement, set context vars for distribution
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

    (oracle-price (/ (* btc-price PRICE_PRECISION) stx-price))

    (dex-price (get-dex-price))
    (price-diff (if (> oracle-price dex-price)
      (- oracle-price dex-price)
      (- dex-price oracle-price)))
    (max-allowed-diff (/ oracle-price MAX_DEX_DEVIATION))

    (stx-value-of-sbtc (/ (* total-sbtc oracle-price) PRICE_PRECISION))

    ;; Determine clearing amounts
    (sbtc-is-binding (<= stx-value-of-sbtc total-stx))
    (stx-clearing (if sbtc-is-binding stx-value-of-sbtc total-stx))
    (sbtc-clearing (if sbtc-is-binding total-sbtc (/ (* total-stx PRICE_PRECISION) oracle-price)))
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (stx-unfilled (- total-stx stx-clearing))
    (sbtc-unfilled (- total-sbtc sbtc-clearing))
    (next-cycle (+ cycle u1))
    (next-totals (get-cycle-totals next-cycle))
  )
    ;; Assertions
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq current-cycle cycle) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (asserts! (or (> total-stx u0) (> total-sbtc u0)) ERR_NOTHING_TO_SETTLE)
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

    ;; Record settlement
    (map-set settlements cycle
      { price: oracle-price,
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

    ;; Auto-roll unfilled into next cycle
    (if (> stx-unfilled u0)
      (map-set cycle-totals next-cycle
        (merge next-totals { total-stx: (+ (get total-stx next-totals) stx-unfilled) }))
      true)
    (if (> sbtc-unfilled u0)
      (map-set cycle-totals next-cycle
        (merge next-totals { total-sbtc: (+ (get total-sbtc next-totals) sbtc-unfilled) }))
      true)

    ;; Set context vars for distribute functions (map can't take extra args)
    (var-set settle-cycle cycle)
    (var-set settle-stx-cleared stx-clearing)
    (var-set settle-sbtc-cleared sbtc-clearing)
    (var-set settle-total-stx total-stx)
    (var-set settle-total-sbtc total-sbtc)
    (var-set settle-sbtc-after-fee (- sbtc-clearing sbtc-fee))
    (var-set settle-stx-after-fee (- stx-clearing stx-fee))

    (print {
      event: "settlement",
      cycle: cycle,
      price: oracle-price,
      stx-cleared: stx-clearing,
      sbtc-cleared: sbtc-clearing,
      stx-unfilled: stx-unfilled,
      sbtc-unfilled: sbtc-unfilled,
      stx-fee: stx-fee,
      sbtc-fee: sbtc-fee,
      binding-side: (if sbtc-is-binding "sbtc" "stx")
    })
    (ok true)))

;; ============================================================================
;; Private: Push distribution to individual depositors
;; ============================================================================

;; Distribute to an STX depositor: send sBTC received, roll unfilled STX
(define-private (distribute-to-stx-depositor (depositor principal))
  (let (
    (cycle (var-get settle-cycle))
    (my-deposit (get-stx-deposit cycle depositor))
    (total-stx (var-get settle-total-stx))
    (stx-cleared (var-get settle-stx-cleared))
    (sbtc-after-fee (var-get settle-sbtc-after-fee))
    (my-stx-filled (if (> total-stx u0) (/ (* my-deposit stx-cleared) total-stx) u0))
    (my-sbtc-received (if (> stx-cleared u0) (/ (* my-stx-filled sbtc-after-fee) stx-cleared) u0))
    (my-stx-unfilled (- my-deposit my-stx-filled))
    (next-cycle (+ cycle u1))
    (existing-next (get-stx-deposit next-cycle depositor))
  )
    (if (is-eq my-deposit u0) true
      (begin
        ;; Clear this cycle's deposit
        (map-delete stx-deposits { cycle: cycle, depositor: depositor })

        ;; Send sBTC received
        (if (> my-sbtc-received u0)
          (match (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer my-sbtc-received current-contract depositor none)
            success true
            error true)
          true)

        ;; Roll unfilled to next cycle
        (if (> my-stx-unfilled u0)
          (map-set stx-deposits
            { cycle: next-cycle, depositor: depositor }
            (+ existing-next my-stx-unfilled))
          true)

        (print {
          event: "distribute-stx-depositor",
          depositor: depositor,
          cycle: cycle,
          sbtc-received: my-sbtc-received,
          stx-rolled: my-stx-unfilled
        })
        true))))

;; Distribute to an sBTC depositor: send STX received, roll unfilled sBTC
(define-private (distribute-to-sbtc-depositor (depositor principal))
  (let (
    (cycle (var-get settle-cycle))
    (my-deposit (get-sbtc-deposit cycle depositor))
    (total-sbtc (var-get settle-total-sbtc))
    (sbtc-cleared (var-get settle-sbtc-cleared))
    (stx-after-fee (var-get settle-stx-after-fee))
    (my-sbtc-filled (if (> total-sbtc u0) (/ (* my-deposit sbtc-cleared) total-sbtc) u0))
    (my-stx-received (if (> sbtc-cleared u0) (/ (* my-sbtc-filled stx-after-fee) sbtc-cleared) u0))
    (my-sbtc-unfilled (- my-deposit my-sbtc-filled))
    (next-cycle (+ cycle u1))
    (existing-next (get-sbtc-deposit next-cycle depositor))
  )
    (if (is-eq my-deposit u0) true
      (begin
        (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })

        ;; Send STX received
        (if (> my-stx-received u0)
          (match (stx-transfer? my-stx-received current-contract depositor)
            success true
            error true)
          true)

        ;; Roll unfilled to next cycle
        (if (> my-sbtc-unfilled u0)
          (map-set sbtc-deposits
            { cycle: next-cycle, depositor: depositor }
            (+ existing-next my-sbtc-unfilled))
          true)

        (print {
          event: "distribute-sbtc-depositor",
          depositor: depositor,
          cycle: cycle,
          stx-received: my-stx-received,
          sbtc-rolled: my-sbtc-unfilled
        })
        true))))

;; ============================================================================
;; Read-only: DEX price
;; ============================================================================

(define-read-only (get-dex-price)
  (if (is-eq (var-get dex-source) DEX_SOURCE_XYK)
    (get-xyk-price)
    (get-dlmm-price)))

(define-read-only (get-xyk-price)
  (let (
    (pool (unwrap-panic (contract-call?
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
      get-pool)))
    (x-bal (get x-balance pool))
    (y-bal (get y-balance pool))
  )
    (/ (* y-bal u100 PRICE_PRECISION) x-bal)))

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

(define-public (set-min-stx-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-stx-deposit amount))))

(define-public (set-min-sbtc-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-sbtc-deposit amount))))
