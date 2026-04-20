;; jing-loan-sbtc-for-stx
;;
;; Lender funds sBTC. A whitelisted borrower takes a loan in three steps:
;;   1. `borrow`                 - locks sBTC, creates the loan record.
;;   2. `swap`                   - deposits sBTC into Jing v2 (sbtc-stx-0-jing-v2)
;;                                 during a deposit phase. Starts clawback deadline.
;;   3. `record-stx-collateral`  - after Jing settles, snapshots STX received and
;;                                 writes it into the loan record.
;;
;; Splitting the flow keeps each tx cheap (no atomic close+settle with Pyth VAAs)
;; and lets the borrower time the swap to a live Jing deposit phase. Recording
;; collateral separately makes the loan record fully auditable before repay/seize.
;;
;; Only ONE loan in STATUS-SWAPPED at a time, so the contract STX balance is
;; always fully attributable to the single active loan.

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant JING-MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2)

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
(define-constant ERR-NOTHING-TO-ATTRIBUTE (err u114))
(define-constant ERR-COOLDOWN-NOT-PASSED (err u115))
(define-constant ERR-ALREADY-ACTIVE (err u116))
(define-constant ERR-OVER-LIMIT (err u117))

(define-data-var lender principal tx-sender)
(define-data-var operator principal tx-sender)
(define-data-var interest-bps uint u1250)          ;; default 12.5%
(define-data-var available-sbtc uint u0)          ;; ready for new borrows
(define-data-var next-loan-id uint u1)
(define-data-var swapped-loan (optional uint) none) ;; at most one STATUS-SWAPPED loan
(define-data-var min-sbtc-borrow uint u1000000) ;; 0.01 sBTC (sats)

(define-map whitelist-active principal bool)
(define-map whitelist-proposed principal uint)
(define-map borrower-limit principal uint)  ;; lender-set credit limit per borrower
(define-map borrower-debt principal uint)   ;; sum of unresolved sBTC principals per borrower

(define-map loans uint {
  borrower: principal,
  sbtc-principal: uint,
  interest-bps: uint,
  jing-cycle: uint,        ;; set at swap
  deadline: uint,          ;; set at swap
  stx-collateral: uint,    ;; set at record-stx-collateral, after Jing settles
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
  (default-to false (map-get? whitelist-active who)))

(define-read-only (get-borrower-limit (who principal))
  (default-to u0 (map-get? borrower-limit who)))

(define-read-only (get-borrower-debt (who principal))
  (default-to u0 (map-get? borrower-debt who)))

(define-read-only (get-borrower-available (who principal))
  (let ((limit (default-to u0 (map-get? borrower-limit who)))
        (debt (default-to u0 (map-get? borrower-debt who))))
    (if (> limit debt) (- limit debt) u0)))

(define-read-only (owed-on-loan (loan-id uint))
  (match (map-get? loans loan-id)
    loan (ok (+ (get sbtc-principal loan)
                (/ (* (get sbtc-principal loan) (get interest-bps loan)) BPS_PRECISION)))
    ERR-LOAN-NOT-FOUND))

;; ---------- Admin ----------

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

(define-public (set-min-sbtc-borrow (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (var-set min-sbtc-borrow amount)
    (ok true)))

;; Lender sets (or resets) the credit limit for a borrower. Can be raised or lowered.
;; Applies to cumulative unresolved debt, does not affect existing loans.
(define-public (set-borrower-limit (who principal) (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (map-set borrower-limit who amount)
    (print { event: "set-borrower-limit", who: who, limit: amount })
    (ok true)))

;; ---------- Funding ----------

(define-public (fund (amount uint))
  (let ((caller tx-sender))
    (asserts! (is-eq caller (var-get lender)) ERR-NOT-LENDER)
    (try! (contract-call? SBTC transfer amount caller current-contract none))
    (var-set available-sbtc (+ (var-get available-sbtc) amount))
    (print { event: "fund", amount: amount, available-sbtc: available-sbtc })
    (ok true)))

(define-public (withdraw-funds (amount uint))
  (let ((caller tx-sender)
        (liquid (var-get available-sbtc)))
    (asserts! (is-eq caller (var-get lender)) ERR-NOT-LENDER)
    (asserts! (<= amount liquid) ERR-INSUFFICIENT-FUNDS)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract caller none))))
    (var-set available-sbtc (- liquid amount))
    (print { event: "withdraw-funds", amount: amount, available-sbtc: liquid })
    (ok true)))

