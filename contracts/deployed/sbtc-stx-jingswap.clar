(use-trait pyth-storage-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.storage-trait)
(use-trait pyth-decoder-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-traits-v2.core-trait)
(define-constant DEPOSIT_MIN_BLOCKS u150)

(define-constant BUFFER_BLOCKS u30)
(define-constant CANCEL_THRESHOLD u500)
(define-constant PHASE_DEPOSIT u0)
(define-constant PHASE_BUFFER u1)
(define-constant PHASE_SETTLE u2)
(define-constant MAX_DEPOSITORS u50)
(define-constant FEE_BPS u10)
(define-constant BPS_PRECISION u10000)
(define-constant MIN_SHARE_BPS u20)
(define-constant PRICE_PRECISION u100000000)

(define-constant DECIMAL_FACTOR u100)

(define-constant BTC_USD_FEED 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43)
(define-constant STX_USD_FEED 0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17)
(define-constant MAX_STALENESS u60)
(define-constant MAX_CONF_RATIO u50)
(define-constant MAX_DEX_DEVIATION u10)
(define-constant DEX_SOURCE_XYK u1)
(define-constant DEX_SOURCE_DLMM u2)
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

(define-data-var treasury principal tx-sender)
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var dex-source uint DEX_SOURCE_XYK)
(define-data-var min-stx-deposit uint u1000000)
(define-data-var min-sbtc-deposit uint u1000)
(define-data-var current-cycle uint u0)
(define-data-var cycle-start-block uint stacks-block-height)

(define-data-var deposits-closed-block uint u0)

(define-data-var settle-stx-cleared uint u0)
(define-data-var settle-sbtc-cleared uint u0)
(define-data-var settle-total-stx uint u0)
(define-data-var settle-total-sbtc uint u0)
(define-data-var settle-sbtc-after-fee uint u0)
(define-data-var settle-stx-after-fee uint u0)
(define-data-var acc-sbtc-out uint u0)
(define-data-var acc-stx-out uint u0)
(define-data-var acc-stx-rolled uint u0)
(define-data-var acc-sbtc-rolled uint u0)
(define-data-var bumped-stx-principal principal tx-sender)
(define-data-var bumped-sbtc-principal principal tx-sender)

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

(define-read-only (get-current-cycle)
  (var-get current-cycle))

(define-read-only (get-cycle-start-block)
  (var-get cycle-start-block))

(define-read-only (get-blocks-elapsed)
  (- stacks-block-height (var-get cycle-start-block)))

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

(define-private (advance-cycle)
  (begin
    (var-set current-cycle (+ (var-get current-cycle) u1))
    (var-set cycle-start-block stacks-block-height)
    (var-set deposits-closed-block u0)))

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
(define-private (roll-stx-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set stx-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-stx-deposit cycle depositor))
    (map-delete stx-deposits { cycle: cycle, depositor: depositor })))

(define-private (roll-sbtc-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set sbtc-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-sbtc-deposit cycle depositor))
    (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })))
(define-private (roll-depositor-lists (cycle uint))
  (begin
    (map-set stx-depositor-list (+ cycle u1) (get-stx-depositors cycle))
    (map-set sbtc-depositor-list (+ cycle u1) (get-sbtc-depositors cycle))
    (map-delete stx-depositor-list cycle)
    (map-delete sbtc-depositor-list cycle)))

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
      (let (
        (smallest-info (fold find-smallest-stx-fold depositors
          { cycle: cycle, smallest: u999999999999999999, smallest-principal: tx-sender }))
        (smallest-amount (get smallest smallest-info))
        (smallest-who (get smallest-principal smallest-info))
      )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (try! (as-contract? ((with-stx smallest-amount))
          (try! (stx-transfer? smallest-amount current-contract smallest-who))))
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
        (ok amount)))))

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
      (let (
        (smallest-info (fold find-smallest-sbtc-fold depositors
          { cycle: cycle, smallest: u999999999999999999, smallest-principal: tx-sender }))
        (smallest-amount (get smallest smallest-info))
        (smallest-who (get smallest-principal smallest-info))
      )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" smallest-amount))
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer smallest-amount current-contract smallest-who none))))
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

