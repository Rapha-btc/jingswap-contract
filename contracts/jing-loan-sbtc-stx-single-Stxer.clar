;; jing-loan-sbtc-stx-single
;;
;; Single-borrower, single-active-loan PoC variant.
;; Strips the multi-borrower, whitelist-cooldown, credit-limit complexity.
;; One lender funds the contract; one immutable BORROWER draws loans serially.
;; Lender cannot rug the borrower: their only lever is `withdraw-funds` on
;; sBTC that hasn't yet been borrowed.
;;
;; Flow:
;;   1. `borrow`               - locks sBTC, creates loan, starts clawback deadline.
;;   2. `swap-deposit`         - deposits sBTC into Jing sbtc-stx-0-jing-v2 during
;;                               a deposit phase.
;;   3. `repay` or `seize`     - once Jing has fully resolved our deposit
;;                               (cleared + rolls done). Both use the live STX
;;                               balance of the contract; `record-stx-collateral`
;;                               exists as an optional audit snapshot.
;;
;; Escape hatch:
;;   `cancel-swap` - borrower calls Jing's `cancel-sbtc-deposit` to pull back
;;                   any sBTC still deposited in Jing v2. Loan state is
;;                   unchanged; the recovered sBTC sits in the contract and
;;                   offsets the borrower's out-of-pocket at repay.

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant JING-MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2)
;; Immutable borrower. Lender can never rug: worst they can do is withdraw
;; unborrowed sBTC from `available-sbtc`. REPLACE BEFORE DEPLOYMENT.
(define-constant BORROWER 'SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X)
;; Immutable lender. REPLACE BEFORE DEPLOYMENT.
(define-constant LENDER 'SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M)

(define-constant CLAWBACK-DELAY u0)          ;; ~2 PoX cycles after borrow
(define-constant BPS_PRECISION u10000)

(define-constant STATUS-PRE-SWAP u0)
(define-constant SWAP-DEPOSITED u1)
(define-constant STATUS-REPAID u2)
(define-constant STATUS-SEIZED u3)

(define-constant ERR-NOT-LENDER (err u100))
(define-constant ERR-NOT-BORROWER (err u101))
(define-constant ERR-AMOUNT-TOO-LOW (err u102))
(define-constant ERR-INSUFFICIENT-FUNDS (err u103))
(define-constant ERR-ACTIVE-LOAN-EXISTS (err u104))
(define-constant ERR-LOAN-NOT-FOUND (err u105))
(define-constant ERR-BAD-STATUS (err u106))
(define-constant ERR-NOT-FULLY-RESOLVED (err u107))
(define-constant ERR-DEADLINE-NOT-REACHED (err u108))
(define-constant ERR-NOTHING-TO-ATTRIBUTE (err u109))

(define-data-var interest-bps uint u100)        ;; default 12.5% flat
(define-data-var min-sbtc-borrow uint u1000000) ;; 0.01 sBTC
(define-data-var available-sbtc uint u0)        ;; funded sBTC, not yet borrowed
(define-data-var next-loan-id uint u1)
(define-data-var active-loan (optional uint) none) ;; at most one unresolved loan

(define-map loans uint {
  sbtc-principal: uint,        ;; immutable after borrow
  interest-bps: uint,
  jing-cycle: uint,            ;; set at swap-deposit
  deadline: uint,              ;; set at borrow
  stx-collateral: uint,        ;; optional audit snapshot via record-stx-collateral
  limit-price: uint,
  status: uint
})

;; ---------- Read-only ----------

(define-read-only (get-lender) LENDER)
(define-read-only (get-borrower) BORROWER)
(define-read-only (get-interest-bps) (var-get interest-bps))
(define-read-only (get-min-sbtc-borrow) (var-get min-sbtc-borrow))
(define-read-only (get-available-sbtc) (var-get available-sbtc))
(define-read-only (get-active-loan) (var-get active-loan))
(define-read-only (get-loan (loan-id uint)) (map-get? loans loan-id))

(define-read-only (owed-on-loan (loan-id uint))
  (match (map-get? loans loan-id)
    loan (ok (+ (get sbtc-principal loan)
                (/ (* (get sbtc-principal loan) (get interest-bps loan)) BPS_PRECISION)))
    ERR-LOAN-NOT-FOUND))

(define-private (our-sbtc-in-jing (cycle uint))
  (contract-call? JING-MARKET get-sbtc-deposit cycle current-contract))

;; ---------- Admin ----------

(define-public (set-interest-bps (bps uint))
  (begin
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (var-set interest-bps bps)
    (ok true)))

(define-public (set-min-sbtc-borrow (amount uint))
  (begin
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (var-set min-sbtc-borrow amount)
    (ok true)))

;; ---------- Funding ----------

(define-public (fund (amount uint))
  (let ((caller tx-sender)
        (new-liquid (+ (var-get available-sbtc) amount)))
    (asserts! (is-eq caller LENDER) ERR-NOT-LENDER)
    (try! (contract-call? SBTC transfer amount caller current-contract none))
    (var-set available-sbtc new-liquid)
    (print { event: "fund", amount: amount, available-sbtc: new-liquid })
    (ok true)))

(define-public (withdraw-funds (amount uint))
  (let ((caller tx-sender)
        (liquid (var-get available-sbtc)))
    (asserts! (is-eq caller LENDER) ERR-NOT-LENDER)
    (asserts! (<= amount liquid) ERR-INSUFFICIENT-FUNDS)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract caller none))))
    (var-set available-sbtc (- liquid amount))
    (print { event: "withdraw-funds", amount: amount, available-sbtc: (- liquid amount) })
    (ok true)))

