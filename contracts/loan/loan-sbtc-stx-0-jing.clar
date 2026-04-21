;; loan-sbtc-stx-0-jing
;;
;; Per-borrower loan contract specialized for sbtc-stx-0-jing-v2.
;; Funded just-in-time by a lender reserve contract (loan-reserve.clar).
;;
;; Immutable BORROWER and LENDER (= reserve contract). One active loan
;; at a time. N singles run in parallel, each as its own Jing depositor
;; principal, with no cross-contamination at Jing's per-principal layer.
;;
;; Flow:
;;   1. `borrow`       - pulls sBTC from the reserve, creates loan,
;;                       starts clawback deadline.
;;   2. `swap-deposit` - deposits sBTC into sbtc-stx-0-jing-v2 during
;;                       a deposit phase.
;;   3. `repay` or `seize` - once Jing has fully resolved our deposit.
;;                       Pays sBTC to the reserve and STX to the
;;                       appropriate party, then calls
;;                       `reserve.notify-return` to release the
;;                       principal against the reserve's outstanding.
;;
;; Escape hatches:
;;   `cancel`      - pre-swap abandon by borrower. Principal returns
;;                   to reserve.
;;   `cancel-swap` - post-swap-deposit pull-back from Jing. Loan
;;                   stays active; recovered sBTC sits on the
;;                   contract and is reconciled at repay/seize.
;;                   Borrower anytime; permissionless after deadline.

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant JING-MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2)
;; Immutable borrower. REPLACE BEFORE DEPLOYMENT.
(define-constant BORROWER 'SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X)
;; Reserve contract (resolves to same deployer as this single).
(define-constant LENDER .loan-reserve)

(define-constant CLAWBACK-DELAY u4200)
(define-constant BPS_PRECISION u10000)
;; Immutable loan terms. REPLACE BEFORE DEPLOYMENT if needed.
(define-constant INTEREST-BPS u100)           ;; 1% flat
(define-constant MIN-SBTC-BORROW u1000000)    ;; 0.01 sBTC

(define-constant STATUS-PRE-SWAP u0)
(define-constant SWAP-DEPOSITED u1)
(define-constant STATUS-REPAID u2)
(define-constant STATUS-SEIZED u3)
(define-constant STATUS-CANCELLED u4)

(define-constant ERR-NOT-BORROWER (err u101))
(define-constant ERR-AMOUNT-TOO-LOW (err u102))
(define-constant ERR-ACTIVE-LOAN-EXISTS (err u104))
(define-constant ERR-LOAN-NOT-FOUND (err u105))
(define-constant ERR-BAD-STATUS (err u106))
(define-constant ERR-NOT-FULLY-RESOLVED (err u107))
(define-constant ERR-DEADLINE-NOT-REACHED (err u108))

(define-data-var next-loan-id uint u1)
(define-data-var active-loan (optional uint) none)

(define-map loans uint {
  sbtc-principal: uint,
  interest-bps: uint,
  jing-cycle: uint,
  deadline: uint,
  stx-collateral: uint,
  limit-price: uint,
  status: uint
})

;; ---------- Read-only ----------

(define-read-only (get-lender) LENDER)
(define-read-only (get-borrower) BORROWER)
(define-read-only (get-interest-bps) INTEREST-BPS)
(define-read-only (get-min-sbtc-borrow) MIN-SBTC-BORROW)
(define-read-only (get-active-loan) (var-get active-loan))
(define-read-only (get-loan (loan-id uint)) (map-get? loans loan-id))

(define-read-only (owed-on-loan (loan-id uint))
  (match (map-get? loans loan-id)
    loan (ok (+ (get sbtc-principal loan)
                (/ (* (get sbtc-principal loan) (get interest-bps loan)) BPS_PRECISION)))
    ERR-LOAN-NOT-FOUND))

(define-private (our-sbtc-in-jing (cycle uint))
  (contract-call? JING-MARKET get-sbtc-deposit cycle current-contract))

;; ---------- Loan lifecycle ----------

;; Step 1: pull sBTC from reserve, create loan, start clawback deadline.
(define-public (borrow (amount uint))
  (let ((caller tx-sender)
        (loan-id (var-get next-loan-id)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-none (var-get active-loan)) ERR-ACTIVE-LOAN-EXISTS)
    (asserts! (>= amount MIN-SBTC-BORROW) ERR-AMOUNT-TOO-LOW)
    (try! (contract-call? LENDER disburse amount))
    (map-set loans loan-id {
      sbtc-principal: amount,
      interest-bps: INTEREST-BPS,
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

;; Pull sBTC back from Jing. Loan stays SWAP-DEPOSITED; recovered sBTC
;; sits on contract and is reconciled at repay/seize via excess-sbtc.
;; Borrower anytime; anyone after deadline.
(define-public (cancel-swap (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq (get status loan) SWAP-DEPOSITED) ERR-BAD-STATUS)
    (asserts! (or (is-eq caller BORROWER)
                  (>= burn-block-height (get deadline loan)))
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
    (map-set loans loan-id (merge loan { limit-price: limit-price }))
    (try! (as-contract? ()
      (try! (contract-call? JING-MARKET set-sbtc-limit limit-price))))
    (print { event: "set-swap-limit", limit-price: limit-price })
    (ok true)))

;; Pre-swap abandon. Principal returns to reserve.
(define-public (cancel (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (principal (get sbtc-principal loan)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-PRE-SWAP) ERR-BAD-STATUS)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" principal))
      (try! (contract-call? SBTC transfer principal current-contract LENDER none))))
    (try! (contract-call? LENDER notify-return principal))
    (map-set loans loan-id (merge loan { status: STATUS-CANCELLED }))
    (var-set active-loan none)
    (print { event: "cancel", loan-id: loan-id, principal-returned: principal })
    (ok true)))

(define-public (repay (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (notional (get sbtc-principal loan))
        (owed (+ notional (/ (* notional (get interest-bps loan)) BPS_PRECISION)))
        (stx-out (stx-get-balance current-contract))
        ;; No prefunded lender capital in v2, so any sBTC on-contract is
        ;; borrower-side recovery (Jing eviction, cancel-swap, airdrop).
        (excess-sbtc (unwrap-panic (contract-call? SBTC get-balance current-contract)))
        (shortfall (if (> owed excess-sbtc) (- owed excess-sbtc) u0))
        (refund (if (> excess-sbtc owed) (- excess-sbtc owed) u0)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) SWAP-DEPOSITED) ERR-BAD-STATUS)
    (asserts! (is-eq u0 (our-sbtc-in-jing
                          (contract-call? JING-MARKET get-current-cycle)))
              ERR-NOT-FULLY-RESOLVED)
    ;; Borrower tops up whatever is missing to cover `owed`
    (if (> shortfall u0)
      (try! (contract-call? SBTC transfer shortfall caller current-contract none))
      true)
    ;; Refund any sBTC beyond owed back to borrower (rare)
    (if (> refund u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" refund))
        (try! (contract-call? SBTC transfer refund current-contract BORROWER none))))
      true)
    ;; Pay owed (principal + interest) to reserve
    (try! (as-contract? ((with-ft SBTC "sbtc-token" owed))
      (try! (contract-call? SBTC transfer owed current-contract LENDER none))))
    ;; STX collateral to borrower
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract BORROWER))))
      true)
    (try! (contract-call? LENDER notify-return notional))
    (map-set loans loan-id (merge loan { stx-collateral: stx-out, status: STATUS-REPAID }))
    (var-set active-loan none)
    (print { event: "repay", loan-id: loan-id, sbtc-owed: owed,
             from-borrower: shortfall, refund: refund, stx-released: stx-out })
    (ok true)))

