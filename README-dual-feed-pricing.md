# Dual-feed pricing (token-x-token-y-jing-v3-stx-sbtc)

This template clears a token pair whose cross-rate has to be **derived from
two Pyth USD-quoted feeds** because Pyth has no direct feed for the pair
(e.g. sBTC/STX from BTC/USD ÷ STX/USD; ETH/STX from ETH/USD ÷ STX/USD).

The protocol-level math is identical to the single-feed v3 template; only the
oracle plumbing differs.

## Convention

`oracle-price` and the user-facing `limit-price` are both **"token-y per
token-x" at PRICE_PRECISION (1e8) scale**, identical to the single-feed
template. So `settle-clearing-price` can be set straight from `oracle-price`
and compared to `limit-price` with no rescaling.

For the sBTC/STX deployment that motivated this template:

| Slot | Value | Meaning |
|---|---|---|
| `token-x` | sBTC principal | base |
| `token-y` | STX principal | quote |
| `oracle-feed-x` | BTC/USD Pyth feed ID | token-x's USD price |
| `oracle-feed-y` | STX/USD Pyth feed ID | token-y's USD price |
| `oracle-price` | derived | STX per sBTC, 8-dec |
| `limit-price` | user-supplied | STX per sBTC, 8-dec |

## The derivation

```
oracle-price = (price-x × PRICE_PRECISION) / price-y
```

For BTC = $100,000, STX = $1, both feeds at expo = -8:

```
oracle-price = (100000_00000000 × 1e8) / 1_00000000
             = 100000_00000000   (= 100,000 STX per sBTC at 1e8 scale)
```

## Why the formula assumes equal expos

Pyth publishes prices as `{ price: int, expo: int, ... }` where the real
value is `price × 10^expo`. The contract treats the `price` field as if it
were already at `PRICE_PRECISION` (1e8) scale, which is only correct when
`expo = -8` for both feeds.

Re-derive when both feeds use the same expo `e`:

- `price-x = actual-x × 10^(-e)`
- `price-y = actual-y × 10^(-e)`

Substituting:

```
oracle-price = (actual-x × 10^(-e) × 1e8) / (actual-y × 10^(-e))
             = (actual-x / actual-y) × 1e8
```

The `10^(-e)` factor cancels **regardless of `e`'s value**, as long as both
feeds share it. The result is always at PRICE_PRECISION scale.

Concrete check with both feeds at expo = -6 (hypothetical):

| Feed | True | `expo` | `price` field |
|---|---|---|---|
| BTC/USD | $100,000 | -6 | 1e11 |
| STX/USD | $1 | -6 | 1e6 |

```
oracle-price = (1e11 × 1e8) / 1e6 = 1e13 = 100,000 at 1e8 scale  ✓
```

Same answer.

## What goes wrong with mismatched expos

If `expo-x ≠ expo-y` the cancellation breaks. Suppose BTC/USD stays at -8 but
STX/USD ships at -6:

| Feed | True | `expo` | `price` field |
|---|---|---|---|
| BTC/USD | $100,000 | -8 | 1e13 |
| STX/USD | $1 | **-6** | 1e6 |

```
oracle-price = (1e13 × 1e8) / 1e6 = 1e15
            → 1e15 / 1e8 = 10,000,000 STX per sBTC   ✗ (off by 100×)
```

Settlement clears at 100× the wrong rate; sBTC sellers get 100× too many
STX, STX sellers get 100× too little sBTC. Catastrophic.

## The defense in this contract

`execute-settlement` runs:

```clarity
(asserts! (is-eq (get expo feed-x) (get expo feed-y)) ERR_EXPO_MISMATCH)
```

immediately before computing `oracle-price`. Any mismatch reverts the
settlement. Free at runtime, fail-closed.

This catches both:

1. **Mismatched pair at deployment** -- e.g. operator pairs a crypto feed
   (-8) with an equity feed (-5).
2. **Unilateral expo rotation** -- Pyth publishers can change a feed's expo
   over time. Rare for major pairs but possible per Pyth's docs.

## Pyth expo conventions (today)

| Asset class | Typical `expo` |
|---|---|
| Major crypto / USD (BTC, ETH, SOL, STX, ...) | -8 |
| Stablecoins / USD | -8 |
| US equities | -5 |
| FX | -5 or -8 (varies) |
| Commodities | -8 (mostly) |
| Some niche tokens | occasionally -10 / -12 |

Within a single asset class, expo is consistent. **All Stacks-side Pyth
crypto/USD feeds use -8 today.** So in practice the equal-expo assertion
becomes "both = -8" -- but the contract is correct for any common expo, not
just -8.

## Cross-category pairs (different-expo case) -- future work

If you ever want a market like equity/crypto (e.g. AAPL/sBTC), the two feeds
will have different expos by design (-5 and -8). The current contract will
revert with `ERR_EXPO_MISMATCH` on every settlement -- correct fail-closed
behavior, but it means this template can't price that pair.

To handle that case, the formula needs an explicit expo-delta correction.
The general form:

```
delta = expo-y - expo-x
PRICE_FACTOR = PRICE_PRECISION × 10^delta
oracle-price = (price-x × PRICE_FACTOR) / price-y
```

When `delta = 0` (the equal-expo case this contract handles),
`PRICE_FACTOR = PRICE_PRECISION` and the formula reduces to the existing one.

When `delta > 0` (token-y has more decimals than token-x in Pyth terms),
we multiply by an extra `10^delta` to push the result back to PRICE_PRECISION
scale.

When `delta < 0`, we'd need to divide. Clarity's `pow` is uint-only so the
positive-vs-negative cases need to branch:

```clarity
;; sketch -- not committed
(let ((delta (- (get expo feed-y) (get expo feed-x))))
  (if (>= delta 0)
    (/ (* price-x PRICE_PRECISION (pow u10 (to-uint delta))) price-y)
    (/ (* price-x PRICE_PRECISION) (* price-y (pow u10 (to-uint (- 0 delta)))))))
```

### Two design choices for the cross-category template

1. **Compute `PRICE_FACTOR` at settle time** from `feed-x.expo` and
   `feed-y.expo`. Tracks Pyth expo rotations automatically. Slightly more
   compute and code per settlement.
2. **Lock `decimal-delta` at `initialize`** as a `data-var`, audited up
   front, used unchanged thereafter. Simpler math, but a unilateral expo
   rotation by Pyth would silently mis-price -- so this needs the
   equal-expo assertion *plus* a runtime check that the actual delta still
   matches the configured one.

Path (1) is more robust and less work to audit, since the contract
self-corrects against Pyth changes. Path (2) is faster but adds a
governance burden every time Pyth rotates an expo.

A new template (e.g. `token-x-token-y-jing-v3-cross-category.clar`) is the
natural home for either path -- this template stays focused on the
common-expo case where the assertion is the right defense.

## Migration note

Existing v2 sbtc-stx markets (`sbtc-stx-0-v2`, `sbtc-stx-20-v2`, deployed
at `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22`) use the same dual-feed
derivation but include a now-removed DEX-divergence sanity check (see
`README-dex-sanity-removal.md`). Migration to this template is a separate
decision; v2 can stay as a read-only data source for downstream consumers
(e.g. dual-stacking equity reads) without touching this template.
