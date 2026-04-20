;; jing-loan-sbtc-for-stx
;;
;; Lender funds sBTC. A whitelisted borrower takes a loan in two steps:
;;   1. `borrow`  — locks sBTC in the contract, creates the loan record.
;;   2. `swap`    — deposits that sBTC into Jing v2 (sbtc-stx-0-jing-v2) during
;;                  a deposit phase. Starts the clawback deadline.
;;
;; Splitting borrow and swap keeps each tx cheap (no atomic close+settle with
;; Pyth VAAs) and lets the borrower time the swap to a live Jing deposit phase.
;;
;; After Jing settles, STX lands in this contract. At `repay` or `seize` the
;; STX collateral is attributed inline from (contract-balance - assigned-stx)
;; and transferred to borrower (on repay) or lender (on seize).
;; Only ONE swapped-but-unsettled loan at a time, to keep attribution clean.

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant JING-MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2)

(define-constant MIN-SBTC-BORROW u1000000)         ;; 0.01 sBTC (sats)
(define-constant CLAWBACK-DELAY u4200)             ;; ~2 PoX cycles of burn blocks after swap
(define-constant WHITELIST-COOLDOWN u1)            ;; burn blocks before whitelist takes effect
(define-constant BPS_PRECISION u10000)

(define-constant STATUS-PRE-SWAP u0)   ;; borrow done, swap not yet
(define-constant STATUS-SWAPPED u1)    ;; swap done, awaiting Jing settlement + repay/seize
(define-constant STATUS-REPAID u2)
(define-constant STATUS-SEIZED u3)
(define-constant STATUS-CANCELLED u4)

(define-constant ERR-NOT-LENDER (err u100))
(define-constant ERR-NOT-OPERATOR (err u101))
(define-constant ERR-NOT-BORROWER (err u102))
(define-constant ERR-NOT-WHITELISTED (err u103))
(define-constant ERR-AMOUNT-TOO-LOW (err u104))
(define-constant ERR-INSUFFICIENT-FUNDS (err u105))
(define-constant ERR-SWAPPED-LOAN-EXISTS (err u106))
(define-constant ERR-LOAN-NOT-FOUND (err u107))
(define-constant ERR-BAD-STATUS (err u108))
(define-constant ERR-NOT-SETTLED (err u109))
(define-constant ERR-DEADLINE-NOT-REACHED (err u110))
(define-constant ERR-ALREADY-PROPOSED (err u111))
(define-constant ERR-NO-PROPOSAL (err u112))
(define-constant ERR-COOLDOWN-PASSED (err u113))
(define-constant ERR-NOTHING-TO-ATTRIBUTE (err u114))

(define-data-var lender principal tx-sender)
(define-data-var operator principal tx-sender)
(define-data-var interest-bps uint u1250)          ;; default 2%
(define-data-var available-sbtc uint u0)          ;; ready for new borrows
(define-data-var next-loan-id uint u1)
(define-data-var swapped-loan (optional uint) none) ;; at most one STATUS-SWAPPED loan

(define-map whitelist-active principal bool)
(define-map whitelist-proposed principal uint)

(define-map loans uint {
  borrower: principal,
  sbtc-principal: uint,
  interest-bps: uint,
  jing-cycle: uint,        ;; set at swap
  deadline: uint,          ;; set at swap
  status: uint
})

;; ---------- Read-only ----------

(define-read-only (get-lender) (var-get lender))
(define-read-only (get-operator) (var-get operator))
(define-read-only (get-interest-bps) (var-get interest-bps))
(define-read-only (get-available-sbtc) (var-get available-sbtc))
(define-read-only (get-swapped-loan) (var-get swapped-loan))
(define-read-only (get-loan (loan-id uint)) (map-get? loans loan-id))

(define-read-only (is-whitelisted (who principal))
  (if (default-to false (map-get? whitelist-active who))
      true
      (match (map-get? whitelist-proposed who)
        proposed-block (>= burn-block-height (+ proposed-block WHITELIST-COOLDOWN))
        false)))