(define-public (cancel-stx-deposit)
  (let (
    (cycle (var-get current-cycle))
    (caller tx-sender)
    (amount (get-stx-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract caller))))
    (map-delete stx-deposits { cycle: cycle, depositor: caller })
    (var-set bumped-stx-principal caller)
    (map-set stx-depositor-list cycle (filter not-eq-bumped-stx (get-stx-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-stx: (- (get total-stx totals) amount) }))
    (print { event: "refund-stx", depositor: caller, amount: amount, cycle: cycle })
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
    (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" amount))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount current-contract caller none))))
    (map-delete sbtc-deposits { cycle: cycle, depositor: caller })
    (var-set bumped-sbtc-principal caller)
    (map-set sbtc-depositor-list cycle (filter not-eq-bumped-sbtc (get-sbtc-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))
    (print { event: "refund-sbtc", depositor: caller, amount: amount, cycle: cycle })
    (ok amount)))

(define-private (filter-small-stx-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (total-stx (get total-stx totals))
    (amount (get-stx-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
  )
    (if (< (* amount BPS_PRECISION) (* total-stx MIN_SHARE_BPS))
      (begin
        (map-set stx-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set stx-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-stx-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-stx: (+ (get total-stx totals-next) amount) }))
        (map-delete stx-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-stx-principal depositor)
        (map-set stx-depositor-list cycle
          (filter not-eq-bumped-stx (get-stx-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-stx: (- total-stx amount) }))
        (print { event: "small-share-roll-stx", depositor: depositor, cycle: cycle, amount: amount })
        (ok true))
      (ok true))))

(define-private (filter-small-sbtc-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (total-sbtc (get total-sbtc totals))
    (amount (get-sbtc-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
  )
    (if (< (* amount BPS_PRECISION) (* total-sbtc MIN_SHARE_BPS))
      (begin
        (map-set sbtc-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set sbtc-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-sbtc-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-sbtc: (+ (get total-sbtc totals-next) amount) }))
        (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-sbtc-principal depositor)
        (map-set sbtc-depositor-list cycle
          (filter not-eq-bumped-sbtc (get-sbtc-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-sbtc: (- total-sbtc amount) }))
        (print { event: "small-share-roll-sbtc", depositor: depositor, cycle: cycle, amount: amount })
        (ok true))
      (ok true))))

(define-public (close-deposits)
  (let (
    (cycle (var-get current-cycle))
    (elapsed (get-blocks-elapsed))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_ALREADY_CLOSED)
    (asserts! (>= elapsed DEPOSIT_MIN_BLOCKS) ERR_CLOSE_TOO_EARLY)
    (asserts! (and (>= (get total-stx totals) (var-get min-stx-deposit))
                   (>= (get total-sbtc totals) (var-get min-sbtc-deposit))) ERR_NOTHING_TO_SETTLE)
    (map filter-small-stx-depositor (get-stx-depositors cycle))
    (map filter-small-sbtc-depositor (get-sbtc-depositors cycle))
    (var-set deposits-closed-block stacks-block-height)
    (print { event: "close-deposits",
             cycle: cycle,
             closed-at-block: stacks-block-height,
             elapsed-blocks: elapsed })
    (ok true)))

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
    (var-set acc-sbtc-out u0)
    (var-set acc-stx-out u0)
    (var-set acc-stx-rolled u0)
    (var-set acc-sbtc-rolled u0)
    (map distribute-to-stx-depositor (get-stx-depositors cycle))
    (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
    (try! (roll-and-sweep-dust))
    (advance-cycle)
    (ok true)))

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
      (var-set acc-sbtc-out u0)
      (var-set acc-stx-out u0)
      (var-set acc-stx-rolled u0)
      (var-set acc-sbtc-rolled u0)
      (map distribute-to-stx-depositor (get-stx-depositors cycle))
      (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
      (try! (roll-and-sweep-dust))
      (advance-cycle)
      (ok true))))
      
