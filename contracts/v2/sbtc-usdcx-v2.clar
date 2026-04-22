;; sbtc-usdcx-jing-v2 with limit-pricing (ported from sbtc-stx v1->v2 diff).
;; Oracle-price is BTC/USD from Pyth (8-dec), same unit as user-supplied limit.
;; STX feed is only used (and validated) when dex-source is XYK.
(use-trait pyth-storage-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.storage-trait)
(use-trait pyth-decoder-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-traits-v2.core-trait)

(define-constant CANCEL_THRESHOLD u42)

(define-constant PHASE_DEPOSIT u0)
(define-constant PHASE_SETTLE u2)

(define-constant MAX_DEPOSITORS u50)
(define-constant FEE_BPS u10)
(define-constant BPS_PRECISION u10000)
(define-constant MIN_SHARE_BPS u20)

(define-constant PRICE_PRECISION u100000000)

(define-constant DECIMAL_FACTOR u100)

(define-constant BTC_USD_FEED 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43)
(define-constant STX_USD_FEED 0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17)

(define-constant MAX_STALENESS u999999999)
(define-constant MAX_CONF_RATIO u50)
(define-constant MAX_DEX_DEVIATION u10)

(define-constant DEX_SOURCE_XYK u1)
(define-constant DEX_SOURCE_DLMM u2)

;; Token pair -- passed to jing-core on every log-* call so the registry
;; can aggregate across markets without hard-coding assets.
(define-constant TOKEN_X 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant TOKEN_Y 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx)

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
(define-constant ERR_ALREADY_CLOSED (err u1016))
(define-constant ERR_LIMIT_REQUIRED (err u1017))

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

(define-data-var acc-sbtc-out uint u0)
(define-data-var acc-usdcx-out uint u0)
(define-data-var acc-usdcx-rolled uint u0)
(define-data-var acc-sbtc-rolled uint u0)

;; Per-call caller outcome snapshot. Populated during distribute-to-* when the
;; iterated depositor matches tx-sender, so settle can return the caller's fill
;; in its response tuple and enable atomic DeFi composition. `cleared` is
;; omitted — the caller already knows its own deposit and can derive it.
(define-data-var caller-sbtc-received uint u0)
(define-data-var caller-usdcx-rolled uint u0)
(define-data-var caller-usdcx-received uint u0)
(define-data-var caller-sbtc-rolled uint u0)

(define-data-var settle-clearing-price uint u0)

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

(define-map usdcx-deposit-limits principal uint)
(define-map sbtc-deposit-limits principal uint)

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
      PHASE_SETTLE)))

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

(define-read-only (get-usdcx-limit (depositor principal))
  (default-to u0 (map-get? usdcx-deposit-limits depositor)))

(define-read-only (get-sbtc-limit (depositor principal))
  (default-to u0 (map-get? sbtc-deposit-limits depositor)))

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

(define-public (deposit-usdcx (amount uint) (limit-price uint))
  (let (
    (cycle (var-get current-cycle))
    (existing (get-usdcx-deposit cycle tx-sender))
    (totals (get-cycle-totals cycle))
    (depositors (get-usdcx-depositors cycle))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-usdcx-deposit)) ERR_DEPOSIT_TOO_SMALL)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)

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
        (map-delete usdcx-deposit-limits smallest-who)
        (map-set usdcx-deposits { cycle: cycle, depositor: tx-sender } amount)
        (map-set usdcx-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-usdcx: (+ (- (get total-usdcx totals) smallest-amount) amount) }))
        (try! (contract-call? .jing-core log-deposit-y
                tx-sender amount amount limit-price cycle
                (some smallest-who) smallest-amount
                TOKEN_X TOKEN_Y))
        (ok amount))
      (begin
        (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
          transfer amount tx-sender current-contract none))
        (map-set usdcx-deposits { cycle: cycle, depositor: tx-sender } (+ existing amount))
        (map-set usdcx-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-usdcx: (+ (get total-usdcx totals) amount) }))
        (if (is-eq existing u0)
          (map-set usdcx-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          true)
        (try! (contract-call? .jing-core log-deposit-y
                tx-sender (+ existing amount) amount limit-price cycle
                none u0
                TOKEN_X TOKEN_Y))
        (ok amount)))))

