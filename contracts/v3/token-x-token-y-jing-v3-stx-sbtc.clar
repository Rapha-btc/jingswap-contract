;; Generic blind-batch auction template for an FT pair where the cross-rate
;; must be derived from TWO Pyth feeds (e.g. sBTC/STX from BTC/USD and
;; STX/USD because Pyth has no direct BTC/STX feed). Same protocol logic as
;; token-x-token-y-jing-v3; only the price plumbing differs.
;;
;; Both feed IDs are configured at init. Each settle path verifies / reads
;; both VAAs separately and computes oracle-price = (price-x * 1e8) / price-y,
;; yielding "token-y per token-x" at PRICE_PRECISION scale -- same semantic
;; and unit as the single-feed v3 template, so all downstream math
;; (limit-price comparison, clearing, distribution) is unchanged.
;;
;; Freshness and Pyth confidence-ratio gates are asserted on BOTH feeds. No
;; DEX-divergence sanity check -- depositors are protected by their own
;; limit-price + Pyth's confidence/staleness gates. See README-dex-sanity-removal.md.
(use-trait pyth-storage-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.storage-trait)
(use-trait pyth-decoder-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-traits-v2.core-trait)
(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

(define-constant CANCEL_THRESHOLD u42)

(define-constant PHASE_DEPOSIT u0)
(define-constant PHASE_SETTLE u2)

(define-constant MAX_DEPOSITORS u50)
(define-constant FEE_BPS u10)
(define-constant BPS_PRECISION u10000)
(define-constant MIN_SHARE_BPS u20)

(define-constant PRICE_PRECISION u100000000)

(define-constant DECIMAL_FACTOR u100)

(define-constant MAX_STALENESS u999999999)
(define-constant MAX_CONF_RATIO u50)

(define-constant SAINT 'SP000000000000000000002Q6VF78)
(define-constant SAINT_FEED 0x0000000000000000000000000000000000000000000000000000000000000000)

;; Token pair -- passed to jing-core on every log-* call so the registry
;; can aggregate across markets without hard-coding assets. Set once via
;; `initialize` after deployment; immutable thereafter.
(define-data-var token-x principal SAINT)
(define-data-var token-y principal SAINT)
(define-data-var initialized bool false)

;; Pyth feed identifiers for the two USD-quoted legs that compose the
;; cross-rate. Both set once via `initialize`. Convention:
;;   oracle-feed-x = token-x's USD price feed (e.g. BTC/USD for sBTC)
;;   oracle-feed-y = token-y's USD price feed (e.g. STX/USD for STX)
;; Cross-rate (token-y per token-x) is derived as (price-x * 1e8) / price-y.
(define-data-var oracle-feed-x (buff 32) SAINT_FEED)
(define-data-var oracle-feed-y (buff 32) SAINT_FEED)

(define-constant ERR_DEPOSIT_TOO_SMALL (err u1001))
(define-constant ERR_NOT_DEPOSIT_PHASE (err u1002))
(define-constant ERR_NOT_SETTLE_PHASE (err u1003))
(define-constant ERR_ALREADY_SETTLED (err u1004))
(define-constant ERR_STALE_PRICE (err u1005))
(define-constant ERR_PRICE_UNCERTAIN (err u1006))
(define-constant ERR_NOTHING_TO_WITHDRAW (err u1008))
(define-constant ERR_ZERO_PRICE (err u1009))
(define-constant ERR_PAUSED (err u1010))
(define-constant ERR_NOT_AUTHORIZED (err u1011))
(define-constant ERR_NOTHING_TO_SETTLE (err u1012))
(define-constant ERR_QUEUE_FULL (err u1013))
(define-constant ERR_CANCEL_TOO_EARLY (err u1014))
(define-constant ERR_ALREADY_CLOSED (err u1016))
(define-constant ERR_LIMIT_REQUIRED (err u1017))
(define-constant ERR_ALREADY_INITIALIZED (err u1018))
(define-constant ERR_WRONG_TRAIT (err u1019))

(define-data-var treasury principal tx-sender)
(define-data-var operator principal tx-sender)
(define-data-var paused bool false)
(define-data-var min-token-y-deposit uint u0)
(define-data-var min-token-x-deposit uint u0)
(define-data-var current-cycle uint u0)
(define-data-var cycle-start-block uint stacks-block-height)

(define-data-var deposits-closed-block uint u0)

(define-data-var settle-token-y-cleared uint u0)
(define-data-var settle-token-x-cleared uint u0)
(define-data-var settle-total-token-y uint u0)
(define-data-var settle-total-token-x uint u0)
(define-data-var settle-token-x-after-fee uint u0)
(define-data-var settle-token-y-after-fee uint u0)
(define-data-var bumped-token-y-principal principal tx-sender)
(define-data-var bumped-token-x-principal principal tx-sender)

(define-data-var acc-token-x-out uint u0)
(define-data-var acc-token-y-out uint u0)
(define-data-var acc-token-y-rolled uint u0)
(define-data-var acc-token-x-rolled uint u0)

;; Per-call caller outcome snapshot. Populated during distribute-to-* when the
;; iterated depositor matches tx-sender, so settle can return the caller's fill
;; in its response tuple and enable atomic DeFi composition. `cleared` is
;; omitted - the caller already knows its own deposit and can derive it.
(define-data-var caller-token-x-received uint u0)
(define-data-var caller-token-y-rolled uint u0)
(define-data-var caller-token-y-received uint u0)
(define-data-var caller-token-x-rolled uint u0)

(define-data-var settle-clearing-price uint u0)

(define-map token-y-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map token-x-deposits
  { cycle: uint, depositor: principal }
  uint)

(define-map token-y-depositor-list
  uint
  (list 50 principal))

(define-map token-x-depositor-list
  uint
  (list 50 principal))

(define-map cycle-totals
  uint
  { total-token-y: uint, total-token-x: uint })

(define-map settlements
  uint
  { price: uint,
    token-y-cleared: uint,
    token-x-cleared: uint,
    token-y-fee: uint,
    token-x-fee: uint,
    settled-at: uint })

(define-map token-y-deposit-limits principal uint)
(define-map token-x-deposit-limits principal uint)

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
  (default-to { total-token-y: u0, total-token-x: u0 }
    (map-get? cycle-totals cycle)))

(define-read-only (get-settlement (cycle uint))
  (map-get? settlements cycle))

(define-read-only (get-token-y-deposit (cycle uint) (depositor principal))
  (default-to u0 (map-get? token-y-deposits { cycle: cycle, depositor: depositor })))

(define-read-only (get-token-x-deposit (cycle uint) (depositor principal))
  (default-to u0 (map-get? token-x-deposits { cycle: cycle, depositor: depositor })))

(define-read-only (get-token-y-depositors (cycle uint))
  (default-to (list) (map-get? token-y-depositor-list cycle)))

(define-read-only (get-token-x-depositors (cycle uint))
  (default-to (list) (map-get? token-x-depositor-list cycle)))

(define-read-only (get-min-deposits)
  { min-token-y: (var-get min-token-y-deposit), min-token-x: (var-get min-token-x-deposit) })

(define-read-only (get-token-y-limit (depositor principal))
  (default-to u0 (map-get? token-y-deposit-limits depositor)))

(define-read-only (get-token-x-limit (depositor principal))
  (default-to u0 (map-get? token-x-deposit-limits depositor)))

(define-private (advance-cycle)
  (begin
    (var-set current-cycle (+ (var-get current-cycle) u1))
    (var-set cycle-start-block stacks-block-height)
    (var-set deposits-closed-block u0)))

(define-private (find-smallest-token-y-fold
  (depositor principal)
  (acc { cycle: uint, smallest: uint, smallest-principal: principal }))
  (let ((amount (get-token-y-deposit (get cycle acc) depositor)))
    (if (< amount (get smallest acc))
      (merge acc { smallest: amount, smallest-principal: depositor })
      acc)))

(define-private (find-smallest-token-x-fold
  (depositor principal)
  (acc { cycle: uint, smallest: uint, smallest-principal: principal }))
  (let ((amount (get-token-x-deposit (get cycle acc) depositor)))
    (if (< amount (get smallest acc))
      (merge acc { smallest: amount, smallest-principal: depositor })
      acc)))

(define-private (not-eq-bumped-token-y (entry principal))
  (not (is-eq entry (var-get bumped-token-y-principal))))

(define-private (not-eq-bumped-token-x (entry principal))
  (not (is-eq entry (var-get bumped-token-x-principal))))

(define-private (roll-token-y-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set token-y-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-token-y-deposit cycle depositor))
    (map-delete token-y-deposits { cycle: cycle, depositor: depositor })))

