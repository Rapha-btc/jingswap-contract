# remote_data issue — settlement testing blocked

## Goal

Test full settlement in clarinet by enabling `[repl.remote_data]` to load:
- **BitFlow XYK pool state** (x-balance, y-balance) for DEX sanity check
- **Pyth stored prices** for oracle price feed

## What works

With `remote_data` enabled in `Clarinet.toml`:

```toml
[repl.remote_data]
enabled = true
api_url = 'https://api.hiro.so'
```

**Read-only calls to mainnet contracts return real data:**

```
BitFlow pool: x-balance = 1,023,892,993 sats (~10.2 BTC), y-balance = 2,889,931,328,878 uSTX (~2.89M STX)
Pyth BTC/USD: price = 7273725000000 ($72,737)
Pyth STX/USD: price = 25688811 ($0.2569)
DEX price via blind-auction get-dex-price: works, returns real mainnet pool price
```

## What partially works

**Funding wallets from mainnet whale works:**

```typescript
simnet.callPublicFn(SBTC_TOKEN, "transfer",
  [Cl.uint(100_000), Cl.principal(SBTC_WHALE), Cl.principal(wallet1), Cl.none()],
  SBTC_WHALE);
// → (ok true) ✓
```

Devnet `sbtc_balance` from Devnet.toml is ignored — wallets have 0 sBTC. But transferring from a mainnet whale (impersonated via sender) works.

**Depositing sBTC into blind-auction works** after whale funding.

## What breaks

**`as-contract` sBTC transfers inside the contract fail during settlement:**

```
Error: Internal(Expect("ERROR: Clarity VM failed to track token supply."))
```

When `settle` calls `distribute-to-stx-depositor` which uses `as-contract` to transfer sBTC from the contract to depositors, the Clarity VM loses track of the sBTC token supply.

This happens because the VM can track simple wallet→wallet transfers (whale funding), but cannot track supply changes when a **contract** receives sBTC and then sends it via `as-contract`.

**Note:** In pillar (vitest v2 + clarinet-sdk v3.9.0), whale transfers work. The token supply error may be specific to vitest v4's fork pool handling.

## Reproduction

```bash
# Enable remote_data in Clarinet.toml, then:
npm test
# → All sBTC deposit tests fail with (err u1)
```

## Expected behavior

Either:
1. `sbtc_balance` from `Devnet.toml` should be honored even with `remote_data` enabled (mint to devnet wallets at genesis)
2. Transfers from mainnet whale addresses via `simnet.callPublicFn(..., WHALE_ADDRESS)` should work without the "token supply" error

## Current workaround

- `remote_data` is **disabled** — all 9 clarinet tests pass
- Settlement is tested via **stxer mainnet fork simulations** (4 simulations, all green)
- See `simulations/README-stxer.md` for full settlement results

## Environment

- clarinet 3.14.0
- @stacks/clarinet-sdk 3.9.0
- vitest 4.1.0