(define-public (cancel-cycle)
  (let (
    (cycle (var-get current-cycle))
    (closed-block (var-get deposits-closed-block))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (> closed-block u0) ERR_NOT_SETTLE_PHASE)
    (asserts! (>= stacks-block-height
                  (+ closed-block BUFFER_BLOCKS CANCEL_THRESHOLD))
              ERR_CANCEL_TOO_EARLY)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (map-set cycle-totals (+ cycle u1) totals)
    (map-delete cycle-totals cycle)
    (map roll-stx-depositor (get-stx-depositors cycle))
    (map roll-sbtc-depositor (get-sbtc-depositors cycle))
    (roll-depositor-lists cycle)
    (advance-cycle)
    (print { event: "cancel-cycle", cycle: cycle,
             stx-rolled: (get total-stx totals),
             sbtc-rolled: (get total-sbtc totals) })
    (ok true)))

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
    (stx-value-of-sbtc (/ (* total-sbtc oracle-price) (* PRICE_PRECISION DECIMAL_FACTOR)))
    (sbtc-is-binding (<= stx-value-of-sbtc total-stx))
    (stx-clearing (if sbtc-is-binding stx-value-of-sbtc total-stx))
    (sbtc-clearing (if sbtc-is-binding total-sbtc (/ (* total-stx (* PRICE_PRECISION DECIMAL_FACTOR)) oracle-price)))
    (stx-fee (/ (* stx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (stx-unfilled (- total-stx stx-clearing))
    (sbtc-unfilled (- total-sbtc sbtc-clearing))
    (min-freshness (- stacks-block-time MAX_STALENESS))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (asserts! (and (>= total-stx (var-get min-stx-deposit))
                   (>= total-sbtc (var-get min-sbtc-deposit))) ERR_NOTHING_TO_SETTLE)
    (asserts! (> btc-price u0) ERR_ZERO_PRICE)
    (asserts! (> stx-price u0) ERR_ZERO_PRICE)

    (asserts! (> (get publish-time btc-feed) min-freshness) ERR_STALE_PRICE)
    (asserts! (> (get publish-time stx-feed) min-freshness) ERR_STALE_PRICE)

    (asserts! (< (get conf btc-feed) (/ btc-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
    (asserts! (< (get conf stx-feed) (/ stx-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)

    (asserts! (< (if (> oracle-price dex-price) 
                    (- oracle-price dex-price) (- dex-price oracle-price))
                 (/ oracle-price MAX_DEX_DEVIATION)) ERR_PRICE_DEX_DIVERGENCE)

    (map-set settlements cycle
      { price: oracle-price,
        stx-cleared: stx-clearing,
        sbtc-cleared: sbtc-clearing,
        stx-fee: stx-fee,
        sbtc-fee: sbtc-fee,
        settled-at: stacks-block-height })

    (if (> stx-fee u0)
      (try! (as-contract? ((with-stx stx-fee))
        (try! (stx-transfer? stx-fee current-contract (var-get treasury)))))
      true)
    (if (> sbtc-fee u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-fee))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
         transfer sbtc-fee current-contract (var-get treasury) none))))
      true)

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

(define-private (distribute-to-stx-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (my-deposit (get-stx-deposit cycle depositor))
    (total-stx (var-get settle-total-stx))
    (my-sbtc-received (if (> total-stx u0) (/ (* my-deposit (var-get settle-sbtc-after-fee)) total-stx) u0))
    (my-stx-unfilled (if (> total-stx u0) (/ (* my-deposit (- total-stx (var-get settle-stx-cleared))) total-stx) u0))
    (next-cycle (+ cycle u1))
  )
    (map-delete stx-deposits { cycle: cycle, depositor: depositor })
    (var-set acc-sbtc-out (+ (var-get acc-sbtc-out) my-sbtc-received))
    (var-set acc-stx-rolled (+ (var-get acc-stx-rolled) my-stx-unfilled))
    (if (> my-sbtc-received u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" my-sbtc-received))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer my-sbtc-received current-contract depositor none))))
      true)
    (if (> my-stx-unfilled u0)
      (begin
        (map-set stx-deposits
          { cycle: next-cycle, depositor: depositor } my-stx-unfilled)
        (map-set stx-depositor-list next-cycle
              (unwrap-panic (as-max-len? (append (get-stx-depositors next-cycle) depositor) u50)))
        true)
      true)
    (print {
      event: "distribute-stx-depositor",
      depositor: depositor,
      cycle: cycle,
      sbtc-received: my-sbtc-received,
      stx-rolled: my-stx-unfilled
    })
    (ok true)))
    
(define-private (distribute-to-sbtc-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (my-deposit (get-sbtc-deposit cycle depositor))
    (total-sbtc (var-get settle-total-sbtc))
    (my-stx-received (if (> total-sbtc u0) (/ (* my-deposit (var-get settle-stx-after-fee)) total-sbtc) u0))
    (my-sbtc-unfilled (if (> total-sbtc u0) (/ (* my-deposit (- total-sbtc (var-get settle-sbtc-cleared))) total-sbtc) u0))
    (next-cycle (+ cycle u1))
  )
    (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })
    (var-set acc-stx-out (+ (var-get acc-stx-out) my-stx-received))
    (var-set acc-sbtc-rolled (+ (var-get acc-sbtc-rolled) my-sbtc-unfilled))
    (if (> my-stx-received u0)
      (try! (as-contract? ((with-stx my-stx-received))
        (try! (stx-transfer? my-stx-received current-contract depositor))))
      true)
    (if (> my-sbtc-unfilled u0)
      (begin
        (map-set sbtc-deposits
          { cycle: next-cycle, depositor: depositor } my-sbtc-unfilled)
        (map-set sbtc-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-sbtc-depositors next-cycle) depositor) u50)))
        true)
      true)
    (print {
      event: "distribute-sbtc-depositor",
      depositor: depositor,
      cycle: cycle,
      stx-received: my-stx-received,
      sbtc-rolled: my-sbtc-unfilled
    })
    (ok true)))