(define-public (deposit-sbtc (amount uint) (limit-price uint))
  (let (
    (cycle (var-get current-cycle))
    (existing (get-sbtc-deposit cycle tx-sender))
    (totals (get-cycle-totals cycle))
    (depositors (get-sbtc-depositors cycle))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-sbtc-deposit)) ERR_DEPOSIT_TOO_SMALL)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
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
        (map-delete sbtc-deposit-limits smallest-who)
        (map-set sbtc-deposits { cycle: cycle, depositor: tx-sender } amount)
        (map-set sbtc-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-sbtc: (+ (- (get total-sbtc totals) smallest-amount) amount) }))
        (try! (contract-call? .jing-core log-deposit-x
                tx-sender amount amount limit-price cycle
                (some smallest-who) smallest-amount
                TOKEN_X TOKEN_Y))
        (ok amount))
      (begin
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer amount tx-sender current-contract none))
        (map-set sbtc-deposits { cycle: cycle, depositor: tx-sender } (+ existing amount))
        (map-set sbtc-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-sbtc: (+ (get total-sbtc totals) amount) }))
        (if (is-eq existing u0)
          (map-set sbtc-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          true)
        (try! (contract-call? .jing-core log-deposit-x
                tx-sender (+ existing amount) amount limit-price cycle
                none u0
                TOKEN_X TOKEN_Y))
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
    (map-delete usdcx-deposit-limits caller)
    (var-set bumped-usdcx-principal caller)
    (map-set usdcx-depositor-list cycle (filter not-eq-bumped-usdcx (get-usdcx-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-usdcx: (- (get total-usdcx totals) amount) }))
    (try! (contract-call? .jing-core log-refund-y
            caller amount cycle TOKEN_X TOKEN_Y))
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
    (map-delete sbtc-deposit-limits caller)
    (var-set bumped-sbtc-principal caller)
    (map-set sbtc-depositor-list cycle (filter not-eq-bumped-sbtc (get-sbtc-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))
    (try! (contract-call? .jing-core log-refund-x
            caller amount cycle TOKEN_X TOKEN_Y))
    (ok amount)))

(define-public (set-usdcx-limit (limit-price uint))
  (begin
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> (get-usdcx-deposit (var-get current-cycle) tx-sender) u0)
              ERR_NOTHING_TO_WITHDRAW)
    (map-set usdcx-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core log-set-limit-y
            tx-sender limit-price TOKEN_X TOKEN_Y))
    (ok true)))

(define-public (set-sbtc-limit (limit-price uint))
  (begin
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> (get-sbtc-deposit (var-get current-cycle) tx-sender) u0)
              ERR_NOTHING_TO_WITHDRAW)
    (map-set sbtc-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core log-set-limit-x
            tx-sender limit-price TOKEN_X TOKEN_Y))
    (ok true)))

(define-private (filter-small-usdcx-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (total-usdcx (get total-usdcx totals))
    (amount (get-usdcx-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
  )
    (if (< (* amount BPS_PRECISION) (* total-usdcx MIN_SHARE_BPS))
      (begin
        (map-set usdcx-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set usdcx-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-usdcx-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-usdcx: (+ (get total-usdcx totals-next) amount) }))
        (map-delete usdcx-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-usdcx-principal depositor)
        (map-set usdcx-depositor-list cycle
          (filter not-eq-bumped-usdcx (get-usdcx-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-usdcx: (- total-usdcx amount) }))
        (try! (contract-call? .jing-core log-small-share-roll-y
                depositor cycle amount TOKEN_X TOKEN_Y))
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
        (try! (contract-call? .jing-core log-small-share-roll-x
                depositor cycle amount TOKEN_X TOKEN_Y))
        (ok true))
      (ok true))))

;; USDCx-side depositor is buying sBTC with USDCx; roll if clearing (USDCx/BTC * 1e8)
;; exceeds the price they were willing to pay.
(define-private (filter-limit-violating-usdcx-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (amount (get-usdcx-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
    (limit (get-usdcx-limit depositor))
    (clearing (var-get settle-clearing-price))
  )
    (if (> clearing limit)
      (begin
        (map-set usdcx-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set usdcx-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-usdcx-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-usdcx: (+ (get total-usdcx totals-next) amount) }))
        (map-delete usdcx-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-usdcx-principal depositor)
        (map-set usdcx-depositor-list cycle
          (filter not-eq-bumped-usdcx (get-usdcx-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-usdcx: (- (get total-usdcx totals) amount) }))
        (try! (contract-call? .jing-core log-limit-roll-y
                depositor cycle amount limit clearing TOKEN_X TOKEN_Y))
        (ok true))
      (ok true))))

