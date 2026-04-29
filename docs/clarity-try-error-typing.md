# `try!` and indeterminate `err` types in Clarity

## Symptom

`clarinet check` fails on a caller with:

> attempted to obtain `'err'` value from response, but `'err'` type is indeterminate

Even though both files compile fine in isolation. The error always points at the *caller's* `try!`, not the callee.

## Why it happens

Clarity's type system needs a concrete type on **both** sides of a `(response ok-type err-type)`. When a public function only ever returns `(ok ...)` and has no path that produces an `(err ...)`, the checker cannot infer the `err` half. Its type stays "indeterminate."

That's harmless inside the callee — it never produces an `err`, so no one cares. The trouble starts when another contract wraps the call in `try!`:

```clarity
(try! (contract-call? .jing-core log-deposit "sbtc" amount))
```

`try!` is sugar for "if this is `(err ...)`, return it; otherwise unwrap the `(ok ...)`." To compile that early-return, the checker has to know the `err` type to propagate. With nothing to infer from, it gives up on the whole expression.

## Concrete case in this repo

`jing-core.log-deposit` and `log-withdraw` originally looked like this:

```clarity
(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (and (is-eq asset "sbtc") (credit SBTC_TOKEN owner amount))
    (print { ... })
    (ok true)))
```

No `asserts!`, no `try!`, no `(err ...)` — pure success path. Compiles clean.

`loan-reserve.clar:94` calls it:

```clarity
(try! (contract-call? .jing-core log-deposit "sbtc" amount))
```

`clarinet check` rejects this and blocks **the whole project** (every test, including unrelated suites).

## The fix

Add any `asserts!` with a concrete error constant to pin down the `err` type:

```clarity
(define-public (log-deposit (asset (string-ascii 4)) (amount uint))
  (let ((owner (resolve-owner contract-caller)))
    (asserts! (>= amount u0) ERR_NOT_AUTHORIZED)   ;; <-- pins err to uint
    (and (is-eq asset "sbtc") (credit SBTC_TOKEN owner amount))
    (print { ... })
    (ok true)))
```

The assertion never fires (`amount` is `uint`, always `>= u0`) — its purpose is purely to give the response type a concrete `err` half. Now `(response bool uint)` is fully determined and `try!` in the caller compiles.

## Alternatives considered

1. **Drop `try!` in the caller** — `unwrap-panic` has the same problem (still needs to type the err). The only call style that side-steps the type checker is `let`-binding the result and discarding it, which is uglier than the one-line assert.
2. **Add a "real" guard** like `(asserts! (or (is-eq asset "sbtc") (is-eq asset "stx")) ...)` — works, but needlessly restricts the function. The asset-code fan-out (`(and (is-eq asset "sbtc") ...)`) is already the source of truth for which assets get balance updates; unknown codes are no-ops by design, which lets future vaults log new asset codes without editing core.

The chosen `(>= amount u0)` form is the minimum-coercion fix: it constrains nothing real about the inputs, only the response type.

## Rule of thumb

If a public function will ever be wrapped in `try!` from another contract, give it at least one `asserts!` with a concrete `ERR_*` constant — even a tautological one. The two extra characters of bytecode are far cheaper than the surprise of a downstream contract failing to compile months later.
