;; title: blind-auction
;; version: 0.7.0
;; summary: Blind batch auction for sBTC/STX swaps at synthetic oracle price
;; description:
;;   ~8-minute cycle (block-based): ~50 blocks deposit, ~10 blocks buffer,
;;   ~20 blocks settle window. 50 slots per side, larger deposits bump smallest.
;;   Settlement reads Pyth spot price, validates 3 safety gates, then
;;   pushes tokens directly to all depositors. Unfilled auto-rolls.

;; ============================================================================
;; Traits (for Pyth refresh path)
;; ============================================================================

(use-trait pyth-storage-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.storage-trait)
(use-trait pyth-decoder-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-traits-v2.core-trait)

;; ============================================================================
;; Constants
;; ============================================================================

;; Cycle timing (in Stacks blocks, ~5-10s each)
;; ~80 blocks = ~8 minutes at ~6s/block
(define-constant CYCLE_LENGTH u80)
(define-constant DEPOSIT_END u50)      ;; blocks 0-50: deposit window (~5 min)
(define-constant SETTLE_START u60)     ;; blocks 60-80: settle window (~2 min, 10 block buffer)

;; Phases
(define-constant PHASE_DEPOSIT u0)
(define-constant PHASE_BUFFER u1)
(define-constant PHASE_SETTLE u2)

;; Max depositors per side per cycle
(define-constant MAX_DEPOSITORS u50)

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
(define-constant MAX_STALENESS u60)
(define-constant MAX_CONF_RATIO u50)
(define-constant MAX_DEX_DEVIATION u10)

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
(define-constant ERR_QUEUE_FULL (err u1013))

;; ============================================================================
;; Data vars
;; ============================================================================

(define-data-var treasury principal tx-sender)
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var dex-source uint DEX_SOURCE_XYK)

;; Admin-adjustable minimum deposits
(define-data-var min-stx-deposit uint u1000000)    ;; 1 STX default
(define-data-var min-sbtc-deposit uint u1000)       ;; 0.00001 sBTC default

;; Settlement context (set during execute-settlement, read by distribute)
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

;; Individual deposits per cycle per user (for pro-rata calculation)
(define-map stx-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map sbtc-deposits
  { cycle: uint, depositor: principal }
  uint)

;; Ordered depositor lists per cycle (for iteration + priority bumping)
(define-map stx-depositor-list
  uint  ;; cycle
  (list 50 principal))

(define-map sbtc-depositor-list
  uint  ;; cycle
  (list 50 principal))

;; Aggregate totals per cycle
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
;; Read-only helpers
;; ============================================================================

(define-read-only (get-current-cycle)
  (/ stacks-block-height CYCLE_LENGTH))