;; sBTC-side depositor is selling sBTC for USDCx; roll if clearing falls below
;; the minimum price they were willing to sell at.
(define-private (filter-limit-violating-sbtc-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (amount (get-sbtc-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
    (limit (get-sbtc-limit depositor))
    (clearing (var-get settle-clearing-price))
  )
    (if (< clearing limit)
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
          (merge totals { total-sbtc: (- (get total-sbtc totals) amount) }))
        (try! (contract-call? .jing-core log-limit-roll-x
                depositor cycle amount limit clearing TOKEN_X TOKEN_Y))
        (ok true))
      (ok true))))

(define-public (close-deposits)
  (let (
    (cycle (var-get current-cycle))
    (elapsed (get-blocks-elapsed))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_ALREADY_CLOSED)
    (asserts! (and (>= (get total-usdcx totals) (var-get min-usdcx-deposit))
                   (>= (get total-sbtc totals) (var-get min-sbtc-deposit))) ERR_NOTHING_TO_SETTLE)
    (map filter-small-usdcx-depositor (get-usdcx-depositors cycle))
    (map filter-small-sbtc-depositor (get-sbtc-depositors cycle))
    (var-set deposits-closed-block stacks-block-height)
    (try! (contract-call? .jing-core log-close-deposits
            cycle stacks-block-height elapsed TOKEN_X TOKEN_Y))
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
    (var-set acc-usdcx-out u0)
    (var-set acc-usdcx-rolled u0)
    (var-set acc-sbtc-rolled u0)
    (var-set caller-sbtc-received u0)
    (var-set caller-usdcx-rolled u0)
    (var-set caller-usdcx-received u0)
    (var-set caller-sbtc-rolled u0)
    (map distribute-to-usdcx-depositor (get-usdcx-depositors cycle))
    (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
    (try! (roll-and-sweep-dust))
    (advance-cycle)
    (ok { sbtc-received: (var-get caller-sbtc-received),
          usdcx-rolled: (var-get caller-usdcx-rolled),
          usdcx-received: (var-get caller-usdcx-received),
          sbtc-rolled: (var-get caller-sbtc-rolled) })))

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
      (begin
        (try! (contract-call?
          'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
          verify-and-update-price-feeds stx-vaa
          { pyth-storage-contract: pyth-storage,
            pyth-decoder-contract: pyth-decoder,
            wormhole-core-contract: wormhole-core }))
        true)
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
      (var-set acc-sbtc-out u0)
      (var-set acc-usdcx-out u0)
      (var-set acc-usdcx-rolled u0)
      (var-set acc-sbtc-rolled u0)
      (var-set caller-sbtc-received u0)
      (var-set caller-usdcx-rolled u0)
      (var-set caller-usdcx-received u0)
      (var-set caller-sbtc-rolled u0)
      (map distribute-to-usdcx-depositor (get-usdcx-depositors cycle))
      (map distribute-to-sbtc-depositor (get-sbtc-depositors cycle))
      (try! (roll-and-sweep-dust))
      (advance-cycle)
      (ok { sbtc-received: (var-get caller-sbtc-received),
            usdcx-rolled: (var-get caller-usdcx-rolled),
            usdcx-received: (var-get caller-usdcx-received),
            sbtc-rolled: (var-get caller-sbtc-rolled) }))))

(define-public (close-and-settle-with-refresh
  (btc-vaa (buff 8192))
  (stx-vaa (buff 8192))
  (pyth-storage <pyth-storage-trait>)
  (pyth-decoder <pyth-decoder-trait>)
  (wormhole-core <wormhole-core-trait>))
  (begin
    (try! (close-deposits))
    (settle-with-refresh btc-vaa stx-vaa pyth-storage pyth-decoder wormhole-core)))

(define-public (cancel-cycle)
  (let (
    (cycle (var-get current-cycle))
    (closed-block (var-get deposits-closed-block))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (> closed-block u0) ERR_NOT_SETTLE_PHASE)
    (asserts! (>= stacks-block-height (+ closed-block CANCEL_THRESHOLD))
              ERR_CANCEL_TOO_EARLY)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (map-set cycle-totals (+ cycle u1) totals)
    (map-delete cycle-totals cycle)
    (map roll-usdcx-depositor (get-usdcx-depositors cycle))
    (map roll-sbtc-depositor (get-sbtc-depositors cycle))
    (roll-depositor-lists cycle)
    (advance-cycle)
    (try! (contract-call? .jing-core log-cancel-cycle
            cycle (get total-sbtc totals) (get total-usdcx totals)
            TOKEN_X TOKEN_Y))
    (ok true)))

