;; loan-sbtc-stx-0-jing
;;
;; Per-borrower loan contract specialized for sbtc-stx-0-jing-v2.
;; Funded just-in-time by a reserve contract conforming to
;; `reserve-trait`. Source code is canonical: every deployment hashes
;; to the same bytecode. The deployer wires up the borrower and
;; reserve via `initialize` (one-shot). The borrower can later swap
;; reserves between loans via `set-reserve`.
;;
;; One active loan at a time. N snpls run in parallel, each as its
;; own Jing depositor principal, with no cross-contamination at
;; Jing's per-principal layer.
;;
;; Flow:
;;   0. `initialize`   - deployer sets `borrower` and `reserve` vars.
;;                       Until called, the reserve var equals SAINT
;;                       (a sentinel) and all lifecycle calls revert.
;;   1. `borrow`       - draws sBTC from the configured reserve
;;                       (passed as a trait reference, asserted to
;;                       match the var), creates loan, starts
;;                       clawback deadline.
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
(use-trait reserve-trait .reserve-trait.reserve-trait)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant JING-MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2)
;; Sentinel. Pre-init the borrower and reserve vars equal SAINT, which
;; no real contract can match; any borrow/repay/seize attempt fails the
;; reserve assert until `initialize` is called.
(define-constant SAINT 'SP000000000000000000002Q6VF78)
;; Captured at deploy time. Source code is canonical across deployments;
;; the deployer (whoever ran the deploy tx) is the only one who can
;; call `initialize`.
(define-constant DEPLOYER tx-sender)

(define-constant CLAWBACK-DELAY u4200)
(define-constant BPS_PRECISION u10000)

;; Protocol fee: 10% of accrued interest is routed to the Jing treasury at
;; repay. No fee on seize. Hardcoded so canonical-bytecode snpls cannot
;; bypass the carve-out by setting a runtime var.
(define-constant JING-TREASURY 'SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE)
(define-constant FEE-BPS-OF-INTEREST u1000)

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
(define-constant ERR-PAST-DEADLINE (err u110))
(define-constant ERR-NOT-DEPLOYER (err u111))
(define-constant ERR-ALREADY-INIT (err u112))
(define-constant ERR-WRONG-RESERVE (err u113))

(define-data-var borrower principal SAINT)
(define-data-var current-reserve principal SAINT)
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

(define-read-only (get-reserve) (ok (var-get current-reserve)))
(define-read-only (get-borrower) (ok (var-get borrower)))
(define-read-only (get-active-loan) (ok (var-get active-loan)))
(define-read-only (get-loan (loan-id uint)) (ok (map-get? loans loan-id)))

(define-read-only (payoff-on-loan (loan-id uint))
  (match (map-get? loans loan-id)
    loan (ok (get payoff-sbtc loan))
    ERR-LOAN-NOT-FOUND))

(define-private (our-sbtc-in-jing (cycle uint))
  (contract-call? JING-MARKET get-sbtc-deposit cycle current-contract))

;; ---------- Initialization ----------

;; One-shot: deployer sets the borrower and reserve. After this, the
;; reserve var is no longer SAINT, so re-calling fails. Borrower can
;; then swap reserves later via `set-reserve` (subject to active-loan
;; gate).
(define-public (initialize (init-borrower principal) (init-reserve <reserve-trait>))
  (let ((init-reserve-addr (contract-of init-reserve)))
    (asserts! (is-eq tx-sender DEPLOYER) ERR-NOT-DEPLOYER)
    (asserts! (is-eq (var-get current-reserve) SAINT) ERR-ALREADY-INIT)
    (var-set borrower init-borrower)
    (var-set current-reserve init-reserve-addr)
    (print { event: "initialize",
             borrower: init-borrower,
             reserve: init-reserve-addr,
             snpl: current-contract })
    (ok true)))

;; Borrower switches to a different reserve between loans. Blocked
;; while a loan is active so the borrower can't redirect repay
;; proceeds away from the reserve that funded the loan.
(define-public (set-reserve (new-reserve <reserve-trait>))
  (let ((new-reserve-addr (contract-of new-reserve)))
    (asserts! (is-eq tx-sender (var-get borrower)) ERR-NOT-BORROWER)
    (asserts! (is-none (var-get active-loan)) ERR-ACTIVE-LOAN-EXISTS)
    (var-set current-reserve new-reserve-addr)
    (print { event: "set-reserve", reserve: new-reserve-addr, snpl: current-contract })
    (ok true)))

;; ---------- Loan lifecycle ----------

;; Step 1: draw sBTC from reserve, create loan, start clawback deadline.
;; Caller passes the configured reserve as a trait reference; we assert
;; it matches the var so the loan goes to the right place. Borrower
;; also passes the expected interest-bps as slippage protection; if
;; the lender has bumped the line's rate, the call reverts.
(define-public (borrow (amount uint) (interest-bps uint) (reserve <reserve-trait>))
  (let ((loan-id (var-get next-loan-id))
        (deadline (+ burn-block-height CLAWBACK-DELAY))
        (reserve-addr (contract-of reserve)))
    (asserts! (is-eq tx-sender (var-get borrower)) ERR-NOT-BORROWER)
    (asserts! (is-none (var-get active-loan)) ERR-ACTIVE-LOAN-EXISTS)
    (asserts! (is-eq reserve-addr (var-get current-reserve)) ERR-WRONG-RESERVE)
    (let ((line-bps (try! (contract-call? reserve draw amount))))
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
      (print { event: "borrow", 
               loan-id: loan-id, 
               amount: amount,
               borrower: tx-sender,
               snpl: current-contract,
               interest-bps: line-bps,
               deadline: deadline,
               reserve: reserve-addr })
      (ok loan-id))))

;; Step 2: deposit sBTC into Jing during a deposit phase. Past deadline,
;; this is blocked: depositing then would expose the borrower to losing
;; both the swap proceeds (STX) and any rolled sBTC to seize.
(define-public (swap-deposit (loan-id uint) (limit-price uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (jing-cycle (contract-call? JING-MARKET get-current-cycle))
        (amount (get notional-sbtc loan)))
    (asserts! (is-eq tx-sender (var-get borrower)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (asserts! (< burn-block-height (get deadline loan)) ERR-PAST-DEADLINE)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? JING-MARKET deposit-sbtc amount limit-price))))
    (map-set loans loan-id (merge loan {
      jing-cycle: jing-cycle,
      limit-price: limit-price
    }))
    (print { event: "swap-deposit", 
             loan-id: loan-id, 
             amount: amount,
             limit: limit-price, 
             cycle: jing-cycle,
             snpl: current-contract })
    (ok true)))

