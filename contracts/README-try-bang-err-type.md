# `try!` requires a concrete err type

## The trap

A `define-public` whose body has no error path returns a response whose err
slot is **indeterminate**. Example — original `jing-core.log-deposit`:

```clarity
(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (and (is-eq asset "sbtc") (credit SBTC_TOKEN owner amount))
    (print { event: "vault-deposit", ... })
    (ok true)))                              ;; ← only ever (ok ...), no asserts!
```

Type checker infers: `(response bool _)`. The `_` is unbound.

When a caller wraps this in `try!`:

```clarity
(try! (contract-call? .jing-core log-deposit "sbtc" amount))   ;; loan-reserve.clar:94
```

Clarinet errors out:

```
attempted to obtain 'err' value from response, but 'err' type is indeterminate
```

`try!` works by extracting the err on failure and propagating it; if the err
type isn't pinned down, there's no concrete type to propagate, so the whole
expression rejects at compile time. `unwrap!` and `unwrap-panic` have the same
requirement.

This is a project-wide footgun: a single never-failing log function in
`jing-core` blocks `clarinet check` (and therefore the entire vitest suite —
clarinet refuses to load any contract if any contract in the project fails to
compile, even unrelated tests).

## The fix

Give the function any error path with a concrete err constant. The simplest
no-op pin:

```clarity
(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (asserts! (>= amount u0) ERR_NOT_AUTHORIZED)   ;; tautological — amount is uint
    (and (is-eq asset "sbtc") (credit SBTC_TOKEN owner amount))
    (print { ... })
    (ok true)))
```

`(>= amount u0)` is always true (uints can't be negative), so the assert never
fires — but the err slot is now `uint`, and `try!` is happy.

If you want defensive validation as a side benefit, prefer a real predicate
(e.g. asset whitelist, amount > 0, sender check) — same shape, real value.

## When this hits

Any `define-public` with no `asserts!` / `try!` / `unwrap!` in its body —
typically pure logging or pure-print helpers. If a downstream contract ever
wraps it in `try!`, you get the indeterminate-err error.

## How to spot it before someone wraps it

`clarinet check` against a contract that imports the function and tries
`try!` on it surfaces it immediately. Adding a defensive `asserts!` to every
`define-public`, even ones that "can't fail", is cheap insurance.

## Affected functions in this repo

`jing-core.log-deposit` and `jing-core.log-withdraw` were the two
no-error-path public functions. Both got the tautological-pin treatment in
the same commit that wired up `loan-reserve.clar`'s `try!` calls.

The market-side log endpoints (`log-deposit-x`, `log-deposit-y`,
`log-settlement`, etc.) all already have `(asserts! (is-approved-market
contract-caller) ERR_NOT_APPROVED_MARKET)` so their err type was already
pinned — no change needed for them.
