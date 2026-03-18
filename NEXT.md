# What's Next

## Current State (2026-03-18)

### Deployed Contracts
| Contract | Status |
|----------|--------|
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-swap` | Deployed, paused (MARKETS_PAUSED in frontend) |
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-usdcx-jing-swap` | Deployed, paused |
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jingswap` | Old v0, paused on-chain |
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-usdcx-jingswap` | Old v0, paused on-chain |

### What Changed in jing-swap (vs jingswap v0)
1. **Dust filter at close-deposits (Rule 1):** Refreshes Pyth prices, computes exact clearing amounts, refunds depositors whose pro-rata share would round to 0.
2. **Dust refund at distribute (Rule 2):** Unfilled amounts below minimum (1 STX / 1,000 sats / 1 USDCx) are refunded instead of rolling to prevent dust accumulation.
3. **close-deposits now takes VAA params** — same signature as settle-with-refresh. Costs ~2 µSTX for Pyth update.

### Frontend + Backend
- Frontend (`jingswap-fe`): Points to `jing-swap` contracts. `MARKETS_PAUSED = true` blocks deposits.
- Backend (`faktory-dao`): Poller, activity endpoints, swaps table all point to `jing-swap`. Handles `dust-refund-stx/sbtc/usdcx` events.
- aibtc MCP + Skills: PRs updated with `jing-swap` contract names + multi-market support.

---

## TODO Before Unpausing

### 1. Test deposits + settlement on new contracts
- [ ] Deposit STX + sBTC on `sbtc-stx-jing-swap`
- [ ] Deposit USDCx + sBTC on `sbtc-usdcx-jing-swap`
- [ ] Close deposits (now requires VAA params)
- [ ] Settle with refresh
- [ ] Verify activity shows correctly in frontend
- [ ] Verify swap cards show correct amounts

### 2. Test dust filter edge cases on mainnet
- [ ] Deposit a small amount (1 STX) alongside a whale deposit
- [ ] Close deposits — verify dust depositor gets refunded if share rounds to 0
- [ ] Deposit amounts that result in unfilled < minimum at settlement — verify refund instead of roll

### 3. Update frontend close-deposits call
The frontend `close-deposits` button currently calls without VAA params. Needs updating to fetch fresh VAAs and pass them, same as `settle-with-refresh`. Files:
- `jingswap-frontend/src/hooks/useAuctionTransactions.ts` — `closeDeposits()` function
- Backend `/api/auction/pyth-vaas` endpoint already provides fresh VAAs

### 4. Update aibtc MCP + Skills close-deposits
Same change — `jingswap_close_deposits` tool and `close-deposits` skill subcommand need to fetch VAAs and pass them.
- `pillar/mcp/src/tools/jingswap.tools.ts` — close_deposits tool
- `pillar/skills/jingswap/jingswap.ts` — close-deposits command

### 5. Unpause
- [ ] Set `MARKETS_PAUSED = false` in `SideDepositWidget.tsx`
- [ ] Push frontend
- [ ] Call `set-paused false` on both old v0 contracts if needed (to let users cancel remaining deposits)

### 6. Backend poller backfill
- [ ] Trigger `/api/bot/backfill-swaps` after first settlement on new contracts
- [ ] Verify All Activity + Your Activity show correct swap data

---

## Stxer Simulations (latest)

All pass with the dust filter + price-aware close-deposits:

| Test | Link |
|------|------|
| Full lifecycle | https://stxer.xyz/simulations/mainnet/1f36ae4012a2df7be55ef5882e811933 |
| Priority queue | https://stxer.xyz/simulations/mainnet/3b14c1265de17ae82d99a1d97198a144 |
| Cancel flows | https://stxer.xyz/simulations/mainnet/c844c139e995071c205a6e41d54ed9b1 |
| settle-with-refresh | https://stxer.xyz/simulations/mainnet/d5f7c8a35b665204c0dbea95ff8c43d3 |
| Same depositor | https://stxer.xyz/simulations/mainnet/910bdd012c6be04d2ec463c845fe5fd5 |
| Dust filter | https://stxer.xyz/simulations/mainnet/027056edf58a8bc3cbd5bee53e617fbc |
| Deploy v1 | https://stxer.xyz/simulations/mainnet/d5cb371526162f60bcab43ca1baa43bf |
| USDCx lifecycle | https://stxer.xyz/simulations/mainnet/3980022aae48736e74a5a8c9addf7cb0 |
| USDCx cancel | https://stxer.xyz/simulations/mainnet/f11cfd18308478cae8ba96a62b31951d |
| USDCx same depositor | https://stxer.xyz/simulations/mainnet/9fcadc5aa65cca500fe4d65fd045161a |
| USDCx settle-refresh | https://stxer.xyz/simulations/mainnet/14bbd5b5e3525d4e36586044e960ca0d |

**Note:** These simulations use the pre-price-aware dust filter. Need to re-run with the updated close-deposits (VAA params + exact clearing amounts) after updating `blind-auction-stxer.clar`.

---

## Simulation TODO
- [ ] Update `blind-auction-stxer.clar` with price-aware close-deposits
- [ ] Re-run all simulations (they now need VAAs for close-deposits)
- [ ] Add new simulation: dust filter with price-aware clearing (the edge case where pool imbalance + price makes share round to 0 even though pool ratio alone wouldn't)
- [ ] Update `README-stxer.md` with new simulation links

rr: refresh all stxer simulations with priced closed deposits
rr: full unit test clarinet 
