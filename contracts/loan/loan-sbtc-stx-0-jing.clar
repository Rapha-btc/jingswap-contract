;; loan-sbtc-stx-0-jing
;;
;; Per-borrower loan contract specialized for sbtc-stx-0-jing-v2.
;; Funded just-in-time by a lender reserve contract (loan-reserve.clar).
;;
;; Immutable BORROWER and RESERVE (the lender's pool). One active loan
;; at a time. N snpls run in parallel, each as its own Jing depositor
;; principal, with no cross-contamination at Jing's per-principal layer.
;;
;; Flow:
;;   1. `borrow`       - draws sBTC from the reserve, creates loan,
;;                       starts clawback deadline.
;;   2. `swap-deposit` - deposits sBTC into sbtc-stx-0-jing-v2 during
;;                       a deposit phase. Borrower may `cancel-swap`
;;                       and redeposit until deadline.
;;   3. `repay` or `seize` - close the loan once Jing holds none of
;;                       our sBTC. Pays sBTC to the reserve and STX
;;                       to the appropriate party, then calls
;;                       `reserve.notify-return` to release the
;;                       principal against the reserve's outstanding.
;;
;; Loan status is just OPEN / REPAID / SEIZED. Whether the borrower
;; has currently deposited into Jing is observable on Jing itself
;; (`get-sbtc-deposit`), not modeled as a separate state here.
;;
;; Escape hatch:
;;   `cancel-swap` - pull sBTC back from Jing. Loan stays OPEN;
;;                   recovered sBTC sits on the contract and can be
;;                   redeposited or reconciled at repay/seize.
;;                   Borrower anytime; anyone after deadline.
;;
;; No pre-swap cancel: once `borrow` has drawn principal, the borrower
;; is committed. They either repay (allowed any time, even before
;; swapping) or get seized after the deadline.

(impl-trait .snpl-trait.snpl-trait)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant JING-MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2)
;; Immutable borrower. REPLACE BEFORE DEPLOYMENT.
(define-constant BORROWER 'SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X)
;; Reserve contract (resolves to same deployer as this snpl).
(define-constant RESERVE .loan-reserve)

(define-constant CLAWBACK-DELAY u4200)
(define-constant BPS_PRECISION u10000)

(define-constant STATUS-OPEN u0)
(define-constant STATUS-REPAID u1)
(define-constant STATUS-SEIZED u2)

(define-constant ERR-NOT-BORROWER (err u101))
(define-constant ERR-ACTIVE-LOAN-EXISTS (err u104))
(define-constant ERR-LOAN-NOT-FOUND (err u105))
(define-constant ERR-BAD-STATUS (err u106))
(define-constant ERR-NOT-FULLY-RESOLVED (err u107))
(define-constant ERR-DEADLINE-NOT-REACHED (err u108))
(define-constant ERR-INTEREST-MISMATCH (err u109))

(define-data-var next-loan-id uint u1)
(define-data-var active-loan (optional uint) none)

(define-map loans uint {
  notional-sbtc: uint,
  payoff-sbtc: uint,
  interest-bps: uint,
  jing-cycle: uint,
  deadline: uint,
  position-stx: uint,
  limit-price: uint,
  status: uint
})

;; ---------- Read-only ----------

(define-read-only (get-reserve) (ok RESERVE))
(define-read-only (get-borrower) (ok BORROWER))
(define-read-only (get-active-loan) (ok (var-get active-loan)))
(define-read-only (get-loan (loan-id uint)) (ok (map-get? loans loan-id)))

(define-read-only (payoff-on-loan (loan-id uint))
  (match (map-get? loans loan-id)
    loan (ok (get payoff-sbtc loan))
    ERR-LOAN-NOT-FOUND))

(define-private (our-sbtc-in-jing (cycle uint))
  (contract-call? JING-MARKET get-sbtc-deposit cycle current-contract))

;; ---------- Loan lifecycle ----------

;; Step 1: draw sBTC from reserve, create loan, start clawback deadline.
;; Borrower passes the expected interest-bps as slippage protection;
;; if the lender has bumped the line's rate, the call reverts.
;; Reserve enforces the global min-draw and credit-line cap, and
;; returns the line's interest-bps; we stamp it on the loan so the rate
;; is fixed for this loan even if the lender adjusts the line later.
(define-public (borrow (amount uint) (interest-bps uint))
  (let ((caller tx-sender)
        (loan-id (var-get next-loan-id))
        (deadline (+ burn-block-height CLAWBACK-DELAY)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-none (var-get active-loan)) ERR-ACTIVE-LOAN-EXISTS)
    (let ((line-bps (try! (contract-call? RESERVE draw amount))))
      (asserts! (is-eq interest-bps line-bps) ERR-INTEREST-MISMATCH)
      (map-set loans loan-id {
        notional-sbtc: amount,
        payoff-sbtc: (+ amount (/ (* amount line-bps) BPS_PRECISION)),
        interest-bps: line-bps,
        jing-cycle: u0,
        deadline: deadline,
        position-stx: u0,
        limit-price: u0,
        status: STATUS-OPEN
      })
      (var-set active-loan (some loan-id))
      (var-set next-loan-id (+ loan-id u1))
      (print { event: "borrow", loan-id: loan-id, amount: amount,
               interest-bps: line-bps,
               deadline: deadline })
      (ok loan-id))))

;; Step 2: deposit sBTC into Jing during a deposit phase.
(define-public (swap-deposit (loan-id uint) (limit-price uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (jing-cycle (contract-call? JING-MARKET get-current-cycle))
        (amount (get notional-sbtc loan)))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? JING-MARKET deposit-sbtc amount limit-price))))
    (map-set loans loan-id (merge loan {
      jing-cycle: jing-cycle,
      limit-price: limit-price
    }))
    (print { event: "swap-deposit", loan-id: loan-id, amount: amount,
             limit: limit-price, cycle: jing-cycle })
    (ok true)))

