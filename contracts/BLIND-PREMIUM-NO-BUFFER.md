# blind-premium: Why There's No Buffer

`blind-auction.clar` has a 30-block buffer between `close-deposits` and `settle`. `blind-premium.clar` removes it (`BUFFER_BLOCKS = u0`). This note explains why, what it protects against, and what it doesn't.

## TL;DR

The buffer in `blind-auction` existed to impose holding risk on would-be arbs so they couldn't risk-free-arb the settlement. `blind-premium` replaces that protection with **per-depositor limit prices**, which lets us drop the buffer and gain **atomic composability** with other protocols (Bitflow, Velar, routers) — they can bundle deposit + close + settle in a single tx.

The residual MEV vector (JIT arbs capturing oracle-vs-external-venue drift) is a feature, not a bug. It brings external price discovery into Jing and adds counterparty liquidity, at no cost to honest users.

## What the buffer was doing

In `blind-auction`, any deposit was filled at whatever clearing price the oracle produced at `settle` time. A buffer-less design meant an attacker could:

1. Observe the oracle right now.
2. Compute the expected clearing price.
3. Deposit, close, and settle in the same block — risk-free if the deposit was profitable vs external markets.

The buffer forced the attacker to commit capital N blocks before settle. During those N blocks, the oracle could move, and the attacker couldn't modify or withdraw their position. That converted risk-free arb into risky speculation.

## Why limits replace the buffer (for user safety)

`blind-premium` requires every deposit to include a limit price:

- **STX side**: max STX-per-sBTC the depositor will accept as clearing.
- **sBTC side**: min STX-per-sBTC the depositor will accept.

At settlement, any depositor whose limit is violated is **rolled to the next cycle** instead of filled at a bad price. So an honest depositor cannot be forced into a trade they didn't agree to — they either fill at-or-better than their stated tolerance, or they roll forward untouched.

Limits are `PHASE_DEPOSIT`-gated via `set-stx-limit` / `set-sbtc-limit` (lines 466, 475), so nobody can re-tune their limit after `close-deposits` based on new information.

The three oracle safety gates still apply:

1. **Staleness** (`MAX_STALENESS u60`): Pyth price must be <60s old.
2. **Confidence** (`MAX_CONF_RATIO u50`): confidence interval must be <2% of price.
3. **DEX divergence** (`MAX_DEX_DEVIATION u10`): oracle vs pool must be within 10%.

If any gate trips, settlement fails. After `CANCEL_THRESHOLD u500` blocks, anyone can cancel and roll all deposits forward.

## Why atomic composability matters

With no buffer, a router contract can hit Jing as one leg of a multi-venue swap in a single transaction:

```
router: deposit → close-deposits → settle-with-refresh → collect
```

This makes Jing interoperable with Bitflow, Velar, and any future Stacks DEX aggregator. A 30-block buffer would have forced routers to either wait ~1 minute mid-swap (impossible in one tx) or skip Jing entirely. Removing it turns Jing from an isolated batch venue into a composable liquidity source.

## The residual MEV vector: JIT arbs

Without a buffer, a Just-In-Time arb can watch Pyth + Bitflow, and when the oracle drifts favorably vs external venues, bundle a deposit + settle to capture the spread.

**This is deliberately allowed**, for three reasons:

### 1. It's expensive

To capture the 40 bps premium via a JIT arb, the attacker's cost stack is:

- Bitflow AMM slippage (scales with size)
- Bitflow swap fee (~0.30%)
- Stacks tx fees for deposit + settle
- Risk of failed settlement (oracle refresh comes back wrong, DEX divergence gate trips, etc.)

Net: the oracle-vs-external dislocation has to exceed **~80–100 bps** before a JIT arb is net-profitable. That only happens when something is actually wrong with cross-venue pricing — i.e., when closing the dislocation is the socially useful outcome.

### 2. Honest users never pay for it

The clearing price is a deterministic function of the oracle (`oracle × (1 − PREMIUM_BPS)`), same for everyone on the side. A JIT arb's deposit does not change the price other depositors fill at. It only changes:

- **Same-side pro-rata**: same-side depositors get a slightly smaller fill share (rolled tail goes to next cycle).
- **Opposite-side fills**: opposite-side depositors get deeper fills.

Honest users always transact at the price they agreed to (bounded by their limit), which is the price they signed up for when they chose an oracle-based venue over an AMM.

