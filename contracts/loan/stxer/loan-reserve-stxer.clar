;; loan-reserve
;;
;; Pooled sBTC funding layer for per-borrower swap-now-pay-later
;; (snpl) loan contracts. Source code is canonical: the lender
;; principal is set at deploy via `initialize` rather than baked into
;; the source, so every reserve deployment hashes to the same
;; bytecode.
;;
;; Lifecycle:
;;   0. `initialize`   - deployer (the principal that ran the deploy
;;                       tx) sets the lender. Until called, the
;;                       lender var equals SAINT and all admin and
;;                       withdraw functions revert.
;;   1. Lender `supply`s sBTC.
;;   2. Lender opens a credit line per snpl with a borrower principal,
;;      a credit cap, and an interest rate (bps).
;;   3. Snpls `draw` at borrow time, `notify-return` at repay / seize.
;;   4. Lender `withdraw-sbtc` (return supplied capital) or
;;      `withdraw-stx` (sweep STX from seized loans) at any time.
;;
;; The reserve also enforces a global minimum draw (`min-sbtc-draw`),
;; tunable by the lender, applied uniformly across all snpls.
;;
;; No Jing awareness. All auction logic lives in the snpls.
;;
;; Trust model: the bytecode of a snpl must be verified by the
;; lender before calling `open-credit-line`. The reserve trusts any
;; snpl with an open line to call `draw` / `notify-return`
;; correctly.

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
;; Sentinel. Pre-init the lender var equals SAINT, blocking all admin
;; functions (including withdraws) until `initialize` is called.
(define-constant SAINT 'SP000000000000000000002Q6VF78)
;; Captured at deploy time. Source code is canonical across deployments;
;; only the deployer can call `initialize`.
(define-constant DEPLOYER tx-sender)

(impl-trait .reserve-trait.reserve-trait)
(use-trait snpl-trait .snpl-trait.snpl-trait)

(define-constant ERR-NOT-LENDER (err u200))
(define-constant ERR-NO-CREDIT-LINE (err u201))
(define-constant ERR-OVER-LIMIT (err u202))
(define-constant ERR-INVALID-AMOUNT (err u204))
(define-constant ERR-LINE-EXISTS (err u205))
(define-constant ERR-LINE-NOT-FOUND (err u206))
(define-constant ERR-OUTSTANDING-NONZERO (err u207))
(define-constant ERR-UNDERFLOW (err u208))
(define-constant ERR-PAUSED (err u209))
(define-constant ERR-BORROWER-MISMATCH (err u210))
(define-constant ERR-NOT-DEPLOYER (err u211))
(define-constant ERR-ALREADY-INIT (err u212))

(define-data-var lender principal SAINT)
(define-data-var paused bool false)
(define-data-var min-sbtc-draw uint u1000000) ;; 0.01 sBTC, applied across all snpls

(define-map credit-lines principal {
  borrower: principal,
  cap-sbtc: uint,
  interest-bps: uint,
  outstanding-sbtc: uint
})

;; ---------- Read-only ----------

(define-read-only (get-lender) (var-get lender))
(define-read-only (is-paused) (var-get paused))
(define-read-only (get-min-sbtc-draw) (var-get min-sbtc-draw))
(define-read-only (get-credit-line (snpl principal)) (map-get? credit-lines snpl))
(define-read-only (has-credit-line (snpl principal))
  (is-some (map-get? credit-lines snpl)))

;; ---------- Initialization ----------

;; One-shot: deployer sets the lender. Until called, the lender var
;; equals SAINT, blocking all admin functions and withdraws.
(define-public (initialize (init-lender principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR-NOT-DEPLOYER)
    (asserts! (is-eq (var-get lender) SAINT) ERR-ALREADY-INIT)
    (var-set lender init-lender)
    (print { event: "initialize", lender: init-lender })
    (ok true)))

;; ---------- Lender supply / withdraw ----------

(define-public (supply (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (try! (contract-call? SBTC transfer amount tx-sender current-contract none))
    (print { event: "supply", amount: amount })
    (ok true)))

(define-public (withdraw-sbtc (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract (var-get lender) none))))
    (print { event: "withdraw-sbtc", amount: amount })
    (ok true)))

;; Sweeps STX accumulated from seized snpl loans back to the lender.
(define-public (withdraw-stx (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract (var-get lender)))))
    (print { event: "withdraw-stx", amount: amount })
    (ok true)))

