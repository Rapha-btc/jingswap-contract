(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; Can a fold accumulator carry a trait reference?
;; If yes: the keeper passes only one trait to settle; fold threads it
;; through to each callback invocation -- no per-entry tuple list.

(define-private (process-one
  (depositor principal)
  (acc { t: <ft-trait>, name: (string-ascii 32), count: uint }))
  (let ((tt (get t acc)))
    (unwrap-panic (as-contract? ((with-ft (contract-of tt) (get name acc) u1))
      (unwrap-panic (contract-call? tt transfer u1 current-contract depositor none))))
    (merge acc { count: (+ (get count acc) u1) })))

(define-public (drive
  (t <ft-trait>)
  (name (string-ascii 32))
  (depositors (list 50 principal)))
  (let ((final (fold process-one depositors { t: t, name: name, count: u0 })))
    (ok (get count final))))