(define-private (roll-and-sweep-dust)
  (let (
    (acc-stx-rol (var-get acc-stx-rolled))
    (acc-sbtc-rol (var-get acc-sbtc-rolled))
    (stx-payout-dust  (- (var-get settle-stx-after-fee) (var-get acc-stx-out)))
    (stx-roll-dust    (- (- (var-get settle-total-stx) (var-get settle-stx-cleared))
                          acc-stx-rol))
    (stx-dust         (+ stx-payout-dust stx-roll-dust))
    (sbtc-payout-dust (- (var-get settle-sbtc-after-fee) (var-get acc-sbtc-out)))
    (sbtc-roll-dust   (- (- (var-get settle-total-sbtc) (var-get settle-sbtc-cleared))
                           acc-sbtc-rol))
    (sbtc-dust        (+ sbtc-payout-dust sbtc-roll-dust))
    (next-cycle       (+ (var-get current-cycle) u1))
    (next-totals      (get-cycle-totals next-cycle))
  )
    (map-set cycle-totals next-cycle
      { total-stx: (+ (get total-stx next-totals) acc-stx-rol),
        total-sbtc: (+ (get total-sbtc next-totals) acc-sbtc-rol) })
    (if (> stx-dust u0)
      (try! (as-contract? ((with-stx stx-dust))
        (try! (stx-transfer? stx-dust current-contract (var-get treasury)))))
      true)
    (if (> sbtc-dust u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-dust))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer sbtc-dust current-contract (var-get treasury) none))))
      true)
    (print { event: "sweep-dust", 
             stx-unfilled: acc-stx-rol,
             sbtc-unfilled: acc-sbtc-rol,
             stx-dust: stx-dust, 
             stx-payout-dust: stx-payout-dust, 
             stx-roll-dust: stx-roll-dust,
             sbtc-dust: sbtc-dust,
             sbtc-payout-dust: sbtc-payout-dust,
             sbtc-roll-dust: sbtc-roll-dust })
    (ok true)))

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