;; Pull sBTC back from Jing. Loan stays OPEN; recovered sBTC sits on
;; contract and can be redeposited (until deadline) or reconciled at
;; repay/seize via sbtc-balance. Borrower anytime; anyone after deadline.
(define-public (cancel-swap (loan-id uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND)))
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (asserts! (or (is-eq tx-sender (var-get borrower))
                  (>= burn-block-height (get deadline loan)))
              ERR-NOT-BORROWER)
    (try! (as-contract? ((with-all-assets-unsafe))
      (try! (contract-call? JING-MARKET cancel-sbtc-deposit))))
    (print { event: "cancel-swap", loan-id: loan-id, snpl: current-contract })
    (ok true)))

(define-public (set-swap-limit (loan-id uint) (limit-price uint))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND)))
    (asserts! (is-eq tx-sender (var-get borrower)) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (asserts! (< burn-block-height (get deadline loan)) ERR-PAST-DEADLINE)
    (map-set loans loan-id (merge loan { limit-price: limit-price }))
    (try! (as-contract? ()
      (try! (contract-call? JING-MARKET set-sbtc-limit limit-price))))
    (print { event: "set-swap-limit", limit-price: limit-price, snpl: current-contract })
    (ok true)))

(define-public (repay (loan-id uint) (reserve <reserve-trait>))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (notional (get notional-sbtc loan))
        (payoff (get payoff-sbtc loan))
        (interest (- payoff notional))
        ;; 10% of interest to Jing; rest to reserve. Total snpl outflow
        ;; remains `payoff`, just split across two destinations.
        (fee (/ (* interest FEE-BPS-OF-INTEREST) BPS_PRECISION))
        (lender-payoff (- payoff fee))
        (stx-out (stx-get-balance current-contract))
        ;; No prefunded lender capital in v2, so any sBTC on-contract is
        ;; borrower-side recovery (Jing eviction, cancel-swap, airdrop).
        (sbtc-balance (unwrap-panic (contract-call? SBTC get-balance current-contract)))
        (is-shortfall (> payoff sbtc-balance))
        ;; abs(payoff - sbtc-balance). Shortfall (common) = borrower
        ;; tops up; otherwise refund excess back to borrower.
        (delta (if is-shortfall (- payoff sbtc-balance) (- sbtc-balance payoff)))
        (reserve-addr (contract-of reserve))
        (borrower-addr (var-get borrower)))
    (asserts! (is-eq tx-sender borrower-addr) ERR-NOT-BORROWER)
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (asserts! (is-eq reserve-addr (var-get current-reserve)) ERR-WRONG-RESERVE)
    (asserts! (is-eq u0 (our-sbtc-in-jing
                          (contract-call? JING-MARKET get-current-cycle)))
              ERR-NOT-FULLY-RESOLVED)
    ;; Reconcile sBTC: borrower tops up shortfall, or refund excess (rare).
    (if is-shortfall
      (if (> delta u0)
        (try! (contract-call? SBTC transfer delta tx-sender current-contract none))
        true)
      (if (> delta u0)
        (try! (as-contract? ((with-ft SBTC "sbtc-token" delta))
          (try! (contract-call? SBTC transfer delta current-contract borrower-addr none))))
        true))
    ;; Protocol fee -> Jing treasury (skip on zero/sub-dust interest)
    (if (> fee u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" fee))
        (try! (contract-call? SBTC transfer fee current-contract JING-TREASURY none))))
      true)
    ;; Lender's share (payoff - fee) -> reserve
    (try! (as-contract? ((with-ft SBTC "sbtc-token" lender-payoff))
      (try! (contract-call? SBTC transfer lender-payoff current-contract reserve-addr none))))
    ;; Position STX to borrower
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract borrower-addr))))
      true)
    (try! (contract-call? reserve notify-return notional))
    (map-set loans loan-id (merge loan { position-stx: stx-out, status: STATUS-REPAID }))
    (var-set active-loan none)
    (print { event: "repay",
             loan-id: loan-id,
             payoff-sbtc: payoff,
             lender-payoff-sbtc: lender-payoff,
             fee-sbtc: fee,
             delta-sbtc: delta,
             is-shortfall: is-shortfall,
             stx-released: stx-out,
             snpl: current-contract,
             reserve: reserve-addr })
    (ok true)))