(define-read-only (owed-on-loan (loan-id uint))
  (match (map-get? loans loan-id)
    loan (ok (+ (get sbtc-principal loan)
                (/ (* (get sbtc-principal loan) (get interest-bps loan)) BPS_PRECISION)))
    ERR-LOAN-NOT-FOUND))

;; ---------- Admin ----------

(define-public (set-lender (new-lender principal))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (var-set lender new-lender)
    (ok true)))

(define-public (set-operator (new-operator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR-NOT-OPERATOR)
    (var-set operator new-operator)
    (ok true)))

(define-public (set-interest-bps (bps uint))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (var-set interest-bps bps)
    (ok true)))

;; ---------- Funding ----------

(define-public (fund (amount uint))
  (let ((caller tx-sender))
    (asserts! (is-eq caller (var-get lender)) ERR-NOT-LENDER)
    (try! (contract-call? SBTC transfer amount caller (as-contract tx-sender) none))
    (var-set available-sbtc (+ (var-get available-sbtc) amount))
    (print { event: "fund", amount: amount })
    (ok true)))

(define-public (withdraw-funds (amount uint))
  (let ((caller tx-sender))
    (asserts! (is-eq caller (var-get lender)) ERR-NOT-LENDER)
    (asserts! (<= amount (var-get available-sbtc)) ERR-INSUFFICIENT-FUNDS)
    (try! (as-contract (contract-call? SBTC transfer amount tx-sender caller none)))
    (var-set available-sbtc (- (var-get available-sbtc) amount))
    (print { event: "withdraw-funds", amount: amount })
    (ok true)))

;; ---------- Whitelist ----------

(define-public (propose-whitelist (borrower principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR-NOT-OPERATOR)
    (asserts! (is-none (map-get? whitelist-proposed borrower)) ERR-ALREADY-PROPOSED)
    (asserts! (not (default-to false (map-get? whitelist-active borrower))) ERR-ALREADY-PROPOSED)
    (map-set whitelist-proposed borrower burn-block-height)
    (print { event: "propose-whitelist", borrower: borrower, at: burn-block-height })
    (ok true)))

(define-public (veto-whitelist (borrower principal))
  (let ((proposed (unwrap! (map-get? whitelist-proposed borrower) ERR-NO-PROPOSAL))
        (caller tx-sender))
    (asserts! (or (is-eq caller (var-get lender))
                  (is-eq caller (var-get operator))) ERR-NOT-OPERATOR)
    (asserts! (< burn-block-height (+ proposed WHITELIST-COOLDOWN)) ERR-COOLDOWN-PASSED)
    (map-delete whitelist-proposed borrower)
    (print { event: "veto-whitelist", borrower: borrower })
    (ok true)))

(define-public (finalize-whitelist (borrower principal))
  (let ((proposed (unwrap! (map-get? whitelist-proposed borrower) ERR-NO-PROPOSAL)))
    (asserts! (>= burn-block-height (+ proposed WHITELIST-COOLDOWN)) ERR-COOLDOWN-PASSED)
    (map-delete whitelist-proposed borrower)
    (map-set whitelist-active borrower true)
    (print { event: "finalize-whitelist", borrower: borrower })
    (ok true)))

;; ---------- Loan lifecycle ----------

;; Step 1: create loan, lock sBTC. No Jing interaction.
(define-public (borrow (amount uint))
  (let ((caller tx-sender)
        (loan-id (var-get next-loan-id)))
    (asserts! (is-whitelisted caller) ERR-NOT-WHITELISTED)
    (asserts! (>= amount MIN-SBTC-BORROW) ERR-AMOUNT-TOO-LOW)
    (asserts! (<= amount (var-get available-sbtc)) ERR-INSUFFICIENT-FUNDS)
    (var-set available-sbtc (- (var-get available-sbtc) amount))
    (map-set loans loan-id {
      borrower: caller,
      sbtc-principal: amount,
      interest-bps: (var-get interest-bps),
      jing-cycle: u0,
      deadline: u0,
      status: STATUS-PRE-SWAP
    })
    (var-set next-loan-id (+ loan-id u1))
    (print { event: "borrow", loan-id: loan-id, borrower: caller, amount: amount })
    (ok loan-id)))

