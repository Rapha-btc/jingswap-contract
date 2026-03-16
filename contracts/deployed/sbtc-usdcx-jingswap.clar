;; SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-usdcx-jingswap

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
(define-data-var min-usdcx-deposit uint u1000000)
(define-data-var min-sbtc-deposit uint u1000)
(define-data-var current-cycle uint u0)
(define-data-var cycle-start-block uint stacks-block-height)

(define-data-var deposits-closed-block uint u0)

(define-data-var settle-usdcx-cleared uint u0)
(define-data-var settle-sbtc-cleared uint u0)
(define-data-var settle-total-usdcx uint u0)
(define-data-var settle-total-sbtc uint u0)
(define-data-var settle-sbtc-after-fee uint u0)
(define-data-var settle-usdcx-after-fee uint u0)
(define-data-var bumped-usdcx-principal principal tx-sender)
(define-data-var bumped-sbtc-principal principal tx-sender)

(define-map usdcx-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map sbtc-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map usdcx-depositor-list
  uint
  (list 50 principal))

(define-map sbtc-depositor-list
  uint
  (list 50 principal))

(define-map cycle-totals
  uint
  { total-usdcx: uint, total-sbtc: uint })

(define-map settlements
  uint
  { price: uint,
    usdcx-cleared: uint,
    sbtc-cleared: uint,
    usdcx-fee: uint,
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
  (default-to { total-usdcx: u0, total-sbtc: u0 }
    (map-get? cycle-totals cycle)))

(define-read-only (get-settlement (cycle uint))
  (map-get? settlements cycle))

(define-read-only (get-usdcx-deposit (cycle uint) (depositor principal))
  (default-to u0 (map-get? usdcx-deposits { cycle: cycle, depositor: depositor })))

(define-read-only (get-sbtc-deposit (cycle uint) (depositor principal))
  (default-to u0 (map-get? sbtc-deposits { cycle: cycle, depositor: depositor })))

(define-read-only (get-usdcx-depositors (cycle uint))
  (default-to (list) (map-get? usdcx-depositor-list cycle)))

(define-read-only (get-sbtc-depositors (cycle uint))
  (default-to (list) (map-get? sbtc-depositor-list cycle)))

(define-read-only (get-dex-source)
  (var-get dex-source))

(define-read-only (get-min-deposits)
  { min-usdcx: (var-get min-usdcx-deposit), min-sbtc: (var-get min-sbtc-deposit) })

(define-private (advance-cycle)
  (begin
    (var-set current-cycle (+ (var-get current-cycle) u1))
    (var-set cycle-start-block stacks-block-height)
    (var-set deposits-closed-block u0)))

(define-private (find-smallest-usdcx-fold
  (depositor principal)
  (acc { cycle: uint, smallest: uint, smallest-principal: principal }))
  (let ((amount (get-usdcx-deposit (get cycle acc) depositor)))
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

(define-private (not-eq-bumped-usdcx (entry principal))
  (not (is-eq entry (var-get bumped-usdcx-principal))))

(define-private (not-eq-bumped-sbtc (entry principal))
  (not (is-eq entry (var-get bumped-sbtc-principal))))
(define-private (roll-usdcx-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set usdcx-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-usdcx-deposit cycle depositor))
    (map-delete usdcx-deposits { cycle: cycle, depositor: depositor })))

(define-private (roll-sbtc-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set sbtc-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-sbtc-deposit cycle depositor))
    (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })))
(define-private (roll-depositor-lists (cycle uint))
  (begin
    (map-set usdcx-depositor-list (+ cycle u1) (get-usdcx-depositors cycle))
    (map-set sbtc-depositor-list (+ cycle u1) (get-sbtc-depositors cycle))
    (map-delete usdcx-depositor-list cycle)
    (map-delete sbtc-depositor-list cycle)))

