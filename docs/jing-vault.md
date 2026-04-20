# Jing Vault

Conditional execution layer on top of Jing Swap. Users deploy personal vault contracts that hold funds with standing instructions. Keepers execute deposits into Jing when signed conditions are met.

## Problem

Jing Swap is a blind batch auction that clears at Pyth oracle price. Users who want to trade at a specific price target today must manually watch the market and deposit at the right time. This is a UX barrier and doesn't scale.

## Solution

A personal vault contract per user that:
1. Holds STX or sBTC deposits
2. Accepts signed SIP-018 intents specifying execution conditions (price target, direction, fee)
3. Allows any keeper to trigger a deposit into Jing when conditions are met, verified on-chain against the Pyth oracle
4. Only allows the owner to withdraw funds

The conditions are **off-chain** (SIP-018 signed messages), **private** until execution, and **enforceable on-chain** via signature verification.

## Architecture

```
OFF-CHAIN                                 ON-CHAIN
---------                                 --------

User signs SIP-018 intent:                jing-vault (1 per user)
  target-price, condition,          --->    - holds funds
  nonce, keeper-fee, expiry                 - verifies signature
                                            - checks Pyth oracle price
Keeper holds signed intent                  - deposits into / cancels from Jing
  watches oracle off-chain                  - only owner can withdraw
  submits when conditions met
                                          jing-core (singleton)
                                            - maps user -> vault principal
                                            - stores approved vault code hashes
                                            - keeper reads to find active vaults
```

## Why 1 Contract Per User

Jing records `tx-sender` as the depositor. After settlement, proceeds go back to the depositor. If multiple users shared one conditions contract, that contract would receive a lump sum and need to rebuild pro-rata accounting internally — reimplementing half of Jing's settlement logic.

One vault per user = the vault deposits the user's exact amount, receives the user's exact settlement proceeds. Clean separation.

## Why SIP-018 Signed Intents

Conditions live off-chain as signed structured data:

- **Private**: No one scanning the chain can see "Alice wants to buy sBTC at 4800." The intent is invisible until the keeper submits it.
- **Flexible**: User changes their mind? Sign a new message with a higher nonce. No on-chain tx, no gas.
- **Extensible**: New condition types = new SIP-018 message structures. The vault template supports this from day one.
- **Enforceable**: The chain verifies the signature via `secp256k1-recover?` and checks the condition against live Pyth oracle state.

## Contract Hash Verification

Users deploy their own vault from the approved template. The registry verifies the deployed contract's code hash matches the approved template before allowing registration. This ensures:

- No rogue vault contracts with modified logic
- Keepers can trust that any registered vault behaves as expected
- Users retain full sovereignty (they deploy, they own)

## Execution Flow

### Happy Path: Execute into Jing

1. User deposits STX or sBTC into their vault
2. User signs SIP-018 intent off-chain: `{ action: "execute", side: "stx", target-price: 4800000000, condition: "le", nonce: 1, keeper-fee-bps: 50, expiry: 0 }`
3. User sends signed intent to keeper (or publishes to a known endpoint)
4. Keeper monitors Pyth oracle price off-chain
5. Price hits target -> keeper calls `vault.execute-into-jing(signature, params...)`
6. Vault on-chain: recovers signer, verifies owner, reads Pyth price, checks condition, deposits into Jing
7. Jing cycle proceeds normally (close-deposits -> buffer -> settle)
8. Settlement proceeds (sBTC) land in the vault
9. Keeper or user calls `vault.claim()` -> proceeds sent to owner, keeper gets fee

### Retract from Jing (Rare)

The keeper can call `vault.retract-from-jing(signature, params...)` with a signed "retract" intent to cancel the Jing deposit during the deposit phase. This is rarely needed because:

- The keeper typically times `execute-into-jing` close to when `close-deposits` can be called
- Immediately after depositing, the keeper (or anyone) calls `close-deposits` then `settle-with-refresh`
- The window where retraction is useful is small

Retract exists for edge cases: user wants to cancel for non-price reasons, unexpected market events, etc.

### Cancel a Signed Intent

To invalidate an outstanding signed intent without executing it, the user calls `vault.consume-nonce(nonce)`. This bumps the vault's nonce past the signed value, making the old signature unusable. No keeper involvement needed.

## Signed Intent Format (SIP-018)

### Domain

```clarity
{
  name: "jing-vault",
  version: "1",
  chain-id: chain-id
}
```

### Execute Message

```clarity
{
  action: "execute",
  side: "stx",                ;; "stx" or "sbtc" - what the user deposited
  target-price: u4800000000,  ;; PRICE_PRECISION (1e8) - sats per STX
  condition: "le",            ;; "le" = execute when oracle price <= target
                              ;; "ge" = execute when oracle price >= target
  nonce: u1,                  ;; must be > vault's current nonce
  keeper-fee-bps: u50,        ;; basis points paid to keeper from settlement
  expiry: u0                  ;; block height deadline, 0 = no expiry
}
```

### Retract Message

```clarity
{
  action: "retract",
  nonce: u2,
  expiry: u0
}
```

## Price Model

- Conditions are checked against the **Pyth oracle** (BTC/USD and STX/USD feeds), same source Jing uses for settlement
- The oracle price at condition-check time and settlement time may differ (settlement happens ~60s+ after deposit close)
- The user accepts this: they're placing a **conditional market order**, not a limit order with exact fill price
- This is a feature, not a bug: since Jing settles at oracle price with no slippage and no sandwich risk, the user gets fair execution regardless of the exact fill price

## Keeper Economics

- Keeper fee is set by the user in the signed intent (basis points)
- Fee is taken from settlement proceeds, not from the deposit
- Any address can be a keeper — competitive execution
- The keeper who calls `execute-into-jing` is recorded; they receive the fee at claim time
- Keepers are incentivized to monitor and execute promptly

## Contracts

| Contract | Deployed By | Purpose |
|----------|------------|---------|
| `jing-vault-v1` | Each user | Personal vault holding funds + executing signed intents into Jing |
| `jing-vault-auth` | Protocol | SIP-018 hash builders for vault message types |
| `jing-core` | Protocol | Approved code hashes + user-to-vault mapping |

## Block Timing Reference (Nakamoto)

- ~2 sec per block
- Jing deposit minimum: 150 blocks (~5 min)
- Jing buffer: 30 blocks (~1 min)
- Jing cancel threshold: 530 blocks (~17.5 min)