(define-private (roll-token-x-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set token-x-deposits { cycle: (+ cycle u1), depositor: depositor }
      (get-token-x-deposit cycle depositor))
    (map-delete token-x-deposits { cycle: cycle, depositor: depositor })))

(define-private (roll-depositor-lists (cycle uint))
  (begin
    (map-set token-y-depositor-list (+ cycle u1) (get-token-y-depositors cycle))
    (map-set token-x-depositor-list (+ cycle u1) (get-token-x-depositors cycle))
    (map-delete token-y-depositor-list cycle)
    (map-delete token-x-depositor-list cycle)))

(define-public (deposit-token-y
  (amount uint) (limit-price uint)
  (t <ft-trait>) (asset-name (string-ascii 128)))
  (let (
    (cycle (var-get current-cycle))
    (existing (get-token-y-deposit cycle tx-sender))
    (totals (get-cycle-totals cycle))
    (depositors (get-token-y-depositors cycle))
    (tok-y (var-get token-y))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-token-y-deposit)) ERR_DEPOSIT_TOO_SMALL)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (is-eq (contract-of t) tok-y) ERR_WRONG_TRAIT)

    (if (and (is-eq existing u0) (>= (len depositors) MAX_DEPOSITORS))
      (let (
        (smallest-info (fold find-smallest-token-y-fold depositors
          { cycle: cycle, smallest: u999999999999999999, smallest-principal: tx-sender }))
        (smallest-amount (get smallest smallest-info))
        (smallest-who (get smallest-principal smallest-info))
      )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (try! (as-contract? ((with-ft (contract-of t) asset-name smallest-amount))
            (try! (contract-call? t transfer smallest-amount current-contract smallest-who none))))
        (try! (contract-call? t transfer amount tx-sender current-contract none))
        (var-set bumped-token-y-principal smallest-who)
        (map-set token-y-depositor-list cycle
          (unwrap-panic (as-max-len? (append (filter not-eq-bumped-token-y depositors) tx-sender) u50)))
        (map-delete token-y-deposits { cycle: cycle, depositor: smallest-who })
        (map-delete token-y-deposit-limits smallest-who)
        (map-set token-y-deposits { cycle: cycle, depositor: tx-sender } amount)
        (map-set token-y-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (+ (- (get total-token-y totals) smallest-amount) amount) }))
        (try! (contract-call? .jing-core log-deposit-y
                tx-sender amount amount limit-price cycle
                (some smallest-who) smallest-amount
                (var-get token-x) tok-y))
        (ok amount))
      (begin
        (try! (contract-call? t transfer amount tx-sender current-contract none))
        (map-set token-y-deposits { cycle: cycle, depositor: tx-sender } (+ existing amount))
        (map-set token-y-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (+ (get total-token-y totals) amount) }))
        (if (is-eq existing u0)
          (map-set token-y-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          true)
        (try! (contract-call? .jing-core log-deposit-y
                tx-sender (+ existing amount) amount limit-price cycle
                none u0
                (var-get token-x) tok-y))
        (ok amount)))))