(define-public (deposit-usdcx (amount uint))
  (let (
    (cycle (var-get current-cycle))
    (existing (get-usdcx-deposit cycle tx-sender))
    (totals (get-cycle-totals cycle))
    (depositors (get-usdcx-depositors cycle))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-usdcx-deposit)) ERR_DEPOSIT_TOO_SMALL)

    (if (and (is-eq existing u0) (>= (len depositors) MAX_DEPOSITORS))
      (let (
        (smallest-info (fold find-smallest-usdcx-fold depositors
          { cycle: cycle, smallest: u999999999999999999, smallest-principal: tx-sender }))
        (smallest-amount (get smallest smallest-info))
        (smallest-who (get smallest-principal smallest-info))
      )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (try! (as-contract? ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx "usdcx-token" smallest-amount))
            (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
                    transfer smallest-amount current-contract smallest-who none))))
        (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
                    transfer amount tx-sender current-contract none))
        (var-set bumped-usdcx-principal smallest-who)
        (map-set usdcx-depositor-list cycle
          (unwrap-panic (as-max-len? (append (filter not-eq-bumped-usdcx depositors) tx-sender) u50)))
        (map-delete usdcx-deposits { cycle: cycle, depositor: smallest-who })
        (map-set usdcx-deposits { cycle: cycle, depositor: tx-sender } amount)
        (map-set cycle-totals cycle
          (merge totals { total-usdcx: (+ (- (get total-usdcx totals) smallest-amount) amount) }))
        (print { event: "deposit-usdcx", depositor: tx-sender, amount: amount, cycle: cycle,
                 bumped: smallest-who, bumped-amount: smallest-amount })
        (ok amount))
      (begin
        (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
          transfer amount tx-sender current-contract none))
        (map-set usdcx-deposits { cycle: cycle, depositor: tx-sender } (+ existing amount))
        (map-set cycle-totals cycle
          (merge totals { total-usdcx: (+ (get total-usdcx totals) amount) }))
        (if (is-eq existing u0)
          (map-set usdcx-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          true)
        (print { event: "deposit-usdcx", depositor: tx-sender, amount: (+ existing amount), cycle: cycle })
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

(define-public (cancel-usdcx-deposit)
  (let (
    (cycle (var-get current-cycle))
    (caller tx-sender)
    (amount (get-usdcx-deposit cycle caller))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (try! (as-contract? ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx "usdcx-token" amount))
        (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
                    transfer amount current-contract caller none))))
    (map-delete usdcx-deposits { cycle: cycle, depositor: caller })
    (var-set bumped-usdcx-principal caller)
    (map-set usdcx-depositor-list cycle (filter not-eq-bumped-usdcx (get-usdcx-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-usdcx: (- (get total-usdcx totals) amount) }))
    (print { event: "refund-usdcx", depositor: caller, amount: amount, cycle: cycle })
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

(define-public (close-deposits)
  (let (
    (elapsed (get-blocks-elapsed))
    (totals (get-cycle-totals (var-get current-cycle)))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_ALREADY_CLOSED)
    (asserts! (>= elapsed DEPOSIT_MIN_BLOCKS) ERR_CLOSE_TOO_EARLY)
    (asserts! (and (>= (get total-usdcx totals) (var-get min-usdcx-deposit))
                   (>= (get total-sbtc totals) (var-get min-sbtc-deposit))) ERR_NOTHING_TO_SETTLE)
    (var-set deposits-closed-block stacks-block-height)
    (print { event: "close-deposits",
             cycle: (var-get current-cycle),
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
    (map distribute-to-usdcx-depositor (get-usdcx-depositors cycle))
    (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
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
    (if (is-eq (var-get dex-source) DEX_SOURCE_XYK)
      (try! (contract-call?
        'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
        verify-and-update-price-feeds stx-vaa
        { pyth-storage-contract: pyth-storage,
          pyth-decoder-contract: pyth-decoder,
          wormhole-core-contract: wormhole-core }))
      true)
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
      (map distribute-to-usdcx-depositor (get-usdcx-depositors cycle))
      (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
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
    (map roll-usdcx-depositor (get-usdcx-depositors cycle))
    (map roll-sbtc-depositor (get-sbtc-depositors cycle))
    (roll-depositor-lists cycle)
    (advance-cycle)
    (print { event: "cancel-cycle", cycle: cycle,
             usdcx-rolled: (get total-usdcx totals),
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
    (total-usdcx (get total-usdcx totals))
    (total-sbtc (get total-sbtc totals))
    (btc-price (to-uint (get price btc-feed)))
    (stx-price (to-uint (get price stx-feed)))
    (oracle-price btc-price)
    (dex-price (get-dex-price stx-price))
    (usdcx-value-of-sbtc (/ (* total-sbtc oracle-price) (* PRICE_PRECISION DECIMAL_FACTOR)))
    (sbtc-is-binding (<= usdcx-value-of-sbtc total-usdcx))
    (usdcx-clearing (if sbtc-is-binding usdcx-value-of-sbtc total-usdcx))
    (sbtc-clearing (if sbtc-is-binding total-sbtc (/ (* total-usdcx (* PRICE_PRECISION DECIMAL_FACTOR)) oracle-price)))
    (usdcx-fee (/ (* usdcx-clearing FEE_BPS) BPS_PRECISION))
    (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
    (usdcx-unfilled (- total-usdcx usdcx-clearing))
    (sbtc-unfilled (- total-sbtc sbtc-clearing))
    (min-freshness (- stacks-block-time MAX_STALENESS))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (asserts! (and (>= total-usdcx (var-get min-usdcx-deposit))
                   (>= total-sbtc (var-get min-sbtc-deposit))) ERR_NOTHING_TO_SETTLE)
    (asserts! (> btc-price u0) ERR_ZERO_PRICE)

    (asserts! (> (get publish-time btc-feed) min-freshness) ERR_STALE_PRICE)

    (asserts! (< (get conf btc-feed) (/ btc-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)

    (if (is-eq (var-get dex-source) DEX_SOURCE_XYK)
      (begin
        (asserts! (> stx-price u0) ERR_ZERO_PRICE)
        (asserts! (> (get publish-time stx-feed) min-freshness) ERR_STALE_PRICE)
        (asserts! (< (get conf stx-feed) (/ stx-price MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
        true)
      true)

    (asserts! (< (if (> oracle-price dex-price)
                    (- oracle-price dex-price) (- dex-price oracle-price))
                 (/ oracle-price MAX_DEX_DEVIATION)) ERR_PRICE_DEX_DIVERGENCE)

    (map-set settlements cycle
      { price: oracle-price,
        usdcx-cleared: usdcx-clearing,
        sbtc-cleared: sbtc-clearing,
        usdcx-fee: usdcx-fee,
        sbtc-fee: sbtc-fee,
        settled-at: stacks-block-height })

    (if (> usdcx-fee u0)
      (try! (as-contract? ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx "usdcx-token" usdcx-fee))
        (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
              transfer usdcx-fee current-contract (var-get treasury) none)))
      true)
    (if (> sbtc-fee u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-fee))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
         transfer sbtc-fee current-contract (var-get treasury) none))))
      true)

    (map-set cycle-totals (+ cycle u1)
      { total-usdcx: usdcx-unfilled, total-sbtc: sbtc-unfilled })

    (var-set settle-usdcx-cleared usdcx-clearing)
    (var-set settle-sbtc-cleared sbtc-clearing)
    (var-set settle-total-usdcx total-usdcx)
    (var-set settle-total-sbtc total-sbtc)
    (var-set settle-sbtc-after-fee (- sbtc-clearing sbtc-fee))
    (var-set settle-usdcx-after-fee (- usdcx-clearing usdcx-fee))
    (print {
      event: "settlement",
      cycle: cycle,
      price: oracle-price,
      usdcx-cleared: usdcx-clearing,
      sbtc-cleared: sbtc-clearing,
      usdcx-unfilled: usdcx-unfilled,
      sbtc-unfilled: sbtc-unfilled,
      usdcx-fee: usdcx-fee,
      sbtc-fee: sbtc-fee,
      binding-side: (if sbtc-is-binding "sbtc" "usdcx")
    })
    (ok true)))

(define-private (distribute-to-usdcx-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (my-deposit (get-usdcx-deposit cycle depositor))
    (total-usdcx (var-get settle-total-usdcx))
    (my-sbtc-received (if (> total-usdcx u0) (/ (* my-deposit (var-get settle-sbtc-after-fee)) total-usdcx) u0))
    (my-usdcx-unfilled (if (> total-usdcx u0) (/ (* my-deposit (- total-usdcx (var-get settle-usdcx-cleared))) total-usdcx) u0))
    (next-cycle (+ cycle u1))
  )
    (map-delete usdcx-deposits { cycle: cycle, depositor: depositor })
    (if (> my-sbtc-received u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" my-sbtc-received))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer my-sbtc-received current-contract depositor none))))
      true)
    (if (> my-usdcx-unfilled u0)
      (begin
        (map-set usdcx-deposits
          { cycle: next-cycle, depositor: depositor } my-usdcx-unfilled)
        (map-set usdcx-depositor-list next-cycle
              (unwrap-panic (as-max-len? (append (get-usdcx-depositors next-cycle) depositor) u50)))
        true)
      true)
    (print {
      event: "distribute-usdcx-depositor",
      depositor: depositor,
      cycle: cycle,
      sbtc-received: my-sbtc-received,
      usdcx-rolled: my-usdcx-unfilled
    })
    (ok true)))

(define-private (distribute-to-sbtc-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (my-deposit (get-sbtc-deposit cycle depositor))
    (total-sbtc (var-get settle-total-sbtc))
    (my-usdcx-received (if (> total-sbtc u0) (/ (* my-deposit (var-get settle-usdcx-after-fee)) total-sbtc) u0))
    (my-sbtc-unfilled (if (> total-sbtc u0) (/ (* my-deposit (- total-sbtc (var-get settle-sbtc-cleared))) total-sbtc) u0))
    (next-cycle (+ cycle u1))
  )
    (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })
    (if (> my-usdcx-received u0)
      (try! (as-contract? ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx "usdcx-token" my-usdcx-received))
        (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
                transfer my-usdcx-received current-contract depositor none))))
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
      usdcx-received: my-usdcx-received,
      sbtc-rolled: my-sbtc-unfilled
    })
    (ok true)))

(define-read-only (get-dex-price (stx-price uint))
  (if (is-eq (var-get dex-source) DEX_SOURCE_XYK)
    (/ (* (get-xyk-price) stx-price) PRICE_PRECISION)
    (get-dlmm-price)))

(define-read-only (get-xyk-price)
  (let ((pool (unwrap-panic (contract-call?
    'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
    get-pool))))
    (/ (* (get y-balance pool) u100 PRICE_PRECISION) (get x-balance pool))))

(define-read-only (get-dlmm-price)
  (let ((pool (unwrap-panic (contract-call?
    'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
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

(define-public (set-min-usdcx-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-usdcx-deposit amount))))

(define-public (set-min-sbtc-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-sbtc-deposit amount))))
