# blind-premium — Jing v2 batch auction with limit orders

`blind-premium.clar` is a fork of `blind-auction.clar` that adds two
features (premium pricing + per-depositor limit orders) and drops one
safeguard (the 30-block buffer) that limits make redundant.

Both contracts can run side by side: the vanilla `blind-auction` is the
no-frills venue that clears at oracle, `blind-premium` is the upgraded
venue for users who want limit-order semantics or who want to source /
pay a premium for faster fills.

---

## What's new vs `blind-auction`

### 1. Premium-adjusted clearing price

Settlement clears at
`clearing-price = oracle-price * (10000 - PREMIUM_BPS) / 10000`

`PREMIUM_BPS` is a contract constant (currently `u40` = 0.40%). The
premium favours the **STX side** — STX depositors receive slightly more
sBTC per STX than oracle says, sBTC sellers receive slightly less STX
per sBTC. The sBTC-selling side is effectively paying a tip to
incentivise STX-side market makers to absorb their flow.

Premium direction and size are fixed at compile time. If you need the
opposite direction or a different rate, fork the contract — keeping the
premium as a constant avoids governance surface in v1.

All three oracle safety gates (staleness, confidence, DEX sanity) still
run on `oracle-price` before the premium is applied, so the premium
cannot be weaponised to clear at a bad price if the oracle itself is
unhealthy.

### 2. Per-depositor limit orders

Every `deposit-stx` / `deposit-sbtc` call takes a second argument:

- `deposit-stx (amount uint) (limit-price uint)` —
  `limit-price` = maximum STX-per-sBTC the depositor is willing to pay
- `deposit-sbtc (amount uint) (limit-price uint)` —
  `limit-price` = minimum STX-per-sBTC the depositor will accept
- `limit-price = u0` means "no limit, fill at whatever the premium
  clearing price is" — identical to `blind-auction` semantics

Limits are stored in `stx-deposit-limits` / `sbtc-deposit-limits`,
keyed by `principal` (not cycle). They **persist across cycles** as
long as the depositor has funds in the system:

- Set on every `deposit-*` call (fresh deposit or top-up overwrites)
- Set independently via `set-stx-limit` / `set-sbtc-limit` (no deposit
  required)
- Carried automatically across cycle rollovers, small-share rolls,
  limit-violation rolls, partial fills, and cycle cancels
- Deleted when the depositor exits: `cancel-*-deposit`, bump by a
  larger whale, or fully filled with no unfilled rollover

At settlement, `execute-settlement`:

1. Reads oracle, runs the three gates
2. Computes the premium-adjusted `clearing-price`
3. Stores it in the `settle-clearing-price` scratch var
4. Runs `filter-limit-violating-stx-depositor` and
   `filter-limit-violating-sbtc-depositor` over the current depositor
   lists — any depositor whose limit is violated by the clearing price
   is rolled to the next cycle (funds move to `cycle+1`, limit stays in
   the principal-keyed map)
5. Re-reads totals and computes binding side / fills on the remaining
   clean cohort
6. Distribution runs as before

Because the clearing price depends only on oracle + premium, a single
filter pass is sufficient — removing depositors can't change clearing,
so no cascading re-evaluation is needed.

### 3. No buffer phase

`BUFFER_BLOCKS = u0` (vs `u30` in `blind-auction`). The buffer existed
to make the settlement price unknowable during deposit phase, foiling
arb bots that would deposit once they could predict clearing.

With per-depositor limits, the arb strategy is impossible:
- If an arber deposits with `limit = u0`, they get whatever clearing
  is, same as everyone — no edge
- If they deposit with a tight limit trying to pin clearing, they get
  rolled if clearing doesn't hit their target
- The three oracle gates still prevent clearing at a manipulated price

Removing the buffer means deposits can be included right up to
`close-deposits`, improving fill latency without opening any
new attack vector.

### 4. Standalone limit update

```clarity
(define-public (set-stx-limit (limit-price uint)))
(define-public (set-sbtc-limit (limit-price uint)))
```

Users can adjust their clearing-price limits without having to redeposit.
Only callable during `PHASE_DEPOSIT`, and only by a principal that
already has a non-zero deposit on that side in the current cycle. Takes
effect at the next `execute-settlement`. Useful for traders who want to
tighten or loosen a limit as conditions evolve while the cycle is still
open.