(define-public (deposit-token-x
  (amount uint) (limit-price uint)
  (t <ft-trait>) (asset-name (string-ascii 128)))
  (let (
    (cycle (var-get current-cycle))
    (existing (get-token-x-deposit cycle tx-sender))
    (totals (get-cycle-totals cycle))
    (depositors (get-token-x-depositors cycle))
    (tok-x (var-get token-x))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-token-x-deposit)) ERR_DEPOSIT_TOO_SMALL)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (is-eq (contract-of t) tok-x) ERR_WRONG_TRAIT)
    (if (and (is-eq existing u0) (>= (len depositors) MAX_DEPOSITORS))
      (let (
        (smallest-info (fold find-smallest-token-x-fold depositors
          { cycle: cycle, smallest: u999999999999999999, smallest-principal: tx-sender }))
        (smallest-amount (get smallest smallest-info))
        (smallest-who (get smallest-principal smallest-info))
      )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (try! (as-contract? ((with-ft (contract-of t) asset-name smallest-amount))
            (try! (contract-call? t transfer smallest-amount current-contract smallest-who none))))
        (try! (contract-call? t transfer amount tx-sender current-contract none))
        (var-set bumped-token-x-principal smallest-who)
        (map-set token-x-depositor-list cycle
          (unwrap-panic (as-max-len? (append (filter not-eq-bumped-token-x depositors) tx-sender) u50)))
        (map-delete token-x-deposits { cycle: cycle, depositor: smallest-who })
        (map-delete token-x-deposit-limits smallest-who)
        (map-set token-x-deposits { cycle: cycle, depositor: tx-sender } amount)
        (map-set token-x-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (+ (- (get total-token-x totals) smallest-amount) amount) }))
        (try! (contract-call? .jing-core log-deposit-x
                tx-sender amount amount limit-price cycle
                (some smallest-who) smallest-amount
                tok-x (var-get token-y)))
        (ok amount))
      (begin
        (try! (contract-call? t transfer amount tx-sender current-contract none))
        (map-set token-x-deposits { cycle: cycle, depositor: tx-sender } (+ existing amount))
        (map-set token-x-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (+ (get total-token-x totals) amount) }))
        (if (is-eq existing u0)
          (map-set token-x-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50)))
          true)
        (try! (contract-call? .jing-core log-deposit-x
                tx-sender (+ existing amount) amount limit-price cycle
                none u0
                tok-x (var-get token-y)))
        (ok amount)))))