;; Permissionless past-deadline seize. Works for PRE-SWAP (never swapped)
;; or SWAP-DEPOSITED (fully resolved). All on-contract sBTC + STX ships
;; to the reserve.
(define-public (seize (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (status (get status loan))
        (notional (get sbtc-principal loan))
        (stx-out (stx-get-balance current-contract))
        (excess-sbtc (unwrap-panic (contract-call? SBTC get-balance current-contract))))
    (asserts! (or (is-eq status STATUS-PRE-SWAP)
                  (is-eq status SWAP-DEPOSITED)) ERR-BAD-STATUS)
    (asserts! (>= burn-block-height (get deadline loan)) ERR-DEADLINE-NOT-REACHED)
    (if (is-eq status SWAP-DEPOSITED)
      (asserts! (is-eq u0 (our-sbtc-in-jing
                            (contract-call? JING-MARKET get-current-cycle)))
                ERR-NOT-FULLY-RESOLVED)
      true)
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract LENDER))))
      true)
    (if (> excess-sbtc u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" excess-sbtc))
        (try! (contract-call? SBTC transfer excess-sbtc current-contract LENDER none))))
      true)
    (try! (contract-call? LENDER notify-return notional))
    (map-set loans loan-id (merge loan { status: STATUS-SEIZED }))
    (var-set active-loan none)
    (print { event: "seize", loan-id: loan-id, status-was: status,
             stx-seized: stx-out, sbtc-seized: excess-sbtc })
    (ok true)))
