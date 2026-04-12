# blind-premium v2: Design Decisions

This doc explains the intentional design choices in `blind-premium.clar` that deviate from the original `blind-auction.clar`. Each decision is listed with its rationale, the attack vectors it opens or closes, and the alternatives that were rejected.

## Summary of decisions

1. **No buffer between `close-deposits` and `settle`** — enables atomic composability with routers and other protocols.
2. **Mandatory non-zero limit prices on every deposit** — shifts responsibility for price tolerance onto the depositor.
3. **60s oracle freshness window, no tighter** — trusts Pyth's staleness ceiling as sufficient even under network congestion, relying on limits as the user-level safety net.
4. **Shortened cycle thresholds** (`DEPOSIT_MIN_BLOCKS u30`, `CANCEL_THRESHOLD u150`) — ~1 min min deposit window, ~5 min to cancel a stuck cycle.
5. **20 bps premium** (down from 40 bps in an earlier draft) — narrower MM spread for more competitive clearing.
6. **Keep the core contract lean — no native `deposit+close+settle` bundling** — wrapper contracts should compose publics, per Werner's "build as light as possible" guidance.

The rest of this document is one section per decision.

---

## 1. No buffer between `close-deposits` and `settle`

`blind-auction.clar` has a 30-block buffer. `blind-premium.clar` removes it (no `BUFFER_BLOCKS` constant — `close-deposits` directly transitions into `PHASE_SETTLE`).

### What the buffer was doing

In `blind-auction`, any deposit was filled at whatever clearing price the oracle produced at `settle` time. A buffer-less design meant an attacker could:

1. Observe the oracle right now.
2. Compute the expected clearing price.
3. Deposit, close, and settle in the same block, risk-free if the deposit was profitable vs external markets.

The buffer forced the attacker to commit capital N blocks before settle. During those N blocks, the oracle could move, and the attacker couldn't modify or withdraw their position. That converted risk-free arb into risky speculation.

### Why we removed it anyway

Atomic composability. With no buffer, a router contract can hit Jing as one leg of a multi-venue swap in a single transaction:

```
router: deposit -> close-deposits -> settle-with-refresh -> collect
```

This makes Jing interoperable with Bitflow, Velar, and any future Stacks DEX aggregator. A 30-block buffer would have forced routers to either wait ~1 minute mid-swap (impossible in one tx) or skip Jing entirely. Removing it turns Jing from an isolated batch venue into a composable liquidity source.

Honest depositor safety is handled by decision 2 below: every depositor commits a hard limit price at deposit time, so they cannot be filled at a price they didn't agree to regardless of when settle fires.

### JIT arbs: the residual MEV vector

Without a buffer, a Just-In-Time arb can watch Pyth + Bitflow, and when the oracle drifts favorably vs external venues, bundle a deposit + settle to capture the spread. **This is deliberately allowed**, for three reasons:

**It's expensive.** To capture the 20 bps premium via a JIT arb, the cost stack is:

- Bitflow AMM slippage (scales with size)
- Bitflow swap fee (~0.30%)
- Stacks tx fees for deposit + settle
- Risk of failed settlement if the oracle refresh comes back wrong or a gate trips

Net: the oracle-vs-external dislocation has to exceed roughly **60–80 bps** before a JIT arb is net-profitable. That only happens when something is actually wrong with cross-venue pricing — i.e., when closing the dislocation is the socially useful outcome.

**Honest users never pay for it.** The clearing price is a deterministic function of the oracle (`oracle × (1 − PREMIUM_BPS)`), same for everyone on the side. A JIT arb's deposit does not change the price other depositors fill at. It only changes pro-rata slicing:

- **Same-side**: same-side depositors get a slightly smaller fill share; the unfilled tail rolls to next cycle.
- **Opposite-side**: opposite-side depositors get deeper fills.

Honest users always transact at the price they agreed to (bounded by their limit), which is the price they signed up for when they chose an oracle-based venue over an AMM.