---

## Squatter problem (known, not mitigated in v1)

A user who deposits a large amount with an absurd limit (e.g. sBTC
deposit with `limit-price = 2 * oracle`) is permanently rolled forward
by `filter-limit-violating-sbtc-depositor` every settlement, and because
their amount is large the bump mechanism can't displace them. They
effectively occupy a depositor slot forever until they voluntarily
cancel.

**In v1 we do nothing about this.** Rationale:
- The attacker has to lock real capital (the deposit) to grief
- v1 users are high-intent (Friedger-tier), not anonymous adversaries
- Organic small-squatters are already handled by bump + small-share roll
- Adding enforcement cuts the core limit-order value prop (placing
  far-OTM orders in advance is a legitimate use case)

### Three options we considered (documented for future iteration)

**(A) Do nothing (chosen).** Squatters pay capital opportunity cost;
real users route around them. Smallest code, smallest attack surface,
smallest feature loss. Revisit if squatting becomes observable in
production.

**(B) Deposit-time oracle range check.** At deposit, assert
`limit-price` is within ±X% of current oracle. Pros: prevents squatters
at the door. Cons: every `deposit-*` call pays an oracle read (gas),
and legitimate users who want to place "buy at -30%" cannot do so
ahead of time — which is exactly the use case limit orders exist for.
**We rejected this** because it neuters the feature.

**(C) Roll-attempt counter.** Track `{principal → uint}` of consecutive
limit-violation rolls without a fill. After some threshold
(`MAX_LIMIT_ROLLS`, e.g. `u10`), auto-refund and delete the deposit
during `filter-limit-violating-*`. Pros: preserves far-future limit
orders up to the threshold, evicts dead orders after N cycles of
non-fill. Cons: new state (counter map), new eviction branch inside
settle (which means extra token transfers inside the settle atomic
unit), and the threshold is arbitrary — legitimate deep-OTM orders
might get kicked just before the market comes to them. Migration path
from v1 is additive: add the counter map + threshold constant + branch.

If we ever implement (C), the flow is:

1. In `filter-limit-violating-*`, when a violation is detected:
   - Read `roll-count`, increment
   - If `roll-count < MAX_LIMIT_ROLLS`: current behavior (roll forward)
   - Else: refund amount to `depositor` via `as-contract?`, delete
     deposit, delete limit, delete counter entry, emit a
     `limit-evicted-*` event
2. Reset counter on successful fill (`distribute-to-*-depositor` path,
   when `my-*-received > 0`)
3. Reset counter on explicit cancel / limit update via `set-*-limit`

---

## Lifecycle cheat-sheet

```
deposit-*           → set amount + set limit (principal-keyed)
set-*-limit         → set limit only (any time)
cancel-*-deposit    → delete amount + delete limit
bump in deposit     → displaced depositor: refund + delete limit
filter-small-*      → amount rolled forward, limit stays in principal map
filter-limit-*      → amount rolled forward, limit stays in principal map
distribute-to-*     → unfilled rolls forward (limit stays);
                      fully filled (no unfilled) → delete limit
cancel-cycle        → amounts rolled forward, limits stay
```

Rule of thumb: **the limit entry exists iff the principal has funds in
the system**, and is overwritten only by explicit deposit or
`set-*-limit` calls.

---

## Vault integration (planned)

`jing-vault-v1.clar` (in this repo) will execute signed SIP-018 intents
into either `blind-auction` or `blind-premium` via a shared
`jing-auction-trait` abstraction. The signed intent will include:

- `auction-contract: principal` — which venue to route into
- `limit-price: uint` — forwarded to `deposit-*` on the chosen venue
- The vault asserts the caller-supplied auction trait's
  `(contract-of ...)` matches the signed `auction-contract` field, so a
  keeper cannot route into an unexpected venue

Off-chain (faktory-dao backend) tracks post-execution monitoring state:
`retract-price`, `retract-condition`, `max-hold-blocks`, and
`executed-at-block`. A cron polls oracle and block-height and calls the
vault's `retract-side(auction, side)` function when the owner's
off-chain signal says to pull the deposit back. This monitoring is
explicitly not enforced on-chain — the keeper is a trusted off-chain
entity paid out-of-band.