(define-read-only (get-cycle-phase)
  (let ((elapsed (mod stacks-block-height CYCLE_LENGTH)))
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

(define-read-only (get-stx-depositors (cycle uint))
  (default-to (list) (map-get? stx-depositor-list cycle)))

(define-read-only (get-sbtc-depositors (cycle uint))
  (default-to (list) (map-get? sbtc-depositor-list cycle)))

(define-read-only (get-dex-source)
  (var-get dex-source))

(define-read-only (get-min-deposits)
  { min-stx: (var-get min-stx-deposit), min-sbtc: (var-get min-sbtc-deposit) })

;; ============================================================================
;; Private: Priority queue helpers
;; ============================================================================

;; Find the smallest deposit in a list and its index
(define-private (find-smallest-stx-fold
  (depositor principal)
  (acc { cycle: uint, smallest: uint, smallest-idx: uint, smallest-principal: principal, current-idx: uint }))
  (let (
    (amount (get-stx-deposit (get cycle acc) depositor))
    (idx (get current-idx acc))
  )
    (if (< amount (get smallest acc))
      (merge acc { smallest: amount, smallest-idx: idx, smallest-principal: depositor, current-idx: (+ idx u1) })
      (merge acc { current-idx: (+ idx u1) }))))

(define-private (find-smallest-sbtc-fold
  (depositor principal)
  (acc { cycle: uint, smallest: uint, smallest-idx: uint, smallest-principal: principal, current-idx: uint }))
  (let (
    (amount (get-sbtc-deposit (get cycle acc) depositor))
    (idx (get current-idx acc))
  )
    (if (< amount (get smallest acc))
      (merge acc { smallest: amount, smallest-idx: idx, smallest-principal: depositor, current-idx: (+ idx u1) })
      (merge acc { current-idx: (+ idx u1) }))))

;; Filter out a specific principal from a list
(define-private (not-eq-bumped (entry principal))
  (not (is-eq entry (var-get bumped-principal))))

(define-data-var bumped-principal principal tx-sender)

;; ============================================================================
;; Public: Deposits (only during deposit phase)
;; ============================================================================

(define-public (deposit-stx (amount uint))
  (let (
    (current-cycle (get-current-cycle))
    (existing (get-stx-deposit current-cycle tx-sender))
    (totals (get-cycle-totals current-cycle))
    (depositors (get-stx-depositors current-cycle))
    (num-depositors (len depositors))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-stx-deposit)) ERR_DEPOSIT_TOO_SMALL)

    ;; Transfer STX to contract
    (try! (stx-transfer? amount tx-sender current-contract))

    ;; If user already has a deposit, just add to it
    (if (> existing u0)
      (begin
        (map-set stx-deposits
          { cycle: current-cycle, depositor: tx-sender }
          (+ existing amount))
        (map-set cycle-totals current-cycle
          (merge totals { total-stx: (+ (get total-stx totals) amount) }))
        (print { event: "deposit-stx", depositor: tx-sender, amount: (+ existing amount),
                 cycle: current-cycle, action: "add" })
        (ok current-cycle))

      ;; New depositor
      (if (< num-depositors MAX_DEPOSITORS)
        ;; Slots available - just append
        (begin
          (map-set stx-deposits
            { cycle: current-cycle, depositor: tx-sender }
            amount)
          (map-set stx-depositor-list current-cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          (map-set cycle-totals current-cycle
            (merge totals { total-stx: (+ (get total-stx totals) amount) }))
          (print { event: "deposit-stx", depositor: tx-sender, amount: amount,
                   cycle: current-cycle, action: "new" })
          (ok current-cycle))

        ;; Queue full - try to bump smallest
        (let (
          (smallest-info (fold find-smallest-stx-fold depositors
            { cycle: current-cycle, smallest: u999999999999999999,
              smallest-idx: u0, smallest-principal: tx-sender, current-idx: u0 }))
          (smallest-amount (get smallest smallest-info))
          (smallest-who (get smallest-principal smallest-info))
        )
          ;; New deposit must be strictly larger than smallest
          (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)

          ;; Refund the bumped depositor
          (try! (stx-transfer? smallest-amount current-contract smallest-who))

          ;; Remove bumped from list
          (var-set bumped-principal smallest-who)
          (let ((filtered (filter not-eq-bumped depositors)))
            (map-set stx-depositor-list current-cycle
              (unwrap-panic (as-max-len? (append filtered tx-sender) u50))))

          ;; Remove bumped deposit, add new
          (map-delete stx-deposits { cycle: current-cycle, depositor: smallest-who })
          (map-set stx-deposits
            { cycle: current-cycle, depositor: tx-sender }
            amount)
          (map-set cycle-totals current-cycle
            (merge totals { total-stx: (+ (- (get total-stx totals) smallest-amount) amount) }))

          (print { event: "deposit-stx", depositor: tx-sender, amount: amount,
                   cycle: current-cycle, action: "bump",
                   bumped: smallest-who, bumped-amount: smallest-amount })
          (ok current-cycle))))))

(define-public (deposit-sbtc (amount uint))
  (let (
    (current-cycle (get-current-cycle))
    (existing (get-sbtc-deposit current-cycle tx-sender))
    (totals (get-cycle-totals current-cycle))
    (depositors (get-sbtc-depositors current-cycle))
    (num-depositors (len depositors))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-sbtc-deposit)) ERR_DEPOSIT_TOO_SMALL)

    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender current-contract none))

    ;; If user already has a deposit, just add to it
    (if (> existing u0)
      (begin
        (map-set sbtc-deposits
          { cycle: current-cycle, depositor: tx-sender }
          (+ existing amount))
        (map-set cycle-totals current-cycle
          (merge totals { total-sbtc: (+ (get total-sbtc totals) amount) }))
        (print { event: "deposit-sbtc", depositor: tx-sender, amount: (+ existing amount),
                 cycle: current-cycle, action: "add" })
        (ok current-cycle))

      ;; New depositor
      (if (< num-depositors MAX_DEPOSITORS)
        (begin
          (map-set sbtc-deposits
            { cycle: current-cycle, depositor: tx-sender }
            amount)
          (map-set sbtc-depositor-list current-cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          (map-set cycle-totals current-cycle
            (merge totals { total-sbtc: (+ (get total-sbtc totals) amount) }))
          (print { event: "deposit-sbtc", depositor: tx-sender, amount: amount,
                   cycle: current-cycle, action: "new" })
          (ok current-cycle))

        ;; Queue full - try to bump smallest
        (let (
          (smallest-info (fold find-smallest-sbtc-fold depositors
            { cycle: current-cycle, smallest: u999999999999999999,
              smallest-idx: u0, smallest-principal: tx-sender, current-idx: u0 }))
          (smallest-amount (get smallest smallest-info))
          (smallest-who (get smallest-principal smallest-info))
        )
          (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)

          ;; Refund bumped
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer smallest-amount current-contract smallest-who none))

          ;; Remove bumped, add new
          (var-set bumped-principal smallest-who)
          (let ((filtered (filter not-eq-bumped depositors)))
            (map-set sbtc-depositor-list current-cycle
              (unwrap-panic (as-max-len? (append filtered tx-sender) u50))))

          (map-delete sbtc-deposits { cycle: current-cycle, depositor: smallest-who })
          (map-set sbtc-deposits
            { cycle: current-cycle, depositor: tx-sender }
            amount)
          (map-set cycle-totals current-cycle
            (merge totals { total-sbtc: (+ (- (get total-sbtc totals) smallest-amount) amount) }))

          (print { event: "deposit-sbtc", depositor: tx-sender, amount: amount,
                   cycle: current-cycle, action: "bump",
                   bumped: smallest-who, bumped-amount: smallest-amount })
          (ok current-cycle))))))