**In-book MMs have a structural cost advantage that widens with size.** A patient MM already in the book pays only the Stacks tx fee to call settle — no slippage, no 0.30% swap fee, no inventory risk. More importantly, Bitflow slippage is **superlinear in size**: a JIT arb trying to scale their deposit to capture a bigger pro-rata share pays disproportionately more slippage per unit, so their per-unit profit shrinks as they grow and eventually flips negative. In-book MMs, by contrast, scale linearly. JIT arbs therefore **cannot displace in-book MMs**; they can only take small slices during real dislocation events.

### Natural equilibrium

- **Stable markets**: no arb opportunity. In-book MMs collect the full 20 bps uncontested.
- **Small/moderate dislocation**: small JIT arbs become profitable, share a small pro-rata slice, bridge Jing <-> Bitflow pricing. In-book MMs still take the bulk.
- **Extreme dislocation**: JIT arbs still can't scale (slippage eats them), in-book MMs continue to dominate.
- **Gate-tripping dislocation** (>10% DEX divergence, stale oracle, etc.): settlement fails, cycle cancels, deposits roll forward untouched.

### Implications for MM operators

Passive MMs are welcome. The in-book MM's structural advantages mean passive capital still dominates the premium. You don't need to run a bot to participate — you just accept that in dislocation events a small slice may leak to JIT arbs, in exchange for those arbs keeping Jing's clearing price in sync with external venues.

Bot-running is an **optional upgrade path**. An MM who runs a settle-bot can watch Pyth + Bitflow / Velar and trigger `close-deposits` + `settle-with-refresh` atomically when the oracle is favorable, capturing the premium before any JIT arb's Bitflow leg finishes. This watch-and-race strategy exists with or without a buffer — the buffer doesn't change the settle race itself. What zero-buffer uniquely provides is **costless `close-deposits` calling**: bundling close + settle in one tx means the close-caller takes zero drift risk.

---

## 2. Mandatory non-zero limit prices on every deposit

Every `deposit-stx`, `deposit-sbtc`, `set-stx-limit`, and `set-sbtc-limit` call now asserts `(> limit-price u0)` and rejects `u0` with `ERR_LIMIT_REQUIRED`. There is no longer a "fill at any price" option.

### Why

A `u0` limit in v1 meant "fill at any clearing price." That's dangerous: a user who accepts fills at any price transfers all pricing risk to the oracle + settlement mechanics, with no personal safety net. If anything goes wrong on our side (oracle staleness, extreme market move, bug), the user has no escape — they get whatever the clearing computation produces.

Forcing every depositor to pick an explicit limit:

1. **Shifts responsibility to the depositor.** If a bad fill happens, the depositor either (a) chose a bad limit or (b) the limit did its job and rolled them forward untouched. Either way, the contract cannot fill them at a price they didn't explicitly agree to.
2. **Eliminates the worst-case UX failure.** Users can update their limit mid-cycle via `set-stx-limit` / `set-sbtc-limit` without withdrawing, so there is no operational reason to ever set `u0`. Supporting it only enables footguns.
3. **Makes the "why didn't my trade fill?" question answerable by simple inspection.** "Your limit was X, clearing was Y, Y > X, you were rolled." No ambiguity.

Depositors who want to exit should call `cancel-stx-deposit` / `cancel-sbtc-deposit` during the deposit phase, not clear their limit to `u0`.

### Invariant: every active deposit has a matching limit entry

Input validation guarantees that any principal with a deposit in either `stx-deposits` / `sbtc-deposits` also has a corresponding entry in `stx-deposit-limits` / `sbtc-deposit-limits`. Every code path that adds a deposit atomically sets the limit (`deposit-stx`, `deposit-sbtc`, including the queue-bumping branches). Every exit path (`cancel-stx-deposit`, `cancel-sbtc-deposit`, bump-out, fully-filled distribution) deletes both atomically. Cycle rollovers (limit-violation roll, small-share roll, `cancel-cycle`) preserve limits because the limit maps are keyed by principal only, not by cycle — so a principal rolled from cycle N to N+1 keeps the same limit entry automatically.

Because the invariant holds, the limit-violation filters no longer need a defense-in-depth `(> limit u0)` check. The filters just compare `clearing` against `limit` directly:

- STX side: `(if (> clearing limit) roll fill)`
- sBTC side: `(if (< clearing limit) roll fill)`