(define-public (cancel-token-y-deposit
  (t <ft-trait>) (asset-name (string-ascii 128)))
  (let (
    (cycle (var-get current-cycle))
    (caller tx-sender)
    (amount (get-token-y-deposit cycle caller))
    (totals (get-cycle-totals cycle))
    (tok-y (var-get token-y))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (asserts! (is-eq (contract-of t) tok-y) ERR_WRONG_TRAIT)
    (try! (as-contract? ((with-ft (contract-of t) asset-name amount))
        (try! (contract-call? t transfer amount current-contract caller none))))
    (map-delete token-y-deposits { cycle: cycle, depositor: caller })
    (map-delete token-y-deposit-limits caller)
    (var-set bumped-token-y-principal caller)
    (map-set token-y-depositor-list cycle (filter not-eq-bumped-token-y (get-token-y-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-token-y: (- (get total-token-y totals) amount) }))
    (try! (contract-call? .jing-core log-refund-y
            caller amount cycle (var-get token-x) tok-y))
    (ok amount)))

(define-public (cancel-token-x-deposit
  (t <ft-trait>) (asset-name (string-ascii 128)))
  (let (
    (cycle (var-get current-cycle))
    (caller tx-sender)
    (amount (get-token-x-deposit cycle caller))
    (totals (get-cycle-totals cycle))
    (tok-x (var-get token-x))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (asserts! (is-eq (contract-of t) tok-x) ERR_WRONG_TRAIT)
    (try! (as-contract? ((with-ft (contract-of t) asset-name amount))
      (try! (contract-call? t transfer amount current-contract caller none))))
    (map-delete token-x-deposits { cycle: cycle, depositor: caller })
    (map-delete token-x-deposit-limits caller)
    (var-set bumped-token-x-principal caller)
    (map-set token-x-depositor-list cycle (filter not-eq-bumped-token-x (get-token-x-depositors cycle)))
    (map-set cycle-totals cycle
      (merge totals { total-token-x: (- (get total-token-x totals) amount) }))
    (try! (contract-call? .jing-core log-refund-x
            caller amount cycle tok-x (var-get token-y)))
    (ok amount)))

(define-public (set-token-y-limit (limit-price uint))
  (begin
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> (get-token-y-deposit (var-get current-cycle) tx-sender) u0)
              ERR_NOTHING_TO_WITHDRAW)
    (map-set token-y-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core log-set-limit-y
            tx-sender limit-price (var-get token-x) (var-get token-y)))
    (ok true)))

(define-public (set-token-x-limit (limit-price uint))
  (begin
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> (get-token-x-deposit (var-get current-cycle) tx-sender) u0)
              ERR_NOTHING_TO_WITHDRAW)
    (map-set token-x-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core log-set-limit-x
            tx-sender limit-price (var-get token-x) (var-get token-y)))
    (ok true)))

(define-private (filter-small-token-y-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (total-token-y (get total-token-y totals))
    (amount (get-token-y-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
  )
    (if (< (* amount BPS_PRECISION) (* total-token-y MIN_SHARE_BPS))
      (begin
        (map-set token-y-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set token-y-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-y-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-token-y: (+ (get total-token-y totals-next) amount) }))
        (map-delete token-y-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-token-y-principal depositor)
        (map-set token-y-depositor-list cycle
          (filter not-eq-bumped-token-y (get-token-y-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (- total-token-y amount) }))
        (try! (contract-call? .jing-core log-small-share-roll-y
                depositor cycle amount (var-get token-x) (var-get token-y)))
        (ok true))
      (ok true))))

(define-private (filter-small-token-x-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (total-token-x (get total-token-x totals))
    (amount (get-token-x-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
  )
    (if (< (* amount BPS_PRECISION) (* total-token-x MIN_SHARE_BPS))
      (begin
        (map-set token-x-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set token-x-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-x-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-token-x: (+ (get total-token-x totals-next) amount) }))
        (map-delete token-x-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-token-x-principal depositor)
        (map-set token-x-depositor-list cycle
          (filter not-eq-bumped-token-x (get-token-x-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (- total-token-x amount) }))
        (try! (contract-call? .jing-core log-small-share-roll-x
                depositor cycle amount (var-get token-x) (var-get token-y)))
        (ok true))
      (ok true))))

;; token-y-side depositor is buying token-x with token-y; roll if clearing (token-y/BTC * 1e8)
;; exceeds the price they were willing to pay.
(define-private (filter-limit-violating-token-y-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (amount (get-token-y-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
    (limit (get-token-y-limit depositor))
    (clearing (var-get settle-clearing-price))
  )
    (if (> clearing limit)
      (begin
        (map-set token-y-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set token-y-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-y-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-token-y: (+ (get total-token-y totals-next) amount) }))
        (map-delete token-y-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-token-y-principal depositor)
        (map-set token-y-depositor-list cycle
          (filter not-eq-bumped-token-y (get-token-y-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (- (get total-token-y totals) amount) }))
        (try! (contract-call? .jing-core log-limit-roll-y
                depositor cycle amount limit clearing (var-get token-x) (var-get token-y)))
        (ok true))
      (ok true))))