;; Permissionless past-deadline seize. Requires Jing to hold none of
;; our sBTC (cleared, rolled, or never deposited). All on-contract
;; sBTC + STX ships to the reserve.
(define-public (seize (loan-id uint) (reserve <reserve-trait>))
  (let ((loan (unwrap! (map-get? loans loan-id) ERR-LOAN-NOT-FOUND))
        (notional (get notional-sbtc loan))
        (stx-out (stx-get-balance current-contract))
        (sbtc-balance (unwrap-panic (contract-call? SBTC get-balance current-contract)))
        (reserve-addr (contract-of reserve)))
    (asserts! (is-eq (get status loan) STATUS-OPEN) ERR-BAD-STATUS)
    (asserts! (is-eq reserve-addr (var-get current-reserve)) ERR-WRONG-RESERVE)
    (asserts! (>= burn-block-height (get deadline loan)) ERR-DEADLINE-NOT-REACHED)
    (asserts! (is-eq u0 (our-sbtc-in-jing
                          (contract-call? JING-MARKET get-current-cycle)))
              ERR-NOT-FULLY-RESOLVED)
    (if (> stx-out u0)
      (try! (as-contract? ((with-stx stx-out))
        (try! (stx-transfer? stx-out current-contract reserve-addr))))
      true)
    (if (> sbtc-balance u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" sbtc-balance))
        (try! (contract-call? SBTC transfer sbtc-balance current-contract reserve-addr none))))
      true)
    (try! (contract-call? reserve notify-return notional))
    (map-set loans loan-id (merge loan { position-stx: stx-out, status: STATUS-SEIZED }))
    (var-set active-loan none)
    (print { event: "seize", 
             loan-id: loan-id,
             stx-seized: stx-out, 
             sbtc-seized: sbtc-balance,
             snpl: current-contract,
             reserve: reserve-addr })
    (ok true)))