(define-private (execute-settlement
  (cycle uint)
  (btc-feed { price: int, conf: uint, expo: int, ema-price: int,
              ema-conf: uint, publish-time: uint, prev-publish-time: uint })
  (stx-feed { price: int, conf: uint, expo: int, ema-price: int,
              ema-conf: uint, publish-time: uint, prev-publish-time: uint }))
  (let (
    (btc-price (to-uint (get price btc-feed)))
    (stx-price (to-uint (get price stx-feed)))
    (oracle-price btc-price)
    (dex-price (get-dex-price stx-price))
    (min-freshness (- stacks-block-time MAX_STALENESS))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
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

    (var-set settle-clearing-price oracle-price)
    (map filter-limit-violating-usdcx-depositor (get-usdcx-depositors cycle))
    (map filter-limit-violating-sbtc-depositor (get-sbtc-depositors cycle))
    (let (
      (totals (get-cycle-totals cycle))
      (total-usdcx (get total-usdcx totals))
      (total-sbtc (get total-sbtc totals))
      (usdcx-value-of-sbtc (/ (* total-sbtc oracle-price) (* PRICE_PRECISION DECIMAL_FACTOR)))
      (sbtc-is-binding (<= usdcx-value-of-sbtc total-usdcx))
      (usdcx-clearing (if sbtc-is-binding usdcx-value-of-sbtc total-usdcx))
      (sbtc-clearing (if sbtc-is-binding total-sbtc (/ (* total-usdcx (* PRICE_PRECISION DECIMAL_FACTOR)) oracle-price)))
      (usdcx-fee (/ (* usdcx-clearing FEE_BPS) BPS_PRECISION))
      (sbtc-fee (/ (* sbtc-clearing FEE_BPS) BPS_PRECISION))
      (usdcx-unfilled (- total-usdcx usdcx-clearing))
      (sbtc-unfilled (- total-sbtc sbtc-clearing))
    )
    (asserts! (and (>= total-usdcx (var-get min-usdcx-deposit))
                   (>= total-sbtc (var-get min-sbtc-deposit))) ERR_NOTHING_TO_SETTLE)
    (map-set settlements cycle
      { price: oracle-price,
        usdcx-cleared: usdcx-clearing,
        sbtc-cleared: sbtc-clearing,
        usdcx-fee: usdcx-fee,
        sbtc-fee: sbtc-fee,
        settled-at: stacks-block-height })
    (if (> usdcx-fee u0)
      (try! (as-contract? ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx "usdcx-token" usdcx-fee))
        (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
              transfer usdcx-fee current-contract (var-get treasury) none))))
      true)
    (if (> sbtc-fee u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-fee))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
         transfer sbtc-fee current-contract (var-get treasury) none))))
      true)
    (var-set settle-usdcx-cleared usdcx-clearing)
    (var-set settle-sbtc-cleared sbtc-clearing)
    (var-set settle-total-usdcx total-usdcx)
    (var-set settle-total-sbtc total-sbtc)
    (var-set settle-sbtc-after-fee (- sbtc-clearing sbtc-fee))
    (var-set settle-usdcx-after-fee (- usdcx-clearing usdcx-fee))
    (try! (contract-call? .jing-core log-settlement
            cycle oracle-price oracle-price
            sbtc-clearing usdcx-clearing
            sbtc-unfilled usdcx-unfilled
            sbtc-fee usdcx-fee
            sbtc-is-binding
            TOKEN_X TOKEN_Y))
    (ok true))))

(define-private (distribute-to-usdcx-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (my-deposit (get-usdcx-deposit cycle depositor))
    (total-usdcx (var-get settle-total-usdcx))
    (my-sbtc-received (if (> total-usdcx u0) (/ (* my-deposit (var-get settle-sbtc-after-fee)) total-usdcx) u0))
    (my-usdcx-unfilled (if (> total-usdcx u0) (/ (* my-deposit (- total-usdcx (var-get settle-usdcx-cleared))) total-usdcx) u0))
    (my-usdcx-cleared (- my-deposit my-usdcx-unfilled))
    (next-cycle (+ cycle u1))
  )
    (map-delete usdcx-deposits { cycle: cycle, depositor: depositor })
    (var-set acc-sbtc-out (+ (var-get acc-sbtc-out) my-sbtc-received))
    (var-set acc-usdcx-rolled (+ (var-get acc-usdcx-rolled) my-usdcx-unfilled))
    (if (is-eq depositor tx-sender)
      (begin
        (var-set caller-sbtc-received my-sbtc-received)
        (var-set caller-usdcx-rolled my-usdcx-unfilled)
        true)
      true)
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
      (begin
        (map-delete usdcx-deposit-limits depositor)
        true))
    (try! (contract-call? .jing-core log-distribute-y-depositor
            depositor cycle my-sbtc-received my-usdcx-cleared my-usdcx-unfilled
            TOKEN_X TOKEN_Y))
    (ok true)))

