# DLMM Price Scale Bug (v2)

## Summary

`get-dlmm-price` in the v2 blind-auction contracts (`sbtc-stx-0-v2.clar` and `sbtc-stx-20-v2.clar`) returns the raw DLMM bin price without the scale conversion needed to match the oracle-price and XYK-price format. The result is that whenever `dex-source` is set to DLMM (`u2`), the DEX divergence sanity gate in `execute-settlement` always fails with `ERR_PRICE_DEX_DIVERGENCE` (`u1007`).

**Status:** Latent. Production impact is zero today because `dex-source` defaults to XYK and has never been flipped on the deployed contracts. The DLMM code path is effectively dead until the fix is deployed.

**Affected deployed contracts (same bug):**
- `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2`
- `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-20-jing-v2`

## Evidence

Clarinet test `dex-source=DLMM: divergence gate rejects settle due to scale mismatch` (tests/sbtc-stx-0-v2.test.ts) reads all three price sources against the mainnet fork at the same block:

```
oracle (Pyth)          = 30,883,358,426,384      (target scale: STX/BTC × 1e8)
get-xyk-price          = 30,633,552,939,329      diff vs oracle =  81 bps   passes 10% gate
get-dlmm-price (raw)   = 32,835                  diff ≈ 9 orders of magnitude
1e18 / dlmm-raw        = 30,455,306,837,216      diff vs oracle = 139 bps   passes 10% gate
```

- Oracle and XYK agree to within ~0.8% — they are on the same scale.
- Raw DLMM is about `9.4e8`× smaller than oracle. Not a rounding error; different units entirely.
- A single scalar transform (`1e18 / raw`) brings DLMM within ~1.4% of oracle. Matching that tightly at the `3e13` scale is not accidental.

## The scale

| Source | Formula | Units returned |
|---|---|---|
| Oracle (`execute-settlement:588`) | `(btc-price × PRICE_PRECISION) / stx-price` | STX/BTC × 1e8 |
| `get-xyk-price` | `(y-balance × 100 × 1e8) / x-balance` | STX/BTC × 1e8 (decimal-adjusted via × 100 for 8→6 decimals) |
| `get-dlmm-price` (current) | raw bin price from `dlmm-core-v-1-1.get-bin-price` | **DLMM internal bin scale** — does NOT match |
| `get-dlmm-price` (fixed) | `1e18 / raw-bin-price` | STX/BTC × 1e8 |

Memory note rationale: DLMM's raw bin price × `1e-10` equals BTC/STX. Invert to get STX/BTC, then scale by `1e8` to match the contract's Scale-A:

```
STX/BTC × 1e8 = (1 / (raw × 1e-10)) × 1e8 = 1e18 / raw
```

## Divergence gate math

From `execute-settlement` (sbtc-stx-0-v2.clar:601-603):

```clarity
(asserts! (< (if (> oracle-price dex-price)
                (- oracle-price dex-price) (- dex-price oracle-price))
             (/ oracle-price MAX_DEX_DEVIATION)) ERR_PRICE_DEX_DIVERGENCE)
```

With `MAX_DEX_DEVIATION = u10`, the gate allows `|oracle − dex| < oracle / 10`.

With raw DLMM:
- `|30,883,358,426,384 − 32,835| ≈ 3.09e13`
- `oracle / 10 ≈ 3.09e12`
- `3.09e13 < 3.09e12` → **false** → `ERR_PRICE_DEX_DIVERGENCE` (`u1007`)

With the fix applied:
- `|30,883,358,426,384 − 30,455,306,837,216| ≈ 4.28e11`
- `oracle / 10 ≈ 3.09e12`
- `4.28e11 < 3.09e12` → **true** → gate passes

## Fix

Replace `get-dlmm-price` in both v2 contracts (line 779 in 0bps, line 782 in 20bps):

```clarity
(define-read-only (get-dlmm-price)
  (let ((pool (unwrap-panic (contract-call?
    'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15
    get-pool)))
        (bin-price (unwrap-panic (contract-call?
          'SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1
          get-bin-price (get initial-price pool) (get bin-step pool) (get active-bin-id pool)))))
    (/ u1000000000000000000 bin-price)))
```

## Why `1e18 / bin-price` — worked example

Pretend 1 BTC = 300,000 STX.

**Oracle format** (Scale-A): `STX/BTC × 1e8 = 30_000_000_000_000` (`3e13`)

**DLMM raw `bin-price` format**: quotes the price the **opposite way** (BTC per STX) and scales it **differently** (× `1e10`). So:
- 1 STX ≈ 0.00000333 BTC
- × `1e10` → `bin-price ≈ 33_333`

Two mismatches:

| | DLMM raw | Scale-A target |
|---|---|---|
| Direction | BTC per STX | STX per BTC |
| Scale factor | × `1e10` | × `1e8` |

One division does both jobs — **invert** the direction and **rescale**:

```
STX/BTC        = 1 / (BTC/STX)
               = 1 / (bin-price / 1e10)
               = 1e10 / bin-price

STX/BTC × 1e8  = (1e10 / bin-price) × 1e8
               = 1e18 / bin-price
```

Sanity: `1e18 / 33_333 ≈ 3.0003e13` ≈ oracle `3e13` ✓
Real-run value: `1e18 / 32_835 = 30_455_306_837_216`, within 139 bps of oracle `30_883_358_426_384`.

## Clarity safety

The expression `(/ u1000000000000000000 bin-price)` is production-safe:

- **Size fits.** Clarity `uint` is 128-bit unsigned (max `~3.4e38`). `1e18` is `20` orders of magnitude under the ceiling. No overflow.
- **Integer truncation.** `/` truncates toward zero. Example: `1e18 / 32_835` drops fractional digits; loss is in the 15th significant digit — invisible to the 10% divergence gate.
- **Division by zero reverts cleanly.** If `bin-price = u0`, Clarity throws `DivisionByZero` and the tx reverts. DLMM's `get-bin-price` can only return `u0` in a catastrophic pool state, and the upstream call is already `unwrap-panic`'d — so no new failure mode is introduced.
- **Extreme `bin-price` → gate rejects.** If `bin-price > 1e18`, the division yields `u0` and the divergence gate fails with `ERR_PRICE_DEX_DIVERGENCE` (`u1007`). If `bin-price = u1`, the result is `1e18` — also outside the 10% gate around oracle (`~3e13`). Both extremes revert safely; neither clears a bad trade.
- **Real mainnet values** are in the `~3e4` range, giving Scale-A `~3e13`. Sits in the middle of the safe band.

## Remediation for deployed contracts

The deployed markets share this bug. Options:

1. **Leave as-is.** `dex-source` on both deployed markets is XYK. No user funds at risk. If DLMM is never needed, the bug remains inert.
2. **Deploy new markets with the fix** and migrate.
3. **Do nothing until DLMM is actually wanted.** When XYK pool becomes unsuitable (e.g. liquidity migrates to DLMM), deploy fixed v2.1 contracts and migrate.

Recommend option 1 or 3 — a redeploy just to fix dead code is higher risk than the bug itself.

## Test coverage

`tests/sbtc-stx-0-v2.test.ts` contains the evidence test. It reads all four price values, logs them for inspection, and asserts:

1. Oracle and XYK are on the same scale (both > `1e10`).
2. Raw DLMM is on a different scale (< `1e6`).
3. `1e18 / raw-dlmm` matches oracle within a reasonable tolerance (`< 1000 bps` — well inside the 10% gate).

After applying the fix, the test also asserts that settlement completes successfully with `clearing-price = oracle-price`.