;; ---------- Whitelist ----------

(define-public (propose-whitelist (borrower principal))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (asserts! (is-none (map-get? whitelist-proposed borrower)) ERR-ALREADY-PROPOSED)
    (asserts! (not (default-to false (map-get? whitelist-active borrower))) ERR-ALREADY-ACTIVE)
    (map-set whitelist-proposed borrower burn-block-height)
    (print { event: "propose-whitelist", borrower: borrower, at: burn-block-height })
    (ok true)))

;; Step 2 of whitelisting: after cooldown, operator confirms to activate.
(define-public (confirm-whitelist (borrower principal))
  (let ((proposed (unwrap! (map-get? whitelist-proposed borrower) ERR-NO-PROPOSAL)))
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (asserts! (>= burn-block-height (+ proposed WHITELIST-COOLDOWN)) ERR-COOLDOWN-NOT-PASSED)
    (map-delete whitelist-proposed borrower)
    (map-set whitelist-active borrower true)
    (print { event: "confirm-whitelist", borrower: borrower })
    (ok true)))

;; Blacklist: lender removes a borrower from the whitelist at any point
;; (pre- or post-confirmation). E.g., after a default. Clears both maps.
(define-public (blacklist-borrower (who principal))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (asserts! (or (default-to false (map-get? whitelist-active who))
                  (is-some (map-get? whitelist-proposed who))) ERR-NOT-WHITELISTED)
    (map-delete whitelist-active who)
    (map-delete whitelist-proposed who)
    (print { event: "blacklist-borrower", who: who })
    (ok true)))

;; ---------- Loan lifecycle ----------

;; Step 1: create loan, lock sBTC. No Jing interaction.
;; Enforces borrower credit limit: cumulative unresolved debt + this amount <= limit.
(define-public (borrow (amount uint))
  (let ((caller tx-sender)
        (loan-id (var-get next-loan-id))
        (liquid (var-get available-sbtc))
        (current-debt (default-to u0 (map-get? borrower-debt caller)))
        (limit (default-to u0 (map-get? borrower-limit caller))))
    (asserts! (is-whitelisted caller) ERR-NOT-WHITELISTED)
    (asserts! (>= amount (var-get min-sbtc-borrow)) ERR-AMOUNT-TOO-LOW)
    (asserts! (<= amount liquid) ERR-INSUFFICIENT-FUNDS)
    (asserts! (<= (+ current-debt amount) limit) ERR-OVER-LIMIT)
    (var-set available-sbtc (- liquid amount))
    (map-set borrower-debt caller (+ current-debt amount))
    (map-set loans loan-id {
      borrower: caller,
      sbtc-principal: amount,
      interest-bps: (var-get interest-bps),
      jing-cycle: u0,
      deadline: u0,
      stx-collateral: u0,
      status: STATUS-PRE-SWAP
    })
    (var-set next-loan-id (+ loan-id u1))
    (print { event: "borrow", loan-id: loan-id, borrower: caller,
             amount: amount, new-debt: (+ current-debt amount) })
    (ok loan-id)))

;; Step 2: deposit sBTC into Jing, start deadline. Only the loan's borrower.
(define-public (swap (loan-id uint) (limit-price uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender)
        (jing-cycle (contract-call? JING-MARKET get-current-cycle))
        (deadline (+ burn-block-height CLAWBACK-DELAY))) ;; no this should start to count on borrow not on swap
    (asserts! (is-eq caller (get borrower loan)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-PRE-SWAP) ERR-BAD-STATUS)
    (asserts! (is-none (var-get swapped-loan)) ERR-SWAPPED-LOAN-EXISTS)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? JING-MARKET deposit-sbtc
            (get sbtc-principal loan) limit-price))))
    (map-set loans loan-id (merge loan {
      jing-cycle: jing-cycle,
      deadline: deadline,
      status: STATUS-SWAPPED
    }))
    (var-set swapped-loan (some loan-id))
    (print { event: "swap", loan-id: loan-id, amount: (get sbtc-principal loan),
             limit: limit-price, cycle: jing-cycle, deadline: deadline })
    (ok true)))

