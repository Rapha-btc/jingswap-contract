# blind-premium v2: Design Decisions

This doc explains the intentional design choices in `blind-premium.clar` that deviate from the original `blind-auction.clar`. Each decision is listed with its rationale, the attack vectors it opens or closes, and the alternatives that were rejected.

## Summary of decisions

1. **No buffer between `close-deposits` and `settle`** — enables atomic composability with routers and other protocols.
2. **Mandatory non-zero limit prices on every deposit** — shifts responsibility for price tolerance onto the depositor.
3. **80s oracle freshness window** — enough headroom for bundled close+settle to land, tighter than Zest v2's 120s, with limits as the user-level safety net. Kept as a constant, not a data-var.
4. **Shortened cycle thresholds** (`DEPOSIT_MIN_BLOCKS u10`, `CANCEL_THRESHOLD u42`) — ~70s min deposit window at ~7s/block, ~5 min to cancel a stuck cycle.
5. **20 bps premium** (down from 40 bps in an earlier draft) — narrower MM spread for more competitive clearing.
6. **Bundled `close-and-settle-with-refresh`** — the natural happy path (close + settle in one tx) is exposed natively; `deposit+close+settle` bundling is left to wrapper contracts.

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

## 3. 80s oracle freshness window (constant, not adjustable)

`MAX_STALENESS u80` (80 seconds for Pyth publish time). This is a `define-constant`, not a `define-data-var`.

### Why 80s

The primary driver is the bundled `close-and-settle-with-refresh` function (decision 6). After a deposit phase of at least 10 blocks (~70s at ~7s/block), the caller fetches a fresh Pyth VAA off-chain and submits the bundle. The VAA's publish-time must be within 80s of the block's timestamp when the tx lands. At ~7s block times, the caller has ~11 blocks of headroom between fetching the VAA and the tx landing — comfortable for normal conditions and enough buffer for 1–2 congested blocks.

Comparison: Zest v2 uses `u120` (120 seconds) for Pyth feeds on their lending market, where stale prices create insolvency risk via bad liquidations. Jing's batch auction is lower-stakes — a stale clearing price just rolls limit-violating depositors instead of creating bad debt. So 80s is tighter than Zest while being more generous than 60s.

### Why not tighter (e.g. 15s)

Under Stacks network congestion, block propagation can slow. A 15s freshness window combined with ~7s block times leaves a razor-thin execution margin. During congestion events, `settle-with-refresh` and the bundled function would start failing on otherwise-valid oracle reads, forcing cycles to drag to cancel and roll forward repeatedly. That's worse UX than accepting slightly-stale fills.

### Why limits make 80s safe

The user-level safety net is **the mandatory limit price** (decision 2). If the oracle is 80s stale and the market has moved:

1. The market moved **against** the depositor: their limit is violated by the clearing price computed from the stale oracle -- they are rolled to the next cycle untouched. Not harmed.
2. The market moved **in favor** of the depositor: their limit is still satisfied, they fill. No harm either.

This is a key reason decisions 2 and 3 are linked: **limits are what let us stop worrying about oracle freshness in the execution path**. The contract trusts Pyth's staleness ceiling and trusts each depositor's chosen limit, and that combination handles the entire class of "settlement fires when external markets have moved" issues.

### Why a constant, not a data-var

Zest v2 uses per-asset `max-staleness` set via governance proposals. We use a global constant instead. Reasons:

1. **Predictability.** Users and integrators can inspect the constant and know the freshness guarantee will never change without a new contract deployment. No admin can silently widen the window.
2. **Simpler trust model.** A data-var adds an admin key that can change the staleness threshold. For a lending protocol with governance this is manageable; for a batch auction where users commit limit-bounded deposits, the simpler trust story is "the contract is the contract."
3. **If 80s proves wrong in practice**, cycles will fail and get cancelled -- users are rolled, not harmed. The fix is deploying a new contract version with an updated constant, not an admin tx that nobody notices.

### Network congestion is not our problem to solve

If Stacks is congested to the point where oracle publishes can't land within 80s, the entire protocol is degraded -- not just Jing. There's nothing a contract can do about that; the mitigation is at the infrastructure layer. What the contract *can* do is ensure that in the worst case, honest users are protected, and limits do exactly that.

---

## 4. Shortened cycle thresholds

- `DEPOSIT_MIN_BLOCKS u10` (was `u150`) -- minimum blocks before `close-deposits` can be called. ~70s at ~7s/block (Nakamoto average), down from ~17.5 min.
- `CANCEL_THRESHOLD u42` (was `u500`) -- blocks after `close-deposits` before anyone can call `cancel-cycle`. ~5 min at ~7s/block, down from ~58 min.

Note: Nakamoto block times average ~6.8-7.1s, not the ~2s sometimes cited. All timing estimates use ~7s/block.

### Why

Faster cycles = more liquidity turnover for MMs, more frequent fills for users, less time for oracle drift to accumulate mid-cycle. The original longer windows were conservative defaults copied from the blind-auction template but have no specific safety role in a mandatory-limit design -- if anything goes wrong, the safety net (limits + oracle gates) kicks in regardless of how long the deposit window was.

`DEPOSIT_MIN_BLOCKS u10` is a **floor**, not a target. The ~70s window is long enough for users to see the cycle, deposit, and cancel if they change their mind. Keepers or MM bots can wait longer before calling `close-deposits` if they want more deposits to accumulate -- the constant just sets the earliest possible close.

