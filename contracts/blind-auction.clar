;; title: blind-auction
;; version: 0.8.0
;; summary: Blind batch auction for sBTC/STX swaps at synthetic oracle price
;; description:
;;   State-machine cycles: deposit (150 blocks), buffer (30 blocks), then
;;   open-ended settle window. Cycle advances ONLY on successful settlement.
;;   If settlement keeps failing, anyone can cancel after CANCEL_THRESHOLD
;;   blocks, refunding all depositors and advancing the cycle.
;;   50 slots per side, larger deposits bump smallest when full.
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

;; Cycle phase thresholds (in blocks, ~2s each)
(define-constant DEPOSIT_MIN_BLOCKS u150) ;; min 150 blocks before deposits can be closed (~5 min)
;; Buffer must be >= MAX_STALENESS worth of blocks so that any price
;; visible during deposit phase is guaranteed stale by settle time.
;; This prevents depositors from gaming a known settlement price.
(define-constant BUFFER_BLOCKS u30)       ;; 30 blocks (~60s) >= MAX_STALENESS (60s)
(define-constant CANCEL_THRESHOLD u500)   ;; 500 blocks after closed + buffer = anyone can cancel (~16 min)

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
(define-constant ERR_QUEUE_FULL (err u1013))
(define-constant ERR_CANCEL_TOO_EARLY (err u1014))
(define-constant ERR_CLOSE_TOO_EARLY (err u1015))
(define-constant ERR_ALREADY_CLOSED (err u1016))

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

;; Cycle state machine
(define-data-var current-cycle uint u0)
(define-data-var cycle-start-block uint u0)
;; u0 = deposits still open, >0 = block when deposits were closed
(define-data-var deposits-closed-block uint u0)

;; Settlement context (set during execute-settlement, read by distribute)
(define-data-var settle-cycle uint u0)
(define-data-var settle-stx-cleared uint u0)
(define-data-var settle-sbtc-cleared uint u0)
(define-data-var settle-total-stx uint u0)
(define-data-var settle-total-sbtc uint u0)
(define-data-var settle-sbtc-after-fee uint u0)
(define-data-var settle-stx-after-fee uint u0)

;; Helper for filter
(define-data-var bumped-stx-principal principal tx-sender)
(define-data-var bumped-sbtc-principal principal tx-sender)

;; ============================================================================
;; Data maps
;; ============================================================================

(define-map stx-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map sbtc-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map stx-depositor-list
  uint
  (list 50 principal))

(define-map sbtc-depositor-list
  uint
  (list 50 principal))

(define-map cycle-totals
  uint
  { total-stx: uint, total-sbtc: uint })

(define-map settlements
  uint
  { price: uint,
    stx-cleared: uint,
    sbtc-cleared: uint,
    stx-fee: uint,
    sbtc-fee: uint,
    settled-at: uint })

;; ============================================================================
;; Read-only: Cycle & phase
;; ============================================================================

(define-read-only (get-current-cycle)
  (var-get current-cycle))

(define-read-only (get-cycle-start-block)
  (var-get cycle-start-block))

(define-read-only (get-blocks-elapsed)
  (- stacks-block-height (var-get cycle-start-block)))

;; Phase logic:
;; - deposits-closed-block = 0: deposits still open
;; - closed but buffer not passed: buffer (no actions)
;; - buffer passed: settle
(define-read-only (get-cycle-phase)
  (let ((closed-block (var-get deposits-closed-block)))
    (if (is-eq closed-block u0)
      PHASE_DEPOSIT
      (if (< stacks-block-height (+ closed-block BUFFER_BLOCKS))
        PHASE_BUFFER
        PHASE_SETTLE))))

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
;; Private: Advance cycle (called after settle or cancel)
;; ============================================================================

(define-private (advance-cycle)
  (begin
    (var-set current-cycle (+ (var-get current-cycle) u1))
    (var-set cycle-start-block stacks-block-height)
    (var-set deposits-closed-block u0)))

;; ============================================================================
;; Private: Priority queue helpers
;; ============================================================================

(define-private (find-smallest-stx-fold
  (depositor principal)
  (acc { cycle: uint, smallest: uint, smallest-principal: principal }))
  (let ((amount (get-stx-deposit (get cycle acc) depositor)))
    (if (< amount (get smallest acc))
      (merge acc { smallest: amount, smallest-principal: depositor })
      acc)))

(define-private (find-smallest-sbtc-fold
  (depositor principal)
  (acc { cycle: uint, smallest: uint, smallest-principal: principal }))
  (let ((amount (get-sbtc-deposit (get cycle acc) depositor)))
    (if (< amount (get smallest acc))
      (merge acc { smallest: amount, smallest-principal: depositor })
      acc)))

