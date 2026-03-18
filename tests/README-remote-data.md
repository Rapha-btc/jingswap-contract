# remote_data settlement testing

## Status (clarinet-sdk 3.15.0)

Full settlement works in clarinet with `remote_data` enabled using `blind-auction-stxer`
(relaxed timing gates, identical settlement logic).

### What works

| Feature | Status |
|---------|--------|
| `ft-get-supply` on forked XYK pool LP token | Fixed |
| `as-contract?` FT transfers of mainnet sBTC | Fixed |
| Whale funding (impersonated mainnet address) | Works |
| DEX price from mainnet XYK pool | Works |
| Stored Pyth prices from mainnet | Works (with relaxed staleness) |
| Full settlement (deposit -> close -> settle) | Works |
| Settlement math (clearing, fees, rollover) | Verified |

### How to run

```bash
# Enable remote_data in Clarinet.toml:
#   [repl.remote_data]
#   enabled = true

npx vitest run tests/settlement-remote.test.ts
```

### Why `blind-auction-stxer`

The production `blind-auction` contract has three timing gates that require workarounds
in a clarinet test with remote_data:

| Gate | Production | Stxer | Why |
|------|-----------|-------|-----|
| `DEPOSIT_MIN_BLOCKS` | 150 | 0 | Skip mining 150 blocks |
| `BUFFER_BLOCKS` | 30 | 0 | Skip buffer phase |
| `MAX_STALENESS` | 60s | 999999999 | Stored Pyth prices are stale relative to simnet time |

The settlement logic (price math, clearing, fees, distribution) is **identical**.

### Why not `settle-with-refresh`

The production `settle-with-refresh` path pushes fresh Pyth VAAs via wormhole
verification. In clarinet with remote_data:

- `set-price-testnet` returns `(err u5003)` — `is-in-mainnet` = true with remote_data
- Wormhole VAA verification returns `(err u1)` — guardian set state issues

So we use `settle` with relaxed `MAX_STALENESS` instead.

### sBTC funding

With `remote_data`, `sbtc_balance` from `Devnet.toml` is ignored.
Fund wallets by impersonating a mainnet whale:

```typescript
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
simnet.callPublicFn(SBTC_TOKEN, "transfer",
  [Cl.uint(100_000), Cl.principal(SBTC_WHALE), Cl.principal(wallet1), Cl.none()],
  SBTC_WHALE);
```

### Settlement results (sample run)

```
Pyth BTC: $74,673, STX: $0.2682
Oracle: 278,449 STX per BTC
DEX:    279,305 STX per BTC (0.3% divergence — within 10% gate)

Settlement:
  STX cleared:  100,000,000 (100 STX — all matched)
  sBTC cleared: 35,921 sats (0.00036 BTC)
  sBTC unfilled: 64,079 sats → rolled to cycle 1
  Fees: 100,000 uSTX + 35 sats (0.1% each)
```

## Previous bug (fixed)

The original issue was `as-contract?` FT transfers throwing:
```
Internal(Expect("ERROR: Clarity VM failed to track token supply."))
```
This is **fixed** on clarinet-sdk 3.15.0.
