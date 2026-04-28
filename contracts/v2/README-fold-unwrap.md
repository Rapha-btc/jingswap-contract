# `try!` + response-wrapped accumulator in `distribute-to-*` fold callbacks

## TL;DR

`distribute-to-token-x-depositor` and `distribute-to-token-y-depositor` are `fold`
callbacks. Their accumulator is **response-wrapped** so that `try!` (rather than
`unwrap-panic`) can be used inside the callback. This preserves composability —
callers wrapping `settle` get a clean `(err uint)` they can react to instead of
an opaque runtime panic.

## Why response-wrapped acc, and not just a plain tuple?

`try!` is allowed only inside a function whose declared return type is
`(response …)` (or `(optional …)`). On `(err X)` it emits "return `(err X)`
from the current function" — the compiler must be able to type-check that
emission against the function's return type.

In `fold`, the callback's return type **is** the accumulator's type:

```
fold : ((A, Acc) -> Acc, list of A, Acc) -> Acc
```

The accumulator has to carry the SIP-10 trait + asset-name needed for the
per-depositor transfer. So if it's a plain tuple `{ t: <ft-trait>, name: ... }`,
the callback returns a plain tuple, and `try!` is **rejected by the compiler**
inside it. The only error-handling primitive left would be `unwrap-panic`.

Wrapping the accumulator in `(response { t: <ft-trait>, name: ... } uint)` lets
the callback return a response, which lets `try!` work inside it.

## The pattern

```clarity
;; callback
(define-private (distribute-to-token-y-depositor
  (depositor principal)
  (acc (response { t: <ft-trait>, name: (string-ascii 128) } uint)))
  (let (
    (unwrapped (try! acc))               ;; propagate any prior-iter err
    (tt (get t unwrapped))
    ...)
    ...
    (try! (as-contract? ((with-ft (contract-of tt) (get name unwrapped) ...))
            (try! (contract-call? tt transfer ...))))
    ...
    (try! (contract-call? .jing-core log-distribute-y-depositor ...))
    (ok unwrapped)))                     ;; thread the inner tuple

;; call site (in settle / settle-with-refresh)
(try! (fold distribute-to-token-y-depositor
            (get-token-y-depositors cycle)
            (ok { t: tx-trait, name: tx-name })))
```

Two pieces of ceremony to notice:
- Seed is wrapped: `(ok { ... })` instead of `{ ... }`
- Fold result is propagated: `(try! (fold ...))` so any in-fold err escapes settle

## Why this matters: composability

Per friedger.btc:

> `unwrap-panic` should only be used if you don't want to be composable. I usually
> use it if I know for sure that the result is an `(ok something)` and I want
> something.

`unwrap-panic` aborts the tx with a runtime panic — opaque, unmatchable, no error
code reaches the calling contract. Any contract that wraps `settle` (a vault, a
multi-step keeper bot, a router) loses the ability to:
- Distinguish "no depositors" from "transfer failed" from "wrong trait"
- Catch a specific error and fall back / retry / log
- Compose `settle` into a multi-step recipe and continue past expected errors

`try!` propagates a typed `(err uint)` upward through `fold` → `settle` →
caller, where it can be `match`ed and handled. End-state on failure is the
same (tx reverts), but the failure has shape rather than just being an abort.

## Where `unwrap-panic` IS still used

A few `(unwrap-panic (as-max-len? ...))` calls remain — these unpack a
`(some list)` from `as-max-len?` whose only failure mode is "list grew past 50
entries," which is structurally impossible after the upstream `MAX_DEPOSITORS`
guard. Same for the read-only `(unwrap-panic (contract-call? ...get-pool))`
oracle reads. Friedger's "I know for sure that the result is `(ok ...)`" rule
applies to those.