(define-private (not-eq-bumped-stx (entry principal))
  (not (is-eq entry (var-get bumped-stx-principal))))

(define-private (not-eq-bumped-sbtc (entry principal))
  (not (is-eq entry (var-get bumped-sbtc-principal))))

;; ============================================================================
;; Private: Roll helpers (for cancel-cycle)
;; ============================================================================

;; Move a depositor's STX deposit from cancelled cycle to next cycle
(define-private (roll-stx-depositor (depositor principal))
  (let ((cycle (var-get settle-cycle)))
    (map-set stx-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-stx-deposit cycle depositor))
    (map-delete stx-deposits { cycle: cycle, depositor: depositor })))

(define-private (roll-sbtc-depositor (depositor principal))
  (let ((cycle (var-get settle-cycle)))
    (map-set sbtc-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-sbtc-deposit cycle depositor))
    (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })))

;; Merge depositor lists from old cycle into next cycle
(define-private (roll-depositor-lists (cycle uint))
  (begin
    (map-set stx-depositor-list (+ cycle u1) (get-stx-depositors cycle))
    (map-set sbtc-depositor-list (+ cycle u1) (get-sbtc-depositors cycle))))

;; ============================================================================
;; Public: Deposits (only during deposit phase)
;; ============================================================================

(define-public (deposit-stx (amount uint))
  (let (
    (cycle (var-get current-cycle))
    (existing (get-stx-deposit cycle tx-sender))
    (totals (get-cycle-totals cycle))
    (depositors (get-stx-depositors cycle))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-stx-deposit)) ERR_DEPOSIT_TOO_SMALL)

    (if (and (is-eq existing u0) (>= (len depositors) MAX_DEPOSITORS))
      ;; Bump: evict smallest, take their slot
      (let (
        (smallest-info (fold find-smallest-stx-fold depositors
          { cycle: cycle, smallest: u999999999999999999, smallest-principal: tx-sender }))
        (smallest-amount (get smallest smallest-info))
        (smallest-who (get smallest-principal smallest-info))
      )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (as-contract? ((with-stx smallest-amount))
          (try! (stx-transfer? smallest-amount current-contract smallest-who)))
        (try! (stx-transfer? amount tx-sender current-contract))
        (var-set bumped-stx-principal smallest-who)
        (map-set stx-depositor-list cycle
          (unwrap-panic (as-max-len? (append (filter not-eq-bumped-stx depositors) tx-sender) u50)))
        (map-delete stx-deposits { cycle: cycle, depositor: smallest-who })
        (map-set stx-deposits { cycle: cycle, depositor: tx-sender } amount)
        (map-set cycle-totals cycle
          (merge totals { total-stx: (+ (- (get total-stx totals) smallest-amount) amount) }))
        (print { event: "deposit-stx", depositor: tx-sender, amount: amount, cycle: cycle,
                 bumped: smallest-who, bumped-amount: smallest-amount })
        (ok amount))

      ;; Normal: add or top up
      (begin
        (try! (stx-transfer? amount tx-sender current-contract))
        (map-set stx-deposits { cycle: cycle, depositor: tx-sender } (+ existing amount))
        (map-set cycle-totals cycle
          (merge totals { total-stx: (+ (get total-stx totals) amount) }))
        (if (is-eq existing u0)
          (map-set stx-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          true)
        (print { event: "deposit-stx", depositor: tx-sender, amount: (+ existing amount), cycle: cycle })
        (ok cycle)))))

(define-public (deposit-sbtc (amount uint))
  (let (
    (cycle (var-get current-cycle))
    (existing (get-sbtc-deposit cycle tx-sender))
    (totals (get-cycle-totals cycle))
    (depositors (get-sbtc-depositors cycle))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-sbtc-deposit)) ERR_DEPOSIT_TOO_SMALL)

    (if (and (is-eq existing u0) (>= (len depositors) MAX_DEPOSITORS))
      ;; Bump: evict smallest, take their slot
      (let (
        (smallest-info (fold find-smallest-sbtc-fold depositors
          { cycle: cycle, smallest: u999999999999999999, smallest-principal: tx-sender }))
        (smallest-amount (get smallest smallest-info))
        (smallest-who (get smallest-principal smallest-info))
      )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" smallest-amount))
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer smallest-amount current-contract smallest-who none)))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer amount tx-sender current-contract none))
        (var-set bumped-sbtc-principal smallest-who)
        (map-set sbtc-depositor-list cycle
          (unwrap-panic (as-max-len? (append (filter not-eq-bumped-sbtc depositors) tx-sender) u50)))
        (map-delete sbtc-deposits { cycle: cycle, depositor: smallest-who })
        (map-set sbtc-deposits { cycle: cycle, depositor: tx-sender } amount)
        (map-set cycle-totals cycle
          (merge totals { total-sbtc: (+ (- (get total-sbtc totals) smallest-amount) amount) }))
        (print { event: "deposit-sbtc", depositor: tx-sender, amount: amount, cycle: cycle,
                 bumped: smallest-who, bumped-amount: smallest-amount })
        (ok amount))

      ;; Normal: add or top up
      (begin
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer amount tx-sender current-contract none))
        (map-set sbtc-deposits { cycle: cycle, depositor: tx-sender } (+ existing amount))
        (map-set cycle-totals cycle
          (merge totals { total-sbtc: (+ (get total-sbtc totals) amount) }))
        (if (is-eq existing u0)
          (map-set sbtc-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          true)
        (print { event: "deposit-sbtc", depositor: tx-sender, amount: (+ existing amount), cycle: cycle })
        (ok amount)))))