;; ---------- Loan lifecycle ----------

;; Step 1: lock sBTC, create loan, start clawback deadline.
(define-public (borrow (amount uint))
  (let ((caller tx-sender)
        (loan-id (var-get next-loan-id))
        (liquid (var-get available-sbtc)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-none (var-get active-loan)) ERR-ACTIVE-LOAN-EXISTS)
    (asserts! (>= amount (var-get min-sbtc-borrow)) ERR-AMOUNT-TOO-LOW)
    (asserts! (<= amount liquid) ERR-INSUFFICIENT-FUNDS)
    (var-set available-sbtc (- liquid amount))
    (map-set loans loan-id {
      sbtc-principal: amount,
      interest-bps: (var-get interest-bps),
      jing-cycle: u0,
      deadline: (+ burn-block-height CLAWBACK-DELAY),
      stx-collateral: u0,
      limit-price: u0,
      status: STATUS-PRE-SWAP
    })
    (var-set active-loan (some loan-id))
    (var-set next-loan-id (+ loan-id u1))
    (print { event: "borrow", loan-id: loan-id, amount: amount,
             deadline: (+ burn-block-height CLAWBACK-DELAY) })
    (ok loan-id)))

;; Step 2: deposit sBTC into Jing during a deposit phase.
(define-public (swap-deposit (loan-id uint) (limit-price uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (jing-cycle (contract-call? JING-MARKET get-current-cycle))
        (amount (get sbtc-principal loan)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-PRE-SWAP) ERR-BAD-STATUS)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? JING-MARKET deposit-sbtc amount limit-price))))
    (map-set loans loan-id (merge loan {
      jing-cycle: jing-cycle,
      limit-price: limit-price,
      status: SWAP-DEPOSITED
    }))
    (print { event: "swap-deposit", loan-id: loan-id, amount: amount,
             limit: limit-price, cycle: jing-cycle })
    (ok true)))

;; Escape hatch: cancel Jing deposit. sBTC returns to the contract.
;; Loan state is unchanged (still SWAP-DEPOSITED); the recovered sBTC sits in
;; the contract and offsets the borrower's out-of-pocket at repay.
;; Callable by borrower anytime; also by lender after the deadline to unblock seize.
(define-public (cancel-swap (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq (get status loan) SWAP-DEPOSITED) ERR-BAD-STATUS)
    (asserts! (or (is-eq caller BORROWER)
                  (and (is-eq caller LENDER)
                       (>= burn-block-height (get deadline loan))))
              ERR-NOT-BORROWER)
    (try! (as-contract? ((with-all-assets-unsafe))
      (try! (contract-call? JING-MARKET cancel-sbtc-deposit))))
    (print { event: "cancel-swap", loan-id: loan-id, caller: caller })
    (ok true)))

(define-public (set-swap-limit (loan-id uint) (limit-price uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) SWAP-DEPOSITED) ERR-BAD-STATUS)
    (map-set loans loan-id (merge loan {
      limit-price: limit-price
    }))
    (try! (as-contract? ()
      (try! (contract-call? JING-MARKET set-sbtc-limit limit-price))))
    (print { event: "set-swap-limit", limit-price: limit-price })
    (ok true)))

