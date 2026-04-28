# Should we keep the DEX sanity check?

## The question

`execute-settlement` in `sbtc-usdcx-v2.clar` runs a divergence gate: it
reads a DEX-derived price (XYK or DLMM) and rejects the settlement if it
disagrees with the Pyth oracle by more than `MAX_DEX_DEVIATION` (10%).

```clarity
(asserts! (< (if (> oracle-price dex-price)
                (- oracle-price dex-price) (- dex-price oracle-price))
             (/ oracle-price MAX_DEX_DEVIATION)) ERR_PRICE_DEX_DIVERGENCE)
```

This is a third defense layer on top of (1) Pyth confidence-ratio gate
and (2) Pyth staleness gate. It exists to catch oracle compromise — if
Pyth ships a wildly wrong price, the on-chain DEX disagrees, and the
settlement aborts.

We're considering removing it. **The trade-off is composability and
template-ability vs. defense-in-depth.**

## Why removing it is attractive

1. **It blocks canonical-hash registration.** The check requires
   hardcoded references to specific XYK and DLMM pool contracts
   (`xyk-pool-sbtc-stx-v-1-1`, `dlmm-pool-sbtc-usdcx-v-1-bps-10`). Those
   addresses pin this contract to one specific pair. For a generic
   template that the same canonical hash can register for **any** pair,
   nothing pair-specific can be hardcoded — everything must come from
   `initialize`-time data-vars.
2. **User limit-prices already protect the individual depositor.** Every
   deposit carries a `limit-price`, and `filter-limit-violating-*` rolls
   any depositor whose limit is breached at clearing. A user who sets a
   sane limit cannot be force-cleared at a wildly off price even if the
   oracle is wrong.
3. **The DEX itself is manipulable.** A single large swap on the
   reference pool can move it past 10% for one block — the same block in
   which the keeper might call `settle`. So the divergence gate has its
   own attack surface: it adds a *different* trust assumption rather than
   strictly hardening the existing one.
4. **Pyth's own gates remain.** Confidence-ratio (`MAX_CONF_RATIO = 50`)
   and staleness (`MAX_STALENESS`) checks are entirely Pyth-internal and
   unaffected. They catch the most likely failure modes (stale feed,
   uncertain feed, zero price) without any DEX dependency.

## Why keeping it is defensible

1. **Defense in depth is cheap.** Three independent gates beat two.
2. **Catches catastrophic Pyth failure** (e.g., oracle hijacked, posts
   `$1` for BTC) that no per-user limit can fully prevent — a malicious
   keeper could still find some users whose limits happen to allow it.
3. **Treasury-side protection.** The protocol fee accrues at clearing
   price; an extreme oracle event drains the treasury alongside users.

## What removing it would entail

Strip from `sbtc-usdcx-v2.clar`:
- `DEX_SOURCE_XYK` / `DEX_SOURCE_DLMM` constants
- `dex-source` data-var and `set-dex-source` admin function
- `get-xyk-price`, `get-dlmm-price`, `get-dex-price` read-onlys
- `MAX_DEX_DEVIATION` constant + `ERR_PRICE_DEX_DIVERGENCE` + the assert
- `STX_USD_FEED` constant and the stx-feed validation block in
  `execute-settlement` (only used to convert XYK ratio into BTC/USD)
- `dlmm-rescale` data-var and its precomputation in `initialize` —
  redundant once `get-dlmm-price` is gone

Add to `initialize`:
- A new `(feed (buff 32))` parameter, stored in a new `oracle-feed`
  data-var, replacing the hardcoded `BTC_USD_FEED` constant. Lets the
  same contract template price any base/quote pair against the
  appropriate Pyth feed.

End state: a fully generic blind-batch auction template — no hardcoded
pool addresses, no hardcoded feed identifiers, no DEX dependency.
Identical contract bytes across every deployment, so a single canonical
hash can register an unbounded number of pair instances.

## The recommendation

**Remove it.** The genericity unlock is structural (no template, no
multi-pair platform); the security loss is incremental and partially
covered by the remaining gates plus user limits. If a future deployment
wants stronger oracle-attack protection, that's better expressed as an
*optional* outer wrapper contract that pre-validates Pyth + DEX before
calling `settle` — keeping the core contract template-clean and letting
risk-averse operators opt into extra checks.

Pending: explicit greenlight before stripping the DEX path and
converting `BTC_USD_FEED` to a data-var.