`CANCEL_THRESHOLD u42` (~5 min) is long enough that transient oracle-gate failures (a single bad Pyth update, a momentary DEX divergence spike) don't force premature cancellation, but short enough that a genuinely stuck cycle doesn't lock funds for long.

---

## 5. 20 bps premium (down from 40 bps)

`PREMIUM_BPS u20`. Clearing price = `oracle × (10000 - 20) / 10000`.

The STX side (MMs supplying STX) earns the 20 bps; the sBTC side pays it. The spread is tight enough to be competitive with AMM pricing on modest-size fills, but wide enough that in-book MMs have a meaningful reward for providing the batched-oracle pricing service.

Dropping from 40 bps to 20 bps also makes JIT arbs less profitable for a given dislocation size, raising the threshold at which they become net-profitable (now roughly 60–80 bps of oracle-vs-external dislocation instead of 80–100 bps). In practice this means fewer JIT arb events, fewer same-side dilution moments for passive MMs, and a tighter natural clearing price relative to external venues.

---

## 6. Bundled `close-and-settle-with-refresh`, but no `deposit+close+settle`

The contract exposes `close-and-settle-with-refresh` as a native public that calls `close-deposits` then `settle-with-refresh` in one tx. This is the natural happy path: deposits accumulate during the deposit phase, then someone triggers the bundled close+settle.

The function is thin -- it just chains the two existing publics:

```clarity
(define-public (close-and-settle-with-refresh ...)
  (begin
    (try! (close-deposits))
    (try! (settle-with-refresh ...))
    (ok true)))
```

### Why bundle close+settle but not deposit+close+settle

Calling close is almost always immediately followed by settle -- there's no reason to close and NOT settle. Bundling saves a tx and makes the UX simpler for keepers and bots.

Deposit is a separate concern: it belongs to a different phase and a different actor (the depositor vs the settle-caller). Bundling deposit into the same function would add runtime cost (deposit involves queue management, bump logic, limit validation) to an already-heavy path, and would serve a narrow use case (JIT arbs who want everything atomic). Routers and JIT arbs who want deposit+close+settle can compose the publics via `contract-call?` in a wrapper contract -- the runtime cost of chaining is negligible.

### Why not a bundled `close-and-settle` (no refresh)?

After a deposit phase of at least 10 blocks (~70s), stored Pyth prices are almost certainly stale. `close-and-settle` (without refresh) would fail on the `MAX_STALENESS u80` gate nearly every time. The rare case where stored prices happen to be fresh enough is not worth a dedicated public function -- users can call `close-deposits` + `settle` separately for that path.

### Core stays lean where it matters

Werner's "build as light as possible" guidance still applies to the heavy path. The bundled function adds zero runtime overhead beyond a function call frame -- it's the same ops as calling both publics separately. The core contract does not bundle deposit+close+settle, deposit+settle, or any multi-venue routing logic. Those compositions belong in wrapper contracts where integrators can add their own legs (Bitflow, Velar, slippage checks, fee splits).

---

## What we are NOT defending against

- **Oracle staleness within the 80s Pyth window**: see decision 3. Limits handle this.
- **Honest users' counterfactual loss vs external venues**: a user who chose oracle-based pricing accepts that the clearing price may occasionally differ from a live AMM. If they wanted Bitflow's live price, they should use Bitflow. The contract cannot protect them against their own venue choice.
- **MM dilution by JIT arbs in dislocation events**: this is the explicit trade-off for composability. MMs who care should run bots (see decision 1).
- **Network congestion beyond the 80s Pyth window**: not a contract problem. Infrastructure-layer issue. If settlement repeatedly fails due to stale prices, the cycle gets cancelled after ~5 min and deposits roll forward -- users are never harmed.

## Alternatives considered and rejected

- **Small buffer (5--10 blocks)**: would restore some JIT arb holding risk, but breaks atomic composability for routers. Rejected.
- **`pyth_publish_time >= deposits-closed-block-timestamp` rule in `settle-with-refresh`**: would prevent backward oracle-snapshot selection, but also breaks same-block close+settle bundling. Rejected for the same reason.
- **Tighter oracle freshness (e.g. 15s)**: would reduce worst-case drift exposure, but triggers spurious cancellations during congestion. Limits already handle the harm case. Rejected.
- **Wider oracle freshness (120s, matching Zest v2)**: more headroom, but unnecessary given that Jing's drift risk is capped by limits (unlike Zest where stale prices create insolvency risk). 80s gives enough room for the bundled close+settle path while staying tighter than lending protocols.
- **`MAX_STALENESS` as a `data-var` (admin-adjustable)**: adds a trust assumption (admin can silently widen the window). For a batch auction with limit-bounded deposits, the simpler trust story is a constant. If 80s proves wrong, deploy a new version.
- **Keeping `u0` as "no limit" with a warning**: supports a footgun for no benefit. Users who want to be filled aggressively can just set a very wide limit. Rejected.
- **Native `deposit+close+settle` bundled function**: adds runtime cost and audit surface to the heavy path. Routers/JIT arbs compose the publics in wrapper contracts. Rejected.
- **Bundled `close-and-settle` (no refresh)**: stored prices are almost always stale after the deposit phase (~70s+). The no-refresh path is useful but rare enough that users can call `close-deposits` + `settle` separately. Rejected.