;; Step 3: after Jing settles, record the STX collateral on the loan. Anyone can call.
(define-public (record-stx-collateral (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (now-cycle (contract-call? JING-MARKET get-current-cycle)))
    (asserts! (is-eq (get status loan) STATUS-SWAPPED) ERR-BAD-STATUS)
    (asserts! (is-eq (get stx-collateral loan) u0) ERR-BAD-STATUS)
    (asserts! (> now-cycle (get jing-cycle loan)) ERR-NOT-SETTLED)
    (let ((stx-balance (stx-get-balance current-contract)))
      (asserts! (> stx-balance u0) ERR-NOTHING-TO-ATTRIBUTE)
      (map-set loans loan-id (merge loan { stx-collateral: stx-balance }))
      (print { event: "record-stx-collateral", loan-id: loan-id, stx: stx-balance })
      (ok stx-balance))))

;; Cancel a pre-swap loan and return sBTC to available. Borrower only.
(define-public (cancel (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq caller (get borrower loan)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-PRE-SWAP) ERR-BAD-STATUS)
    (let ((principal (get sbtc-principal loan))
          (borrower (get borrower loan))
          (current-debt (default-to u0 (map-get? borrower-debt (get borrower loan)))))
      (var-set available-sbtc (+ (var-get available-sbtc) principal))
      (map-set borrower-debt borrower (- current-debt principal))
      (map-set loans loan-id (merge loan { status: STATUS-CANCELLED }))
      (print { event: "cancel", loan-id: loan-id, new-debt: (- current-debt principal) })
      (ok true))))

;; Repay principal + interest in sBTC to lender; release recorded STX to borrower.
;; Requires `record-stx-collateral` to have been called first.
(define-public (repay (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq caller (get borrower loan)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-SWAPPED) ERR-BAD-STATUS)
    (asserts! (> (get stx-collateral loan) u0) ERR-NOTHING-TO-ATTRIBUTE)
    (let ((principal (get sbtc-principal loan))
          (owed (+ (get sbtc-principal loan)
                   (/ (* (get sbtc-principal loan) (get interest-bps loan)) BPS_PRECISION)))
          (stx-out (get stx-collateral loan))
          (borrower (get borrower loan))
          (lender-principal (var-get lender))
          (current-debt (default-to u0 (map-get? borrower-debt (get borrower loan)))))
      (try! (contract-call? SBTC transfer owed caller lender-principal none))
      (try! (as-contract (stx-transfer? stx-out tx-sender borrower)))
      (map-set borrower-debt borrower (- current-debt principal))
      (map-set loans loan-id (merge loan { status: STATUS-REPAID }))
      (var-set swapped-loan none)
      (print { event: "repay", loan-id: loan-id, sbtc-paid: owed,
               stx-released: stx-out, new-debt: (- current-debt principal) })
      (ok true))))

;; After deadline, lender takes the recorded STX collateral.
;; Requires `record-stx-collateral` to have been called first.
(define-public (seize (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (caller tx-sender))
    (asserts! (is-eq caller (var-get lender)) ERR-NOT-LENDER)
    (asserts! (is-eq (get status loan) STATUS-SWAPPED) ERR-BAD-STATUS)
    (asserts! (>= burn-block-height (get deadline loan)) ERR-DEADLINE-NOT-REACHED)
    (asserts! (> (get stx-collateral loan) u0) ERR-NOTHING-TO-ATTRIBUTE)
    (let ((principal (get sbtc-principal loan))
          (stx-out (get stx-collateral loan))
          (borrower (get borrower loan))
          (lender-principal (var-get lender))
          (current-debt (default-to u0 (map-get? borrower-debt (get borrower loan)))))
      (try! (as-contract (stx-transfer? stx-out tx-sender lender-principal)))
      (map-set borrower-debt borrower (- current-debt principal))
      (map-set loans loan-id (merge loan { status: STATUS-SEIZED }))
      (var-set swapped-loan none)
      (print { event: "seize", loan-id: loan-id, stx-seized: stx-out,
               new-debt: (- current-debt principal) })
      (ok true))))
