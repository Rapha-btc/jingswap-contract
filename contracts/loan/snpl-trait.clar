;; snpl-trait
;;
;; Interface for swap-now-pay-later (snpl) loan contracts that draw
;; from a reserve (see reserve-trait). The reserve uses `get-borrower`
;; at credit-line opening to verify the snpl's configured borrower
;; matches the principal the lender intended to fund. The lifecycle
;; functions (`borrow` / `repay` / `seize`) and read-only views
;; (`get-loan` / `get-active-loan`) are exposed so consumers (UIs,
;; indexers, batchers) can interact with any snpl through the trait.
;;
;; `borrow` / `repay` / `seize` each take a reserve-trait reference
;; that must match the snpl's currently configured reserve. This
;; lets the snpl call into the reserve dynamically while still
;; locking down which reserve is used for any given loan.
;;
;; Note: `get-loan` locks in the loan record shape. v2 snpl variants
;; that need different fields will require a trait revision.

(use-trait reserve-trait .reserve-trait.reserve-trait)

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
    (borrow (uint uint <reserve-trait>) (response uint uint))
    (repay (uint <reserve-trait>) (response bool uint))
    (seize (uint <reserve-trait>) (response bool uint))
  ))