;; token-x-side depositor is selling token-x for token-y; roll if clearing falls below
;; the minimum price they were willing to sell at.
(define-private (filter-limit-violating-token-x-depositor (depositor principal))
  (let (
    (cycle (var-get current-cycle))
    (totals (get-cycle-totals cycle))
    (amount (get-token-x-deposit cycle depositor))
    (next-cycle (+ cycle u1))
    (totals-next (get-cycle-totals next-cycle))
    (limit (get-token-x-limit depositor))
    (clearing (var-get settle-clearing-price))
  )
    (if (< clearing limit)
      (begin
        (map-set token-x-deposits { cycle: next-cycle, depositor: depositor } amount)
        (map-set token-x-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-x-depositors next-cycle) depositor) u50)))
        (map-set cycle-totals next-cycle
          (merge totals-next
            { total-token-x: (+ (get total-token-x totals-next) amount) }))
        (map-delete token-x-deposits { cycle: cycle, depositor: depositor })
        (var-set bumped-token-x-principal depositor)
        (map-set token-x-depositor-list cycle
          (filter not-eq-bumped-token-x (get-token-x-depositors cycle)))
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (- (get total-token-x totals) amount) }))
        (try! (contract-call? .jing-core log-limit-roll-x
                depositor cycle amount limit clearing (var-get token-x) (var-get token-y)))
        (ok true))
      (ok true))))

(define-public (close-deposits)
  (let (
    (cycle (var-get current-cycle))
    (elapsed (get-blocks-elapsed))
    (totals (get-cycle-totals cycle))
  )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_ALREADY_CLOSED)
    (asserts! (and (>= (get total-token-y totals) (var-get min-token-y-deposit))
                   (>= (get total-token-x totals) (var-get min-token-x-deposit))) ERR_NOTHING_TO_SETTLE)
    (map filter-small-token-y-depositor (get-token-y-depositors cycle))
    (map filter-small-token-x-depositor (get-token-x-depositors cycle))
    (var-set deposits-closed-block stacks-block-height)
    (try! (contract-call? .jing-core log-close-deposits
            cycle stacks-block-height elapsed (var-get token-x) (var-get token-y)))
    (ok true)))

(define-public (settle
  (tx-trait <ft-trait>) (tx-name (string-ascii 128))
  (ty-trait <ft-trait>) (ty-name (string-ascii 128)))
  (let (
    (feed-x (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price (var-get oracle-feed-x)) ERR_ZERO_PRICE))
    (feed-y (unwrap! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
      get-price (var-get oracle-feed-y)) ERR_ZERO_PRICE))
    (cycle (var-get current-cycle))
  )
    (asserts! (is-eq (contract-of tx-trait) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (is-eq (contract-of ty-trait) (var-get token-y)) ERR_WRONG_TRAIT)
    (try! (execute-settlement cycle feed-x feed-y tx-trait tx-name ty-trait ty-name))
    (var-set acc-token-x-out u0)
    (var-set acc-token-y-out u0)
    (var-set acc-token-y-rolled u0)
    (var-set acc-token-x-rolled u0)
    (var-set caller-token-x-received u0)
    (var-set caller-token-y-rolled u0)
    (var-set caller-token-y-received u0)
    (var-set caller-token-x-rolled u0)
    (try! (fold distribute-to-token-y-depositor (get-token-y-depositors cycle)
                (ok { t: tx-trait, name: tx-name })))
    (try! (fold distribute-to-token-x-depositor (get-token-x-depositors cycle)
                (ok { t: ty-trait, name: ty-name })))
    (try! (roll-and-sweep-dust tx-trait tx-name ty-trait ty-name))
    (advance-cycle)
    (ok { token-x-received: (var-get caller-token-x-received),
          token-y-rolled: (var-get caller-token-y-rolled),
          token-y-received: (var-get caller-token-y-received),
          token-x-rolled: (var-get caller-token-x-rolled) })))

(define-public (settle-with-refresh
  (vaa-x (buff 8192))
  (vaa-y (buff 8192))
  (pyth-storage <pyth-storage-trait>)
  (pyth-decoder <pyth-decoder-trait>)
  (wormhole-core <wormhole-core-trait>)
  (tx-trait <ft-trait>) (tx-name (string-ascii 128))
  (ty-trait <ft-trait>) (ty-name (string-ascii 128)))
  (begin
    (asserts! (is-eq (contract-of tx-trait) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (is-eq (contract-of ty-trait) (var-get token-y)) ERR_WRONG_TRAIT)
    (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds vaa-x
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core }))
    (try! (contract-call?
      'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds vaa-y
      { pyth-storage-contract: pyth-storage,
        pyth-decoder-contract: pyth-decoder,
        wormhole-core-contract: wormhole-core }))
    (let (
      (feed-x (unwrap! (contract-call?
        'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
        get-price (var-get oracle-feed-x)) ERR_ZERO_PRICE))
      (feed-y (unwrap! (contract-call?
        'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
        get-price (var-get oracle-feed-y)) ERR_ZERO_PRICE))
      (cycle (var-get current-cycle))
    )
      (try! (execute-settlement cycle feed-x feed-y tx-trait tx-name ty-trait ty-name))
      (var-set acc-token-x-out u0)
      (var-set acc-token-y-out u0)
      (var-set acc-token-y-rolled u0)
      (var-set acc-token-x-rolled u0)
      (var-set caller-token-x-received u0)
      (var-set caller-token-y-rolled u0)
      (var-set caller-token-y-received u0)
      (var-set caller-token-x-rolled u0)
      (try! (fold distribute-to-token-y-depositor (get-token-y-depositors cycle)
                  (ok { t: tx-trait, name: tx-name })))
      (try! (fold distribute-to-token-x-depositor (get-token-x-depositors cycle)
                  (ok { t: ty-trait, name: ty-name })))
      (try! (roll-and-sweep-dust tx-trait tx-name ty-trait ty-name))
      (advance-cycle)
      (ok { token-x-received: (var-get caller-token-x-received),
            token-y-rolled: (var-get caller-token-y-rolled),
            token-y-received: (var-get caller-token-y-received),
            token-x-rolled: (var-get caller-token-x-rolled) }))))