### Why `get-stx-limit` / `get-sbtc-limit` still use `default-to u0`

The read-only helpers `get-stx-limit` and `get-sbtc-limit` keep their `(default-to u0 (map-get? ...))` pattern instead of using `unwrap-panic`. Reason: these getters are called inside `filter-limit-violating-*`, which runs under `(map filter-limit-violating-* depositors)` during `settle-with-refresh`. If any lookup panicked, it would brick the entire settlement — not just one depositor — cascading a single stale entry into a failed cycle that drags to cancel.

The invariant above makes the `default-to u0` branch unreachable under correct operation, so it costs nothing in practice. If a future refactor ever violated the invariant, the behavior would be:

- **STX side**: `clearing > 0` is always true, so `(> clearing 0)` is true, so the depositor would be rolled to the next cycle. Safe.
- **sBTC side**: `clearing < 0` is always false, so the depositor would fill at whatever clearing is. *Not* safe — the depositor would effectively have "no floor" until they notice and fix it.

The asymmetry is a latent footgun against future refactors, not an active concern. Any change that touches the deposit/limit-entry lifecycle should preserve the "deposit entry implies limit entry" invariant. If that's ever in doubt, the fix is to harden the invariant at the source (a new invariant test, a wrapper function that enforces atomic set/delete), not to harden the getters — because the getters can't panic without breaking settlement.

---

## 3. 60s oracle freshness window, even under network congestion

`MAX_STALENESS u60` (60 seconds for Pyth publish time). We do NOT tighten this further, and we do not add any "settle must be within N blocks of oracle publish" constraint on top.

### The trade-off

The alternative would be tighter freshness — say 15s — which would reduce the worst-case oracle drift exposure. But under Stacks network congestion, block propagation can slow; a 15s freshness window combined with a 4–5s block time leaves a narrow execution margin. During congestion events, `settle-with-refresh` would start failing on otherwise-valid oracle reads, forcing cycles to drag to cancel and roll forward repeatedly. That's worse UX than accepting slightly-stale fills.

### Why 60s is safe enough

The user-level safety net is **the mandatory limit price** (decision 2). If the oracle is 60s stale and the market has moved, one of two things happens:

1. The market moved **against** the depositor: their limit is violated by the clearing price computed from the stale oracle → they are rolled to the next cycle untouched. They are not harmed.
2. The market moved **in favor** of the depositor: their limit is still satisfied, they fill. No harm either.

The limit price is what makes 60s acceptable. Without limits, a 60s stale oracle could fill a user at a 2–3% worse price than live market during volatile events. With limits, the user's personal risk cap is enforced regardless of how stale or congested the oracle path becomes.

This is a key reason decisions 2 and 3 are linked: **limits are what let us stop worrying about oracle freshness in the execution path**. The contract trusts Pyth's staleness ceiling and trusts each depositor's chosen limit, and that combination handles the entire class of "settlement fires when external markets have moved" issues.

### Network congestion is not our problem to solve

If Stacks is congested to the point where oracle publishes can't land within 60s, the entire protocol is degraded — not just Jing. There's nothing a contract can do about that; the mitigation is at the infrastructure layer. What the contract *can* do is ensure that in the worst case, honest users are protected, and limits do exactly that.

---

## 4. Shortened cycle thresholds

- `DEPOSIT_MIN_BLOCKS u30` (was `u150`) — minimum blocks before `close-deposits` can be called. ~1 min at ~2s/block, down from ~5 min.
- `CANCEL_THRESHOLD u150` (was `u500`) — blocks after `close-deposits` before anyone can call `cancel-cycle`. ~5 min, down from ~16 min.

### Why

Faster cycles = more liquidity turnover for MMs, more frequent fills for users, less time for oracle drift to accumulate mid-cycle. The original longer windows were conservative defaults copied from the blind-auction template but have no specific safety role in a mandatory-limit design — if anything goes wrong, the safety net (limits + oracle gates) kicks in regardless of how long the deposit window was.

The ~1 min deposit window is long enough for multiple depositors to coordinate into a batch without being so long that inventory sits idle. The ~5 min cancel window is long enough that transient oracle-gate failures (a single bad Pyth update) don't force premature cancellation, but short enough that a genuinely stuck cycle doesn't lock funds for long.