### 3. In-book MMs have a structural cost advantage that widens with size

A patient MM already in the book pays only the Stacks tx fee to call settle — no slippage, no 0.30% swap fee, no inventory risk. That's an **~80–100 bps cost advantage** over any JIT arb.

More importantly, **Bitflow slippage is superlinear in size**. A JIT arb trying to scale their deposit to capture a bigger pro-rata share pays disproportionately more slippage per unit, so their per-unit profit shrinks as they grow and eventually flips negative. In-book MMs, by contrast, scale linearly — 10× the position earns 10× the premium at zero marginal cost. JIT arbs therefore **cannot displace in-book MMs**; they can only take small slices during dislocation events, pro-rata.

Natural equilibrium:

- **Stable markets**: no arb opportunity. In-book MMs collect the full 40 bps uncontested.
- **Small/moderate dislocation**: small JIT arbs become profitable, share a small pro-rata slice, bridge Jing ↔ Bitflow pricing. In-book MMs still take the bulk of the premium.
- **Extreme dislocation**: JIT arbs still can't scale (slippage eats them), so in-book MMs at scale continue to dominate.
- **Gate-tripping dislocation** (>10% DEX divergence, stale oracle, etc.): settlement fails, cycle cancels, deposits roll forward untouched.

## Implications for MM operators

**Passive MMs are welcome.** The in-book MM's structural advantages (linear scaling, no round-trip costs) mean passive capital still dominates the premium. You don't need to run a bot to participate — you just accept that in dislocation events a small slice of your premium may leak to JIT arbs bridging prices with external venues, in exchange for those arbs keeping Jing's clearing price honest.

**Bot-running is an optional upgrade path**, not a prerequisite. An MM who runs a settle-bot can:

1. Deposit with a limit at their true reservation price.
2. Monitor Pyth + Bitflow / Velar.
3. Trigger `close-deposits` + `settle-with-refresh` atomically when the oracle is favorable, capturing the premium before any JIT arb's Bitflow leg finishes.
4. Stay idle when oracle drifts against them (let the cycle expire, roll forward).

This watch-and-race strategy exists with or without a buffer — the buffer doesn't change the settle race itself. What zero-buffer uniquely provides is **costless `close-deposits` calling**: bundling close + settle in one tx means the close-caller takes zero drift risk. In a buffered design, close is a standalone commitment with N blocks of drift exposure, which nobody would call unless compensated — slowing the cycle cadence. Zero-buffer keeps cycles fast and close-calling free.

### Participant-selection framing

- **Buffered design**: the settle-time oracle is genuinely unknown at deposit/close time, so only actors willing to *bear price-uncertainty risk* participate. The premium rewards risk-bearing.
- **Zero-buffer design**: with Pyth's 60s staleness and off-chain VAA inspection, the settlement price is near-deterministic at the moment of close+settle. The premium rewards **information + speed** on top of passive capital provision. Passive MMs still earn it most of the time; bot-runners defend against dislocation leakage.

Both are valid market structures. Zero-buffer was chosen because it also enables atomic composability with other Stacks protocols — a property no buffered design can match.

## What we are NOT defending against

- **Oracle staleness within the 60s Pyth window**: if Pyth is 60s behind and external markets have moved, the clearing price will be stale. This is a property of oracle-based pricing, not a buffer problem — it exists with or without a buffer.
- **Honest users' counterfactual loss vs external venues**: Alice chose oracle-based pricing by depositing into Jing. If she wanted Bitflow's live price, she should use Bitflow. The contract cannot protect her against her own venue choice.
- **MM dilution by JIT arbs in dislocation events**: this is the explicit trade-off for composability. MMs who care about it should run bots (see above).

## Alternatives considered

- **Small buffer (5–10 blocks)**: would restore some JIT arb holding risk, but breaks atomic composability for routers. Rejected.
- **`pyth_publish_time ≥ deposits-closed-block-timestamp` rule in `settle-with-refresh`**: would prevent backward oracle-snapshot selection, but also breaks same-block close+settle bundling. Rejected for the same reason.
- **Cancel-and-retry only (no same-block settle)**: would eliminate JIT arbs entirely but also eliminate composability. Rejected.

The zero-buffer design is the only one that preserves atomic composability, and the user-safety story is fully handled by per-depositor limits + the three oracle gates.