(define-public (close-and-settle-with-refresh
  (vaa-x (buff 8192))
  (vaa-y (buff 8192))
  (pyth-storage <pyth-storage-trait>)
  (pyth-decoder <pyth-decoder-trait>)
  (wormhole-core <wormhole-core-trait>)
  (tx-trait <ft-trait>) (tx-name (string-ascii 128))
  (ty-trait <ft-trait>) (ty-name (string-ascii 128)))
  (begin
    (try! (close-deposits))
    (settle-with-refresh vaa-x vaa-y pyth-storage pyth-decoder wormhole-core
                         tx-trait tx-name ty-trait ty-name)))

;; Atomic taker flow: deposit on one side, close, refresh oracle, settle -- all
;; in one tx. Useful when the OTHER side already has enough liquidity for the
;; depositor to clear immediately. NOT a true AMM swap: clearing price still
;; comes from Pyth, fill is partial if opposite-side liquidity is insufficient,
;; and the depositor's leftover (if any) rolls to next cycle.
;; deposit-x = true  -> caller deposits token-x (sells x for y)
;; deposit-x = false -> caller deposits token-y (sells y for x)
(define-public (swap
  (amount uint) (limit-price uint)
  (vaa-x (buff 8192))
  (vaa-y (buff 8192))
  (pyth-storage <pyth-storage-trait>)
  (pyth-decoder <pyth-decoder-trait>)
  (wormhole-core <wormhole-core-trait>)
  (tx-trait <ft-trait>) (tx-name (string-ascii 128))
  (ty-trait <ft-trait>) (ty-name (string-ascii 128))
  (deposit-x bool))
  (begin
    (try! (if deposit-x
            (deposit-token-x amount limit-price tx-trait tx-name)
            (deposit-token-y amount limit-price ty-trait ty-name)))
    (try! (close-deposits))
    (settle-with-refresh vaa-x vaa-y pyth-storage pyth-decoder wormhole-core
                         tx-trait tx-name ty-trait ty-name)))

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
    (map roll-token-y-depositor (get-token-y-depositors cycle))
    (map roll-token-x-depositor (get-token-x-depositors cycle))
    (roll-depositor-lists cycle)
    (advance-cycle)
    (try! (contract-call? .jing-core log-cancel-cycle
            cycle (get total-token-x totals) (get total-token-y totals)
            (var-get token-x) (var-get token-y)))
    (ok true)))

