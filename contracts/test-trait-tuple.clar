(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; Test 1: trait inside a tuple as a function parameter
(define-public (test-tuple-param (entry { who: principal, t: <ft-trait> }))
  (contract-call? (get t entry) transfer u1 tx-sender (get who entry) none))

;; Test 2: trait inside a list of tuples, mapped over
(define-private (process-one (entry { who: principal, t: <ft-trait> }))
  (contract-call? (get t entry) transfer u1 tx-sender (get who entry) none))

(define-public (test-list-map (entries (list 50 { who: principal, t: <ft-trait> })))
  (begin
    (map process-one entries)
    (ok true)))

;; Test 3: trait inside an optional
(define-public (test-optional (maybe-t (optional <ft-trait>)))
  (match maybe-t
    t (contract-call? t transfer u1 tx-sender tx-sender none)
    (ok true)))