---

## 5. 20 bps premium (down from 40 bps)

`PREMIUM_BPS u20`. Clearing price = `oracle × (10000 - 20) / 10000`.

The STX side (MMs supplying STX) earns the 20 bps; the sBTC side pays it. The spread is tight enough to be competitive with AMM pricing on modest-size fills, but wide enough that in-book MMs have a meaningful reward for providing the batched-oracle pricing service.

Dropping from 40 bps to 20 bps also makes JIT arbs less profitable for a given dislocation size, raising the threshold at which they become net-profitable (now roughly 60–80 bps of oracle-vs-external dislocation instead of 80–100 bps). In practice this means fewer JIT arb events, fewer same-side dilution moments for passive MMs, and a tighter natural clearing price relative to external venues.

---

## 6. Keep the core lean — no native `deposit+close+settle` bundling

The contract exposes `deposit-stx`, `deposit-sbtc`, `close-deposits`, `settle`, and `settle-with-refresh` as separate publics. It does NOT expose a bundled `deposit-and-settle` function. Routers, MM bots, and integrating protocols compose the separate publics via `contract-call?` in a wrapper contract.

### Rationale

Werner's "build as light as possible" guidance applies directly. `settle-with-refresh` is already the heaviest operation in the contract (Pyth VAA verification, DEX price read, depositor iteration, limit filtering, settlement map updates, fee transfers, distribution loops). Adding `close-deposits` logic inline would push runtime cost closer to the Clarity budget ceiling and reduce headroom for future additions (more depositor slots, additional gates, etc.).

Composing the separate publics in a wrapper contract via `contract-call?` adds essentially zero runtime cost — each public call is already a separate stack frame, and Clarity's execution model handles the sequencing cleanly. The bundling belongs at the wrapper layer, where it can also include additional legs (a Bitflow swap, a Velar leg, a router settlement) that the core contract should not know about.

Concrete benefits of staying lean:

- **Smaller audit surface.** Fewer public functions, less code to review, fewer ways for the contract to be misused.
- **Runtime headroom.** `settle-with-refresh` needs to leave enough budget for gate checks, filtering, distribution, and future iteration growth. Every extra op in the core contract eats that margin.
- **Composability flexibility.** A wrapper can bundle close+settle with any combination of other protocol calls; a native bundled function locks you into one specific composition pattern.

### Who writes the wrapper?

Anyone who needs the atomic bundle. The jing team can ship a canonical wrapper alongside the core contract, but it's a separate artifact, not part of `blind-premium.clar`. External integrators (aggregators, router protocols) will write their own wrappers tuned to their specific routing logic.

---

## What we are NOT defending against

- **Oracle staleness within the 60s Pyth window**: see decision 3. Limits handle this.
- **Honest users' counterfactual loss vs external venues**: a user who chose oracle-based pricing accepts that the clearing price may occasionally differ from a live AMM. If they wanted Bitflow's live price, they should use Bitflow. The contract cannot protect them against their own venue choice.
- **MM dilution by JIT arbs in dislocation events**: this is the explicit trade-off for composability. MMs who care should run bots (see decision 1).
- **Network congestion beyond the 60s Pyth window**: not a contract problem. Infrastructure-layer issue.

## Alternatives considered and rejected

- **Small buffer (5–10 blocks)**: would restore some JIT arb holding risk, but breaks atomic composability for routers. Rejected.
- **`pyth_publish_time >= deposits-closed-block-timestamp` rule in `settle-with-refresh`**: would prevent backward oracle-snapshot selection, but also breaks same-block close+settle bundling. Rejected for the same reason.
- **Tighter oracle freshness (e.g. 15s)**: would reduce worst-case drift exposure, but triggers spurious cancellations during congestion. Limits already handle the harm case. Rejected.
- **Keeping `u0` as "no limit" with a warning**: supports a footgun for no benefit. Users who want to be filled aggressively can just set a very wide limit. Rejected.
- **Native `deposit+close+settle` bundled function**: saves a marginal amount of runtime, costs audit surface and flexibility. Rejected. Compose in wrappers.