(define-private (distribute-to-sbtc-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (my-deposit (get-sbtc-deposit cycle depositor))
    (total-sbtc (var-get settle-total-sbtc))
    (my-usdcx-received (if (> total-sbtc u0) (/ (* my-deposit (var-get settle-usdcx-after-fee)) total-sbtc) u0))
    (my-sbtc-unfilled (if (> total-sbtc u0) (/ (* my-deposit (- total-sbtc (var-get settle-sbtc-cleared))) total-sbtc) u0))
    (my-sbtc-cleared (- my-deposit my-sbtc-unfilled))
    (next-cycle (+ cycle u1))
  )
    (map-delete sbtc-deposits { cycle: cycle, depositor: depositor })
    (var-set acc-usdcx-out (+ (var-get acc-usdcx-out) my-usdcx-received))
    (var-set acc-sbtc-rolled (+ (var-get acc-sbtc-rolled) my-sbtc-unfilled))
    (if (is-eq depositor tx-sender)
      (begin
        (var-set caller-usdcx-received my-usdcx-received)
        (var-set caller-sbtc-rolled my-sbtc-unfilled)
        true)
      true)
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
      (begin
        (map-delete sbtc-deposit-limits depositor)
        true))
    (try! (contract-call? .jing-core log-distribute-x-depositor
            depositor cycle my-usdcx-received my-sbtc-cleared my-sbtc-unfilled
            TOKEN_X TOKEN_Y))
    (ok true)))

(define-private (roll-and-sweep-dust)
  (let (
    (acc-usdcx-rol (var-get acc-usdcx-rolled))
    (acc-sbtc-rol (var-get acc-sbtc-rolled))
    (usdcx-payout-dust  (- (var-get settle-usdcx-after-fee) (var-get acc-usdcx-out)))
    (usdcx-roll-dust    (- (- (var-get settle-total-usdcx) (var-get settle-usdcx-cleared))
                          acc-usdcx-rol))
    (usdcx-dust         (+ usdcx-payout-dust usdcx-roll-dust))
    (sbtc-payout-dust (- (var-get settle-sbtc-after-fee) (var-get acc-sbtc-out)))
    (sbtc-roll-dust   (- (- (var-get settle-total-sbtc) (var-get settle-sbtc-cleared))
                           acc-sbtc-rol))
    (sbtc-dust        (+ sbtc-payout-dust sbtc-roll-dust))
    (next-cycle       (+ (var-get current-cycle) u1))
    (next-totals      (get-cycle-totals next-cycle))
  )
    (map-set cycle-totals next-cycle
      { total-usdcx: (+ (get total-usdcx next-totals) acc-usdcx-rol),
        total-sbtc: (+ (get total-sbtc next-totals) acc-sbtc-rol) })
    (if (> usdcx-dust u0)
      (try! (as-contract? ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx "usdcx-token" usdcx-dust))
        (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
              transfer usdcx-dust current-contract (var-get treasury) none))))
      true)
    (if (> sbtc-dust u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sbtc-dust))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer sbtc-dust current-contract (var-get treasury) none))))
      true)
    (try! (contract-call? .jing-core log-sweep-dust
            acc-sbtc-rol acc-usdcx-rol
            sbtc-dust sbtc-payout-dust sbtc-roll-dust
            usdcx-dust usdcx-payout-dust usdcx-roll-dust
            TOKEN_X TOKEN_Y))
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

;; NOTE: Unlike sbtc-stx-0-v2 (which inverts via 1e18/bin-price), the
;; sBTC/USDCx DLMM pool has not been re-scale-audited here. Before flipping
;; dex-source to DLMM, verify bin-price units match the BTC/USD * 1e8 oracle
;; scale. See contracts/v2/README-dlmm-price-bug.md for the derivation.
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
