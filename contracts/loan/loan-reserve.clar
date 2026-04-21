;; loan-reserve
;;
;; Pooled sBTC funding layer for per-borrower loan singles.
;;
;; Lender supplies sBTC, approves individual deployed singles with a
;; borrower principal and a credit limit. Approved singles pull capital
;; at `borrow` time via `disburse`, and notify the reserve of returning
;; principal at `repay` / `seize` / `cancel` via `notify-return`.
;;
;; No Jing awareness. All auction logic lives in the singles.
;;
;; Trust model: the bytecode of an approved single must be verified by
;; the lender before calling `approve-single`. The reserve trusts any
;; approved single to call `disburse` / `notify-return` correctly.

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
;; Lender EOA. REPLACE BEFORE DEPLOYMENT.
(define-constant LENDER 'SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M)

(define-constant ERR-NOT-LENDER (err u200))
(define-constant ERR-NOT-APPROVED-SINGLE (err u201))
(define-constant ERR-OVER-LIMIT (err u202))
(define-constant ERR-INSUFFICIENT-LIQUIDITY (err u203))
(define-constant ERR-INVALID-AMOUNT (err u204))
(define-constant ERR-ALREADY-APPROVED (err u205))
(define-constant ERR-APPROVAL-NOT-FOUND (err u206))
(define-constant ERR-OUTSTANDING-NONZERO (err u207))
(define-constant ERR-UNDERFLOW (err u208))
(define-constant ERR-PAUSED (err u209))

(define-data-var paused bool false)

(define-map approvals principal {
  borrower: principal,
  limit: uint,
  outstanding: uint
})

;; ---------- Read-only ----------

(define-read-only (get-lender) LENDER)
(define-read-only (is-paused) (var-get paused))
(define-read-only (get-approval (single principal)) (map-get? approvals single))
(define-read-only (is-approved-single (single principal))
  (is-some (map-get? approvals single)))
(define-private (get-sbtc-balance)
  (unwrap-panic (contract-call? SBTC get-balance current-contract)))

;; ---------- Lender supply / withdraw ----------

(define-public (supply (amount uint))
  (begin
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (try! (contract-call? SBTC transfer amount tx-sender current-contract none))
    (print { event: "supply", amount: amount })
    (ok true)))

(define-public (withdraw (amount uint))
  (let ((bal (get-sbtc-balance)))
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (asserts! (<= amount bal) ERR-INSUFFICIENT-LIQUIDITY)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract LENDER none))))
    (print { event: "withdraw", amount: amount })
    (ok true)))

;; ---------- Approvals (lender-gated) ----------

(define-public (approve-single (single principal) (borrower principal) (limit uint))
  (begin
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (asserts! (is-none (map-get? approvals single)) ERR-ALREADY-APPROVED)
    (map-set approvals single { borrower: borrower, limit: limit, outstanding: u0 })
    (print { event: "approve-single", single: single, borrower: borrower, limit: limit })
    (ok true)))

(define-public (set-limit (single principal) (new-limit uint))
  (let ((app (unwrap! (map-get? approvals single) ERR-APPROVAL-NOT-FOUND)))
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (map-set approvals single (merge app { limit: new-limit }))
    (print { event: "set-limit", single: single, limit: new-limit })
    (ok true)))

;; Only callable when outstanding is zero (no in-flight loans on this single).
(define-public (revoke-approval (single principal))
  (let ((app (unwrap! (map-get? approvals single) ERR-APPROVAL-NOT-FOUND)))
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (asserts! (is-eq (get outstanding app) u0) ERR-OUTSTANDING-NONZERO)
    (map-delete approvals single)
    (print { event: "revoke-approval", single: single })
    (ok true)))

(define-public (set-paused (new-paused bool))
  (begin
    (asserts! (is-eq tx-sender LENDER) ERR-NOT-LENDER)
    (var-set paused new-paused)
    (print { event: "set-paused", paused: new-paused })
    (ok true)))

;; ---------- Disburse / notify-return (single-gated) ----------

;; Called by an approved single during its `borrow`. Pushes sBTC to the
;; single, bumps outstanding, enforces credit limit and liquidity.
(define-public (disburse (amount uint))
  (let ((caller contract-caller)
        (app (unwrap! (map-get? approvals caller) ERR-NOT-APPROVED-SINGLE))
        (current (get outstanding app))
        (limit (get limit app))
        (bal (get-sbtc-balance)))
    (asserts! (not (var-get paused)) ERR-PAUSED)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (asserts! (<= (+ current amount) limit) ERR-OVER-LIMIT)
    (asserts! (<= amount bal) ERR-INSUFFICIENT-LIQUIDITY)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract caller none))))
    (map-set approvals caller (merge app { outstanding: (+ current amount) }))
    (print { event: "disburse", single: caller, amount: amount,
             new-outstanding: (+ current amount) })
    (ok true)))

;; Called by an approved single at `repay` / `seize` / `cancel` to
;; release principal against outstanding. The single's bytecode must
;; have been approved by the lender; the reserve trusts the reported
;; amount.
(define-public (notify-return (principal-returned uint))
  (let ((caller contract-caller)
        (app (unwrap! (map-get? approvals caller) ERR-NOT-APPROVED-SINGLE))
        (current (get outstanding app)))
    (asserts! (<= principal-returned current) ERR-UNDERFLOW)
    (map-set approvals caller (merge app {
      outstanding: (- current principal-returned)
    }))
    (print { event: "notify-return",
             single: caller,
             amount: principal-returned,
             new-outstanding: (- current principal-returned) })
    (ok true)))