(define-private (execute-settlement
  (cycle uint)
  (feed-x { price: int, conf: uint, expo: int, ema-price: int,
            ema-conf: uint, publish-time: uint, prev-publish-time: uint })
  (feed-y { price: int, conf: uint, expo: int, ema-price: int,
            ema-conf: uint, publish-time: uint, prev-publish-time: uint })
  (tx-trait <ft-trait>) (tx-name (string-ascii 128))
  (ty-trait <ft-trait>) (ty-name (string-ascii 128)))
  (let (
    (price-x (to-uint (get price feed-x)))
    (price-y (to-uint (get price feed-y)))
    (min-freshness (- stacks-block-time MAX_STALENESS))
  )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (asserts! (> price-x u0) ERR_ZERO_PRICE)
    (asserts! (> price-y u0) ERR_ZERO_PRICE)
    (asserts! (> (get publish-time feed-x) min-freshness) ERR_STALE_PRICE)
    (asserts! (> (get publish-time feed-y) min-freshness) ERR_STALE_PRICE)
    (asserts! (< (get conf feed-x) (/ price-x MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
    (asserts! (< (get conf feed-y) (/ price-y MAX_CONF_RATIO)) ERR_PRICE_UNCERTAIN)
    (let ((oracle-price (/ (* price-x PRICE_PRECISION) price-y)))
    (asserts! (> oracle-price u0) ERR_ZERO_PRICE)

    (var-set settle-clearing-price oracle-price)
    (map filter-limit-violating-token-y-depositor (get-token-y-depositors cycle))
    (map filter-limit-violating-token-x-depositor (get-token-x-depositors cycle))
    (let (
      (totals (get-cycle-totals cycle))
      (total-token-y (get total-token-y totals))
      (total-token-x (get total-token-x totals))
      (token-y-value-of-token-x (/ (* total-token-x oracle-price) (* PRICE_PRECISION DECIMAL_FACTOR)))
      (token-x-is-binding (<= token-y-value-of-token-x total-token-y))
      (token-y-clearing (if token-x-is-binding token-y-value-of-token-x total-token-y))
      (token-x-clearing (if token-x-is-binding total-token-x (/ (* total-token-y (* PRICE_PRECISION DECIMAL_FACTOR)) oracle-price)))
      (token-y-fee (/ (* token-y-clearing FEE_BPS) BPS_PRECISION))
      (token-x-fee (/ (* token-x-clearing FEE_BPS) BPS_PRECISION))
      (token-y-unfilled (- total-token-y token-y-clearing))
      (token-x-unfilled (- total-token-x token-x-clearing))
    )
    (asserts! (and (>= total-token-y (var-get min-token-y-deposit))
                   (>= total-token-x (var-get min-token-x-deposit))) ERR_NOTHING_TO_SETTLE)
    (map-set settlements cycle
      { price: oracle-price,
        token-y-cleared: token-y-clearing,
        token-x-cleared: token-x-clearing,
        token-y-fee: token-y-fee,
        token-x-fee: token-x-fee,
        settled-at: stacks-block-height })
    (if (> token-y-fee u0)
      (try! (as-contract? ((with-ft (contract-of ty-trait) ty-name token-y-fee))
        (try! (contract-call? ty-trait transfer token-y-fee current-contract (var-get treasury) none))))
      true)
    (if (> token-x-fee u0)
      (try! (as-contract? ((with-ft (contract-of tx-trait) tx-name token-x-fee))
        (try! (contract-call? tx-trait transfer token-x-fee current-contract (var-get treasury) none))))
      true)
    (var-set settle-token-y-cleared token-y-clearing)
    (var-set settle-token-x-cleared token-x-clearing)
    (var-set settle-total-token-y total-token-y)
    (var-set settle-total-token-x total-token-x)
    (var-set settle-token-x-after-fee (- token-x-clearing token-x-fee))
    (var-set settle-token-y-after-fee (- token-y-clearing token-y-fee))
    (try! (contract-call? .jing-core log-settlement
            cycle oracle-price oracle-price
            token-x-clearing token-y-clearing
            token-x-unfilled token-y-unfilled
            token-x-fee token-y-fee
            token-x-is-binding
            (var-get token-x) (var-get token-y)))
    (ok true)))))

;; Fold callback: pays token-y depositors in token-x.
;; Accumulator is response-wrapped so try! propagates clean (err uint) codes
;; through the fold and out of settle, preserving composability for callers.
(define-private (distribute-to-token-y-depositor
  (depositor principal)
  (acc (response { t: <ft-trait>, name: (string-ascii 128) } uint)))
  (let (
    (unwrapped (try! acc))
    (tt (get t unwrapped))
    (cycle (var-get current-cycle))
    (my-deposit (get-token-y-deposit cycle depositor))
    (total-token-y (var-get settle-total-token-y))
    (my-token-x-received (if (> total-token-y u0) (/ (* my-deposit (var-get settle-token-x-after-fee)) total-token-y) u0))
    (my-token-y-unfilled (if (> total-token-y u0) (/ (* my-deposit (- total-token-y (var-get settle-token-y-cleared))) total-token-y) u0))
    (my-token-y-cleared (- my-deposit my-token-y-unfilled))
    (next-cycle (+ cycle u1))
  )
    (map-delete token-y-deposits { cycle: cycle, depositor: depositor })
    (var-set acc-token-x-out (+ (var-get acc-token-x-out) my-token-x-received))
    (var-set acc-token-y-rolled (+ (var-get acc-token-y-rolled) my-token-y-unfilled))
    (if (is-eq depositor tx-sender)
      (begin
        (var-set caller-token-x-received my-token-x-received)
        (var-set caller-token-y-rolled my-token-y-unfilled)
        true)
      true)
    (if (> my-token-x-received u0)
      (try! (as-contract? ((with-ft (contract-of tt) (get name unwrapped) my-token-x-received))
        (try! (contract-call? tt transfer my-token-x-received current-contract depositor none))))
      true)
    (if (> my-token-y-unfilled u0)
      (begin
        (map-set token-y-deposits
          { cycle: next-cycle, depositor: depositor } my-token-y-unfilled)
        (map-set token-y-depositor-list next-cycle
              (unwrap-panic (as-max-len? (append (get-token-y-depositors next-cycle) depositor) u50)))
        true)
      (begin
        (map-delete token-y-deposit-limits depositor)
        true))
    (try! (contract-call? .jing-core log-distribute-y-depositor
            depositor cycle my-token-x-received my-token-y-cleared my-token-y-unfilled
            (var-get token-x) (var-get token-y)))
    (ok unwrapped)))

;; Fold callback: pays token-x depositors in token-y.
;; See distribute-to-token-y-depositor for the response-acc rationale.
(define-private (distribute-to-token-x-depositor
  (depositor principal)
  (acc (response { t: <ft-trait>, name: (string-ascii 128) } uint)))
  (let (
    (unwrapped (try! acc))
    (tt (get t unwrapped))
    (cycle (var-get current-cycle))
    (my-deposit (get-token-x-deposit cycle depositor))
    (total-token-x (var-get settle-total-token-x))
    (my-token-y-received (if (> total-token-x u0) (/ (* my-deposit (var-get settle-token-y-after-fee)) total-token-x) u0))
    (my-token-x-unfilled (if (> total-token-x u0) (/ (* my-deposit (- total-token-x (var-get settle-token-x-cleared))) total-token-x) u0))
    (my-token-x-cleared (- my-deposit my-token-x-unfilled))
    (next-cycle (+ cycle u1))
  )
    (map-delete token-x-deposits { cycle: cycle, depositor: depositor })
    (var-set acc-token-y-out (+ (var-get acc-token-y-out) my-token-y-received))
    (var-set acc-token-x-rolled (+ (var-get acc-token-x-rolled) my-token-x-unfilled))
    (if (is-eq depositor tx-sender)
      (begin
        (var-set caller-token-y-received my-token-y-received)
        (var-set caller-token-x-rolled my-token-x-unfilled)
        true)
      true)
    (if (> my-token-y-received u0)
      (try! (as-contract? ((with-ft (contract-of tt) (get name unwrapped) my-token-y-received))
        (try! (contract-call? tt transfer my-token-y-received current-contract depositor none))))
      true)
    (if (> my-token-x-unfilled u0)
      (begin
        (map-set token-x-deposits
          { cycle: next-cycle, depositor: depositor } my-token-x-unfilled)
        (map-set token-x-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-x-depositors next-cycle) depositor) u50)))
        true)
      (begin
        (map-delete token-x-deposit-limits depositor)
        true))
    (try! (contract-call? .jing-core log-distribute-x-depositor
            depositor cycle my-token-y-received my-token-x-cleared my-token-x-unfilled
            (var-get token-x) (var-get token-y)))
    (ok unwrapped)))

