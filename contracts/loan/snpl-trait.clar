;; snpl-trait
;;
;; Interface for swap-now-pay-later (snpl) loan contracts that draw
;; from loan-reserve. The reserve uses `get-borrower` at credit-line
;; opening to verify the snpl's configured borrower matches the
;; principal the lender intended to fund. The lifecycle functions
;; (`borrow` / `repay` / `seize`) and read-only views (`get-loan` /
;; `get-active-loan`) are exposed so consumers (UIs, indexers,
;; batchers) can interact with any snpl through the trait.
;;
;; Note: `get-loan` locks in the loan record shape. v2 snpl variants
;; that need different fields will require a trait revision.

(define-trait snpl-trait
  (
    (get-borrower () (response principal uint))
    (get-reserve () (response principal uint))
    (get-active-loan () (response (optional uint) uint))
    (get-loan (uint) (response (optional {
      notional-sbtc: uint,
      payoff-sbtc: uint,
      interest-bps: uint,
      jing-cycle: uint,
      deadline: uint,
      position-stx: uint,
      limit-price: uint,
      status: uint
    }) uint))
    (borrow (uint uint) (response uint uint))
    (repay (uint) (response bool uint))
    (seize (uint) (response bool uint))
  ))
