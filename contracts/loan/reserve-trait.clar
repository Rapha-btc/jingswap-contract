;; reserve-trait
;;
;; Interface for sBTC funding reserves that snpl loan contracts draw
;; against. The snpl calls `draw` to pull principal at borrow time and
;; `notify-return` to release principal at repay / seize. `draw`
;; returns the line's interest-bps so the snpl can stamp it onto the
;; loan record.

(define-trait reserve-trait
  (
    (draw (uint) (response uint uint))
    (notify-return (uint) (response bool uint))
  ))