;; Pull sBTC back from Jing. Loan stays OPEN; recovered sBTC sits on
;; contract and can be redeposited (until deadline) or reconciled at
;; repay/seize via sbtc-balance. Borrower anytime; anyone after deadline.
(define-public (cancel-swap (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
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
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (map-set loans loan-id (merge loan { limit-price: limit-price }))
    (try! (as-contract? ()
      (try! (contract-call? JING-MARKET set-sbtc-limit limit-price))))
    (print { event: "set-swap-limit", limit-price: limit-price })
    (ok true)))

(define-public (repay (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (notional (get notional-sbtc loan))
        (payoff (get payoff-sbtc loan))
        (stx-out (stx-get-balance current-contract))
        ;; No prefunded lender capital in v2, so any sBTC on-contract is
        ;; borrower-side recovery (Jing eviction, cancel-swap, airdrop).
        (sbtc-balance (unwrap-panic (contract-call? SBTC get-balance current-contract)))
        (is-shortfall (> payoff sbtc-balance))
        ;; abs(payoff - sbtc-balance). Shortfall (common) = borrower
        ;; tops up; otherwise refund excess back to borrower.
        (delta (if is-shortfall (- payoff sbtc-balance) (- sbtc-balance payoff))))
    (asserts! (is-eq caller BORROWER) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (asserts! (is-eq u0 (our-sbtc-in-jing
                          (contract-call? JING-MARKET get-current-cycle)))
              ERR-NOT-FULLY-RESOLVED)
    ;; Reconcile sBTC: borrower tops up shortfall, or refund excess (rare).
    (if is-shortfall
      (if (> delta u0)
        (try! (contract-call? SBTC transfer delta caller current-contract none))
        true)
      (if (> delta u0)
        (try! (as-contract? ((with-ft SBTC "sbtc-token" delta))
          (try! (contract-call? SBTC transfer delta current-contract BORROWER none))))
        true))
    ;; Pay payoff (principal + interest) to reserve
    (try! (as-contract? ((with-ft SBTC "sbtc-token" payoff))
      (try! (contract-call? SBTC transfer payoff current-contract RESERVE none))))
    ;; Position STX to borrower
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract BORROWER))))
      true)
    (try! (contract-call? RESERVE notify-return notional))
    (map-set loans loan-id (merge loan { position-stx: stx-out, status: STATUS-REPAID }))
    (var-set active-loan none)
    (print { event: "repay", loan-id: loan-id, payoff-sbtc: payoff,
             delta-sbtc: delta, is-shortfall: is-shortfall, stx-released: stx-out })
    (ok true)))

;; Permissionless past-deadline seize. Requires Jing to hold none of
;; our sBTC (cleared, rolled, or never deposited). All on-contract
;; sBTC + STX ships to the reserve.
(define-public (seize (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (notional (get notional-sbtc loan))
        (stx-out (stx-get-balance current-contract))
        (sbtc-balance (unwrap-panic (contract-call? SBTC get-balance current-contract))))
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (asserts! (>= burn-block-height (get deadline loan)) ERR-DEADLINE-NOT-REACHED)
    (asserts! (is-eq u0 (our-sbtc-in-jing
                          (contract-call? JING-MARKET get-current-cycle)))
              ERR-NOT-FULLY-RESOLVED)
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract RESERVE))))
      true)
    (if (> sbtc-balance u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" sbtc-balance))
        (try! (contract-call? SBTC transfer sbtc-balance current-contract RESERVE none))))
      true)
    (try! (contract-call? RESERVE notify-return notional))
    (map-set loans loan-id (merge loan { status: STATUS-SEIZED }))
    (var-set active-loan none)
    (print { event: "seize", loan-id: loan-id,
             stx-seized: stx-out, sbtc-seized: sbtc-balance })
    (ok true)))