;; Step 2: deposit sBTC into Jing, start deadline. Only the loan's borrower.
(define-public (swap (loan-id uint) (limit-price uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (jing-cycle (contract-call? JING-MARKET get-current-cycle))
        (deadline (+ burn-block-height CLAWBACK-DELAY)))
    (asserts! (is-eq caller (get borrower loan)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-PRE-SWAP) ERR-BAD-STATUS)
    (asserts! (is-none (var-get swapped-loan)) ERR-SWAPPED-LOAN-EXISTS)
    (try! (as-contract (contract-call? JING-MARKET deposit-sbtc
            (get sbtc-principal loan) limit-price)))
    (map-set loans loan-id (merge loan {
      jing-cycle: jing-cycle,
      deadline: deadline,
      status: STATUS-SWAPPED
    }))
    (var-set swapped-loan (some loan-id))
    (print { event: "swap", loan-id: loan-id, amount: (get sbtc-principal loan),
             limit: limit-price, cycle: jing-cycle, deadline: deadline })
    (ok true)))

;; Cancel a pre-swap loan and return sBTC to available. Borrower only.
(define-public (cancel (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq caller (get borrower loan)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-PRE-SWAP) ERR-BAD-STATUS)
    (var-set available-sbtc (+ (var-get available-sbtc) (get sbtc-principal loan)))
    (map-set loans loan-id (merge loan { status: STATUS-CANCELLED }))
    (print { event: "cancel", loan-id: loan-id })
    (ok true)))

;; Repay principal + interest in sBTC to lender; release STX to borrower.
;; STX attribution is inline: contract balance minus already-assigned STX.
(define-public (repay (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq caller (get borrower loan)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-SWAPPED) ERR-BAD-STATUS)
    (let ((now-cycle (contract-call? JING-MARKET get-current-cycle)))
      (asserts! (> now-cycle (get jing-cycle loan)) ERR-NOT-SETTLED))
    (let ((available-stx (stx-get-balance (as-contract tx-sender))))
      (asserts! (> available-stx u0) ERR-NOTHING-TO-ATTRIBUTE)
      (let ((owed (+ (get sbtc-principal loan)
                     (/ (* (get sbtc-principal loan) (get interest-bps loan)) BPS_PRECISION)))
            (borrower (get borrower loan))
            (lender-principal (var-get lender)))
        (try! (contract-call? SBTC transfer owed caller lender-principal none))
        (try! (as-contract (stx-transfer? available-stx tx-sender borrower)))
        (map-set loans loan-id (merge loan { status: STATUS-REPAID }))
        (var-set swapped-loan none)
        (print { event: "repay", loan-id: loan-id, sbtc-paid: owed,
                 stx-released: available-stx })
        (ok true)))))

;; After deadline, lender takes the STX collateral.
(define-public (seize (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq caller (var-get lender)) ERR-NOT-LENDER)
    (asserts! (is-eq (get status loan) STATUS-SWAPPED) ERR-BAD-STATUS)
    (asserts! (>= burn-block-height (get deadline loan)) ERR-DEADLINE-NOT-REACHED)
    (let ((now-cycle (contract-call? JING-MARKET get-current-cycle)))
      (asserts! (> now-cycle (get jing-cycle loan)) ERR-NOT-SETTLED))
    (let ((available-stx (stx-get-balance (as-contract tx-sender))))
      (asserts! (> available-stx u0) ERR-NOTHING-TO-ATTRIBUTE)
      (let ((lender-principal (var-get lender)))
        (try! (as-contract (stx-transfer? available-stx tx-sender lender-principal)))
        (map-set loans loan-id (merge loan { status: STATUS-SEIZED }))
        (var-set swapped-loan none)
        (print { event: "seize", loan-id: loan-id, stx-seized: available-stx })
        (ok true)))))