(define-private (roll-and-sweep-dust
  (tx-trait <ft-trait>) (tx-name (string-ascii 128))
  (ty-trait <ft-trait>) (ty-name (string-ascii 128)))
  (let (
    (acc-token-y-rol (var-get acc-token-y-rolled))
    (acc-token-x-rol (var-get acc-token-x-rolled))
    (token-y-payout-dust  (- (var-get settle-token-y-after-fee) (var-get acc-token-y-out)))
    (token-y-roll-dust    (- (- (var-get settle-total-token-y) (var-get settle-token-y-cleared))
                          acc-token-y-rol))
    (token-y-dust         (+ token-y-payout-dust token-y-roll-dust))
    (token-x-payout-dust (- (var-get settle-token-x-after-fee) (var-get acc-token-x-out)))
    (token-x-roll-dust   (- (- (var-get settle-total-token-x) (var-get settle-token-x-cleared))
                           acc-token-x-rol))
    (token-x-dust        (+ token-x-payout-dust token-x-roll-dust))
    (next-cycle       (+ (var-get current-cycle) u1))
    (next-totals      (get-cycle-totals next-cycle))
  )
    (map-set cycle-totals next-cycle
      { total-token-y: (+ (get total-token-y next-totals) acc-token-y-rol),
        total-token-x: (+ (get total-token-x next-totals) acc-token-x-rol) })
    (if (> token-y-dust u0)
      (try! (as-contract? ((with-ft (contract-of ty-trait) ty-name token-y-dust))
        (try! (contract-call? ty-trait transfer token-y-dust current-contract (var-get treasury) none))))
      true)
    (if (> token-x-dust u0)
      (try! (as-contract? ((with-ft (contract-of tx-trait) tx-name token-x-dust))
        (try! (contract-call? tx-trait transfer token-x-dust current-contract (var-get treasury) none))))
      true)
    (try! (contract-call? .jing-core log-sweep-dust
            acc-token-x-rol acc-token-y-rol
            token-x-dust token-x-payout-dust token-x-roll-dust
            token-y-dust token-y-payout-dust token-y-roll-dust
            (var-get token-x) (var-get token-y)))
    (ok true)))

(define-public (initialize
  (x principal) (y principal)
  (min-x uint) (min-y uint)
  (feed-x (buff 32)) (feed-y (buff 32)))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)
    (var-set token-x x)
    (var-set token-y y)
    (var-set min-token-x-deposit min-x)
    (var-set min-token-y-deposit min-y)
    (var-set oracle-feed-x feed-x)
    (var-set oracle-feed-y feed-y)
    (var-set initialized true)
    (ok true)))

(define-public (set-treasury (new-treasury principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set treasury new-treasury))))

(define-public (set-paused (is-paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set paused is-paused))))

(define-public (set-operator (new-operator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set operator new-operator))))

(define-public (set-min-token-y-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-token-y-deposit amount))))

(define-public (set-min-token-x-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-token-x-deposit amount))))