;; Cancel deposit - only during deposit phase of current cycle
(define-public (cancel-stx-deposit)
  (let (
    (cycle (var-get current-cycle))
    (caller tx-sender)
    (amount (get-stx-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (stx-transfer? amount current-contract caller))
    (map-delete stx-deposits { cycle: cycle, depositor: caller })
    (var-set bumped-stx-principal caller)
    (map-set stx-depositor-list cycle (filter not-eq-bumped-stx (get-stx-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-stx: (- (get total-stx totals) amount) }))

    (print { event: "cancel-stx", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

(define-public (cancel-sbtc-deposit)
  (let (
    (cycle (var-get current-cycle))
    (caller tx-sender)
    (amount (get-sbtc-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)

    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount current-contract caller none))
    (map-delete sbtc-deposits { cycle: cycle, depositor: caller })
    (var-set bumped-sbtc-principal caller)
    (map-set sbtc-depositor-list cycle (filter not-eq-bumped-sbtc (get-sbtc-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))

    (print { event: "cancel-sbtc", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

;; ============================================================================
;; Public: Close deposits (transition from deposit to buffer phase)
;; ============================================================================

;; Anyone can close deposits after DEPOSIT_MIN_BLOCKS have passed.
;; Deposits stay open until someone calls this - more time for liquidity.
(define-public (close-deposits)
  (let (
    (elapsed (get-blocks-elapsed))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_ALREADY_CLOSED)
    (asserts! (>= elapsed DEPOSIT_MIN_BLOCKS) ERR_CLOSE_TOO_EARLY)

    (var-set deposits-closed-block stacks-block-height)

    (print { event: "close-deposits",
             cycle: (var-get current-cycle),
             closed-at-block: stacks-block-height,
             elapsed-blocks: elapsed })
    (ok true)))

;; ============================================================================
;; Public: Settlement (settle phase, open-ended until success)
;; ============================================================================

;; Settle using stored Pyth prices (free). Try this first.
(define-public (settle)
  (let (
    (btc-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price BTC_USD_FEED) ERR_ZERO_PRICE))
    (stx-feed (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price STX_USD_FEED) ERR_ZERO_PRICE))
    (cycle (var-get current-cycle))
  )
    (try! (execute-settlement cycle btc-feed stx-feed))
    (map distribute-to-stx-depositor (get-stx-depositors cycle))
    (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
    (advance-cycle)
    (ok true)))

;; Settle with fresh Pyth VAAs when stored prices are stale (~2 uSTX).
(define-public (settle-with-refresh
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
      (cycle (var-get current-cycle))
    )
      (try! (execute-settlement cycle btc-feed stx-feed))
      (map distribute-to-stx-depositor (get-stx-depositors cycle))
      (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
      (advance-cycle)
      (ok true))))

;; ============================================================================
;; Public: Cancel cycle (after CANCEL_THRESHOLD blocks without settlement)
;; ============================================================================

;; Anyone can cancel if settlement has failed for too long.
;; Rolls all deposits into the next cycle (no refunds needed).
;; Users can individually withdraw during the next deposit phase.
(define-public (cancel-cycle)
  (let (
    (cycle (var-get current-cycle))
    (closed-block (var-get deposits-closed-block))
    (totals (get-cycle-totals cycle))
    (next-cycle (+ cycle u1))
    (next-totals (get-cycle-totals next-cycle))
  )
    (asserts! (> closed-block u0) ERR_NOT_SETTLE_PHASE)
    (asserts! (>= stacks-block-height
                  (+ closed-block BUFFER_BLOCKS CANCEL_THRESHOLD))
              ERR_CANCEL_TOO_EARLY)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)

    ;; Roll totals to next cycle
    (map-set cycle-totals next-cycle
      { total-stx: (+ (get total-stx next-totals) (get total-stx totals)),
        total-sbtc: (+ (get total-sbtc next-totals) (get total-sbtc totals)) })

    ;; Roll individual deposits to next cycle
    (var-set settle-cycle cycle)
    (map roll-stx-depositor (get-stx-depositors cycle))
    (map roll-sbtc-depositor (get-sbtc-depositors cycle))

    ;; Roll depositor lists to next cycle
    (roll-depositor-lists cycle)

    ;; Advance to next cycle (deposit phase starts)
    (advance-cycle)

    (print { event: "cancel-cycle", cycle: cycle, next-cycle: next-cycle,
             stx-rolled: (get total-stx totals),
             sbtc-rolled: (get total-sbtc totals) })
    (ok next-cycle)))

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
    (totals (get-cycle-totals cycle))
    (total-stx (get total-stx totals))
    (total-sbtc (get total-sbtc totals))

    (btc-price (to-uint (get price btc-feed)))
    (stx-price (to-uint (get price stx-feed)))
    (oracle-price (/ (* btc-price PRICE_PRECISION) stx-price))

    (dex-price (get-dex-price))

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
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (asserts! (and (>= total-stx (var-get min-stx-deposit))
                   (>= total-sbtc (var-get min-sbtc-deposit))) ERR_NOTHING_TO_SETTLE)
    (asserts! (> btc-price u0) ERR_ZERO_PRICE)
    (asserts! (> stx-price u0) ERR_ZERO_PRICE)

    ;; Gate 1: Staleness
    (asserts! (> (get publish-time btc-feed) (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
    (asserts! (> (get publish-time stx-feed) (- stacks-block-time MAX_STALENESS)) ERR_STALE_PRICE)
    ;; Gate 2: Confidence < 2%
    (asserts! (< (get conf btc-feed) (/ btc-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
    (asserts! (< (get conf stx-feed) (/ stx-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
    ;; Gate 3: DEX sanity < 10%
    (asserts! (< (if (> oracle-price dex-price) (- oracle-price dex-price) (- dex-price oracle-price))
                 (/ oracle-price MAX_DEX_DEVIATION)) ERR_PRICE_DEX_DIVERGENCE)

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
    (my-sbtc-received (if (> total-stx u0) (/ (* my-deposit (var-get settle-sbtc-after-fee)) total-stx) u0))
    (my-stx-unfilled (if (> total-stx u0) (/ (* my-deposit (- total-stx (var-get settle-stx-cleared))) total-stx) u0))
    (next-cycle (+ cycle u1))
  )
    (if (is-eq my-deposit u0) true
      (begin
        (map-delete stx-deposits { cycle: cycle, depositor: depositor })

        (if (> my-sbtc-received u0)
          (match (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer my-sbtc-received current-contract depositor none)
            success true
            error true)
          true)

        (if (> my-stx-unfilled u0)
          (begin
            (map-set stx-deposits
              { cycle: next-cycle, depositor: depositor } my-stx-unfilled)
            (let ((next-list (get-stx-depositors next-cycle)))
              (if (< (len next-list) MAX_DEPOSITORS)
                (map-set stx-depositor-list next-cycle
                  (unwrap-panic (as-max-len? (append next-list depositor) u50)))
                true)))
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
    (my-stx-received (if (> total-sbtc u0) (/ (* my-deposit (var-get settle-stx-after-fee)) total-sbtc) u0))
    (my-sbtc-unfilled (if (> total-sbtc u0) (/ (* my-deposit (- total-sbtc (var-get settle-sbtc-cleared))) total-sbtc) u0))
    (next-cycle (+ cycle u1))
  )
    (if (is-eq my-deposit u0) true
      (begin
        (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })

        (if (> my-stx-received u0)
          (match (stx-transfer? my-stx-received current-contract depositor)
            success true
            error true)
          true)

        (if (> my-sbtc-unfilled u0)
          (begin
            (map-set sbtc-deposits
              { cycle: next-cycle, depositor: depositor } my-sbtc-unfilled)
            (let ((next-list (get-sbtc-depositors next-cycle)))
              (if (< (len next-list) MAX_DEPOSITORS)
                (map-set sbtc-depositor-list next-cycle
                  (unwrap-panic (as-max-len? (append next-list depositor) u50)))
                true)))
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
  (let ((pool (unwrap-panic (contract-call?
    'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
    get-pool))))
    (/ (* (get y-balance pool) u100 PRICE_PRECISION) (get x-balance pool))))

(define-read-only (get-dlmm-price)
  (let ((pool (unwrap-panic (contract-call?
    'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15
    get-pool))))
    (unwrap-panic (contract-call?
      'SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1
      get-bin-price (get initial-price pool) (get bin-step pool) (get active-bin-id pool)))))

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