;; ;; Step 3: snapshot STX collateral. Requires that no sBTC remains in Jing
;; ;; (all cleared or cancelled). Current cycle advancing is not sufficient on
;; ;; its own; rollovers can delay full resolution across multiple cycles.
;; (define-public (record-stx-collateral (loan-id uint))
;;   (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
;;         (stx-balance (stx-get-balance current-contract)))
;;     (asserts! (is-eq (get status loan) SWAP-DEPOSITED) ERR-BAD-STATUS)
;;     (asserts! (is-eq u0 (our-sbtc-in-jing
;;                           (contract-call? JING-MARKET get-current-cycle)))
;;               ERR-NOT-FULLY-RESOLVED)
;;       (asserts! (> stx-balance u0) ERR-NOTHING-TO-ATTRIBUTE)
;;       (map-set loans loan-id (merge loan { stx-collateral: stx-balance }))
;;       (print { event: "record-stx-collateral", loan-id: loan-id, stx: stx-balance })
;;       (ok stx-balance)))

(define-public (repay (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (notional (get sbtc-principal loan))
        (owed (+ notional (/ (* notional (get interest-bps loan)) BPS_PRECISION)))
        (stx-out (stx-get-balance current-contract))
        (excess-sbtc (- (unwrap-panic (contract-call? SBTC get-balance current-contract))
                          (var-get available-sbtc))) ;; this belongs to the borrower and available belongs to the lender
        (shortfall (if (> owed excess-sbtc) (- owed excess-sbtc) u0))
        (refund (if (> excess-sbtc owed) (- excess-sbtc owed) u0)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) SWAP-DEPOSITED) ERR-BAD-STATUS)
    (asserts! (is-eq u0 (our-sbtc-in-jing
                          (contract-call? JING-MARKET get-current-cycle)))
              ERR-NOT-FULLY-RESOLVED)
    ;; Borrower tops up the contract with whatever's missing to cover `owed`
    (if (> shortfall u0)
      (try! (contract-call? SBTC transfer shortfall caller current-contract none))
      true)
    ;; Refund any contract sBTC beyond owed back to borrower (almost never happens except contract airdrop random)
    (if (> refund u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" refund))
        (try! (contract-call? SBTC transfer refund current-contract BORROWER none))))
      true)
    ;; Contract pays the full owed amount to lender
    (try! (as-contract? ((with-ft SBTC "sbtc-token" owed))
      (try! (contract-call? SBTC transfer owed current-contract LENDER none))))
    ;; Any STX collateral to borrower (may be 0 if full cancel-swap)
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract BORROWER))))
      true)
    (map-set loans loan-id (merge loan { stx-collateral: stx-out, status: STATUS-REPAID }))
    (var-set active-loan none)
    (print { event: "repay", loan-id: loan-id, sbtc-owed: owed,
              from-borrower: shortfall, refund: refund, stx-released: stx-out })
    (ok true)))

(define-public (seize (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (stx-out (stx-get-balance current-contract))
        (excess-sbtc (- (unwrap-panic (contract-call? SBTC get-balance current-contract))
                          (var-get available-sbtc))))
    (asserts! (is-eq caller LENDER) ERR-NOT-LENDER)
    (asserts! (is-eq (get status loan) SWAP-DEPOSITED) ERR-BAD-STATUS)
    (asserts! (>= burn-block-height (get deadline loan)) ERR-DEADLINE-NOT-REACHED)
    (asserts! (is-eq u0 (our-sbtc-in-jing
                          (contract-call? JING-MARKET get-current-cycle)))
              ERR-NOT-FULLY-RESOLVED)
    ;; STX collateral to lender (may be 0 if full cancel-swap)
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract LENDER))))
      true)
    ;; Any recovered sBTC (from cancel-swap) to lender as partial principal recovery
    (if (> excess-sbtc u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" excess-sbtc))
        (try! (contract-call? SBTC transfer excess-sbtc current-contract LENDER none))))
      true)
    (map-set loans loan-id (merge loan { status: STATUS-SEIZED }))
    (var-set active-loan none)
    (print { event: "seize", loan-id: loan-id, stx-seized: stx-out, sbtc-seized: excess-sbtc })
    (ok true)))