;; ---------- Credit lines (lender-gated) ----------

(define-public (open-credit-line (snpl <snpl-trait>) (borrower principal) (cap-sbtc uint) (interest-bps uint))
  (let ((snpl-addr (contract-of snpl)))
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (asserts! (is-none (map-get? credit-lines snpl-addr)) ERR-LINE-EXISTS)
    (asserts! (is-eq (try! (contract-call? snpl get-borrower)) borrower) ERR-BORROWER-MISMATCH)
    (map-set credit-lines snpl-addr {
      borrower: borrower,
      cap-sbtc: cap-sbtc,
      interest-bps: interest-bps,
      outstanding-sbtc: u0
    })
    (print { event: "open-credit-line",
             snpl: snpl-addr,
             borrower: borrower,
             cap-sbtc: cap-sbtc,
             interest-bps: interest-bps })
    (ok true)))

(define-public (set-credit-line-cap (snpl principal) (new-cap uint))
  (let ((line (unwrap! (map-get? credit-lines snpl) ERR-LINE-NOT-FOUND)))
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (map-set credit-lines snpl (merge line { cap-sbtc: new-cap }))
    (print { event: "set-credit-line-cap", snpl: snpl, cap-sbtc: new-cap })
    (ok true)))

;; Adjusts the rate for future loans on this line. Existing loans keep
;; the rate that was stamped on them at `borrow` time.
(define-public (set-credit-line-interest (snpl principal) (new-bps uint))
  (let ((line (unwrap! (map-get? credit-lines snpl) ERR-LINE-NOT-FOUND)))
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (map-set credit-lines snpl (merge line { interest-bps: new-bps }))
    (print { event: "set-credit-line-interest", snpl: snpl, interest-bps: new-bps })
    (ok true)))

;; Only callable when outstanding is zero (no in-flight loans on this snpl).
(define-public (close-credit-line (snpl principal))
  (let ((line (unwrap! (map-get? credit-lines snpl) ERR-LINE-NOT-FOUND)))
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (asserts! (is-eq (get outstanding-sbtc line) u0) ERR-OUTSTANDING-NONZERO)
    (map-delete credit-lines snpl)
    (print { event: "close-credit-line", snpl: snpl })
    (ok true)))

(define-public (set-paused (new-paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (var-set paused new-paused)
    (print { event: "set-paused", paused: new-paused })
    (ok true)))

;; Sets the global minimum draw across all snpls. Lender only.
(define-public (set-min-sbtc-draw (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get lender)) ERR-NOT-LENDER)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (var-set min-sbtc-draw amount)
    (print { event: "set-min-sbtc-draw", amount: amount })
    (ok true)))

;; ---------- Draw / notify-return (snpl-gated) ----------

;; Called by a snpl with an open credit line during its `borrow`.
;; Pushes sBTC to the snpl, bumps outstanding, enforces global min
;; draw and credit cap. Returns the line's interest-bps so the snpl
;; can stamp it onto the loan record.
(define-public (draw (amount uint))
  (let ((caller contract-caller)
        (line (unwrap! (map-get? credit-lines caller) ERR-NO-CREDIT-LINE))
        (current (get outstanding-sbtc line))
        (cap (get cap-sbtc line))
        (new-outstanding (+ current amount)))
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (>= amount (var-get min-sbtc-draw)) ERR-INVALID-AMOUNT)
    (asserts! (<= new-outstanding cap) ERR-OVER-LIMIT)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract caller none))))
    (map-set credit-lines caller (merge line { outstanding-sbtc: new-outstanding }))
    (print { event: "draw", 
             snpl: caller, 
             amount: amount,
             new-outstanding-sbtc: new-outstanding })
    (ok (get interest-bps line))))

;; Called by a snpl at `repay` / `seize` to release principal against
;; outstanding. The snpl's bytecode must have been approved by the
;; lender; the reserve trusts the reported amount.
(define-public (notify-return (notional uint))
  (let ((caller contract-caller)
        (line (unwrap! (map-get? credit-lines caller) ERR-NO-CREDIT-LINE))
        (current (get outstanding-sbtc line)))
    (asserts! (<= notional current) ERR-UNDERFLOW)
    (map-set credit-lines caller (merge line {
      outstanding-sbtc: (- current notional)
    }))
    (print { event: "notify-return",
             snpl: caller,
             amount: notional,
             new-outstanding-sbtc: (- current notional) })
    (ok true)))
