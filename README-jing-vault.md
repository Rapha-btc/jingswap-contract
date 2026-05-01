# jing-vault-v1

A per-user vault that lets a keeper execute price-conditional STX↔sBTC trades on the owner's behalf without ever holding their funds. Each owner deploys their own instance.

Source: `contracts/jing-vault-v1.clar`

## Roles

- **Owner** — deposits/withdraws STX & sBTC, signs SIP-018 intents off-chain, can rotate pubkey/keeper. Pinned in bytecode at deploy (`OWNER = tx-sender`).
- **Keeper** — a whitelisted principal that submits signed intents and can also trigger unsigned cancels/revocations. Paid out-of-band (flat subscription, etc).

## What it can do

1. **Custody** — hold STX + sBTC; only the owner can deposit/withdraw.
2. **Signed intents** (replay-protected via consumed message-hash, Pillar pattern):
   - `execute-jing-deposit` → forwards into `.blind-premium` (Jing Swap blind-batch auction).
   - `execute-bitflow-swap` → fallback path through pinned `xyk-core-v-1-2` / sbtc-stx pool. `min-out` is **derived on-chain** from `(amount, limit-price)`, so the owner signs a *price policy*, not a raw slippage number.
3. **Unsigned admin** (owner or keeper):
   - `cancel-jing-stx` / `cancel-jing-sbtc` — abort an in-flight blind-premium deposit during `PHASE_DEPOSIT`.
   - `revoke-intent` — burn a pre-signed intent's hash so it can never fire.

## Safety properties

- Owner pinned in bytecode — caller of `initialize` cannot mis-attribute ownership.
- Funds can only exit to: Jing's `.blind-premium`, Bitflow's pinned pool, or back to OWNER. No trait args, no substitution vectors — all external principals are inlined literals.
- `initialize` registers the vault with `.jing-core` against an approved canonical code hash, so jing-core knows this bytecode is trusted.
- Each signed intent is single-shot. The owner can have many outstanding intents at once; each is independent.
- `revoke-intent` and successful execution both consume the same `used-pubkey-authorizations` slot.

## Price unit (single across both venues)

`limit-price = STX per sBTC × 1e8` (Pyth-style 8-decimal precision).

| Side    | Spending | Receiving | Semantics |
|---------|----------|-----------|-----------|
| `"stx"` | STX      | sBTC      | **ceiling** — max acceptable price |
| `"sbtc"`| sBTC     | STX       | **floor** — min acceptable price |

For Bitflow, the vault derives `min-out` on-chain:

```
side="stx"  (A ustx in, want >= M sats):  M = A * (1e8 * 100) / limit-price
side="sbtc" (A sats in, want >= M ustx):  M = A * limit-price / (1e8 * 100)
```

`DECIMAL_FACTOR = 100` reconciles sBTC's 8-dec sats with STX's 6-dec ustx.

## Pinned external principals

Bitflow sBTC↔STX path (mainnet):

```
core:    'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
pool:    'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
x-token: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token (sBTC)
y-token: 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2 (STX wrapper)
```

Pool layout: x = sBTC, y = STX. So `side="stx"` → `swap-y-for-x`, `side="sbtc"` → `swap-x-for-y`.

## Lifecycle

```
deploy  → initialize(canonical)                  ;; one-shot, registers with jing-core
        → set-owner-pubkey(pubkey)               ;; owner sets signing key
        → set-keeper(some 'SP...)                ;; owner whitelists keeper

fund    → deposit-stx / deposit-sbtc             ;; owner only

trade   → owner signs intent off-chain (SIP-018, see jing-vault-auth.clar)
        → keeper submits execute-jing-deposit or execute-bitflow-swap
        → vault verifies sig + expiry + replay, then forwards to venue

abort   → cancel-jing-stx / cancel-jing-sbtc     ;; owner or keeper, blind-premium PHASE_DEPOSIT only
        → revoke-intent(hash)                    ;; owner or keeper, burns the slot

exit    → withdraw-stx / withdraw-sbtc           ;; owner only
```

## Errors

| Code   | Meaning |
|--------|---------|
| `u6001` | Caller is not OWNER (or keeper, where allowed) |
| `u6002` | Signature does not recover to `owner-pubkey` |
| `u6003` | Message hash already consumed |
| `u6004` | Intent expired (`stacks-block-height >= expiry`, when `expiry > 0`) |
| `u6006` | Zero amount on deposit/withdraw |
| `u6011` | `side` is neither `"stx"` nor `"sbtc"` |
| `u6013` | `limit-price = 0` on Bitflow path |
| `u6020` | `initialize` called twice |

## Related contracts

- `jing-vault-auth.clar` — builds the SIP-018 message hash for intents (`build-intent-hash`).
- `jing-core.clar` — template/instance registry, event stream, pause primitive. See `README-jing-core.md`.
- `blind-premium.clar` — Jing Swap blind-batch auction venue. See `README-blind-premium.md`.