;; Cancel deposit - only during deposit phase of same cycle
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
    ;; Remove from list
    (var-set bumped-principal caller)
    (map-set stx-depositor-list cycle (filter not-eq-bumped (get-stx-depositors cycle)))
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
    (var-set bumped-principal caller)
    (map-set sbtc-depositor-list cycle (filter not-eq-bumped (get-sbtc-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))

    (print { event: "cancel-sbtc", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

;; Withdraw auto-rolled funds
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
    (var-set bumped-principal caller)
    (map-set stx-depositor-list cycle (filter not-eq-bumped (get-stx-depositors cycle)))
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
    (var-set bumped-principal caller)
    (map-set sbtc-depositor-list cycle (filter not-eq-bumped (get-sbtc-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))

    (print { event: "withdraw-rolled-sbtc", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

;; ============================================================================
;; Public: Settlement (only during settle phase)
;; ============================================================================

;; Settle using stored Pyth prices (free). Distributes to all depositors.
(define-public (settle (cycle uint))
  (let (
    (btc-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price BTC_USD_FEED) ERR_ZERO_PRICE))
    (stx-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price STX_USD_FEED) ERR_ZERO_PRICE))
  )
    (try! (execute-settlement cycle btc-feed stx-feed))
    (map distribute-to-stx-depositor (get-stx-depositors cycle))
    (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
    (ok true)))

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
      (try! (execute-settlement cycle btc-feed stx-feed))
      (map distribute-to-stx-depositor (get-stx-depositors cycle))
      (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
      (ok true))))

;; ============================================================================
;; Private: Settlement logic
;; ============================================================================

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
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq current-cycle cycle) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (asserts! (and (> total-stx u0) (> total-sbtc u0)) ERR_NOTHING_TO_SETTLE)
    (asserts! (> btc-price u0) ERR_ZERO_PRICE)
    (asserts! (> stx-price u0) ERR_ZERO_PRICE)

    ;; Gate 1: Staleness (publish-time is Unix seconds, compare against block time)
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
        settled-at: stacks-block-height })

    ;; Fees to treasury
    (if (> stx-fee u0)
      (try! (stx-transfer? stx-fee current-contract (var-get treasury)))
      true)
    (if (> sbtc-fee u0)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer sbtc-fee current-contract (var-get treasury) none))
      true)

    ;; Auto-roll unfilled totals into next cycle
    (if (> stx-unfilled u0)
      (map-set cycle-totals next-cycle
        (merge next-totals { total-stx: (+ (get total-stx next-totals) stx-unfilled) }))
      true)
    (if (> sbtc-unfilled u0)
      (map-set cycle-totals next-cycle
        (merge next-totals { total-sbtc: (+ (get total-sbtc next-totals) sbtc-unfilled) }))
      true)

    ;; Set context for distribute functions
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
;; Private: Push distribution
;; ============================================================================

;; Send sBTC to STX depositor, roll unfilled STX to next cycle
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
        (map-delete stx-deposits { cycle: cycle, depositor: depositor })

        ;; Send sBTC
        (if (> my-sbtc-received u0)
          (match (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer my-sbtc-received current-contract depositor none)
            success true
            error true)
          true)

        ;; Roll unfilled to next cycle (deposit + depositor list)
        (if (> my-stx-unfilled u0)
          (begin
            (map-set stx-deposits
              { cycle: next-cycle, depositor: depositor }
              (+ existing-next my-stx-unfilled))
            ;; Add to next cycle's depositor list if not already there
            (if (is-eq existing-next u0)
              (let ((next-list (get-stx-depositors next-cycle)))
                (if (< (len next-list) MAX_DEPOSITORS)
                  (map-set stx-depositor-list next-cycle
                    (unwrap-panic (as-max-len? (append next-list depositor) u50)))
                  true))
              true))
          true)

        (print {
          event: "distribute-stx-depositor",
          depositor: depositor,
          cycle: cycle,
          sbtc-received: my-sbtc-received,
          stx-rolled: my-stx-unfilled
        })
        true))))

;; Send STX to sBTC depositor, roll unfilled sBTC to next cycle
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

        ;; Send STX
        (if (> my-stx-received u0)
          (match (stx-transfer? my-stx-received current-contract depositor)
            success true
            error true)
          true)

        ;; Roll unfilled to next cycle
        (if (> my-sbtc-unfilled u0)
          (begin
            (map-set sbtc-deposits
              { cycle: next-cycle, depositor: depositor }
              (+ existing-next my-sbtc-unfilled))
            (if (is-eq existing-next u0)
              (let ((next-list (get-sbtc-depositors next-cycle)))
                (if (< (len next-list) MAX_DEPOSITORS)
                  (map-set sbtc-depositor-list next-cycle
                    (unwrap-panic (as-max-len? (append next-list depositor) u50)))
                  true))
              true))
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
