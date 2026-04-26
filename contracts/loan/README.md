# Jing Loan Reserve + SNPL System

Two-contract setup for swap-now-pay-later (snpl) loans that draw against
a pooled sBTC reserve and execute on Jing v2 auctions. Both contracts
have canonical bytecode: the lender (on the reserve), borrower (on the
snpl), and configured reserve (on the snpl) are all runtime-set via
data-vars rather than baked into source. Same source code → same hash
across all deployments.

## Contracts

- `reserve-trait.clar` — minimal interface (`draw`, `notify-return`)
  that any reserve must implement.
- `snpl-trait.clar` — interface (`get-borrower`, `get-reserve`,
  `borrow`, `repay`, `seize`, plus loan views) used by the reserve at
  credit-line opening to verify configuration, and by external
  consumers to interact with any snpl.
- `loan-reserve.clar` — pooled sBTC funding layer. Holds credit lines
  per snpl with `cap-sbtc`, `interest-bps`, `outstanding-sbtc`. Lender
  is set once at deploy via `initialize`.
- `loan-sbtc-stx-0-jing.clar` — per-borrower snpl specialized for
  `sbtc-stx-0-jing-v2`. Borrower and configured reserve are set once
  at deploy via `initialize`; thereafter the borrower can swap
  reserves between loans via `set-reserve`.

## Lifecycle

1. Deploy `reserve-trait`, `snpl-trait`, `loan-reserve`, and one or
   more snpls.
2. Reserve deployer calls `loan-reserve.initialize(lender)` once.
3. Snpl deployer calls `snpl.initialize(borrower, reserve)` once.
4. Lender supplies sBTC: `loan-reserve.supply(amount)`.
5. Lender opens a credit line:
   `loan-reserve.open-credit-line(snpl, borrower, cap, interest-bps)`.
   The reserve calls `snpl.get-borrower` to verify the borrower
   principal matches what the lender intended.
6. Borrower draws: `snpl.borrow(amount, expected-bps, reserve-trait)`.
7. Borrower swaps on Jing: `snpl.swap-deposit(loan-id, limit-price)`.
   Can `cancel-swap` and redeposit until deadline.
8. After Jing fully resolves, borrower closes:
   `snpl.repay(loan-id, reserve-trait)`. Or, after deadline, anyone
   calls `snpl.seize(loan-id, reserve-trait)`.
9. Lender withdraws supplied capital or seize-proceeds:
   `loan-reserve.withdraw-sbtc(amount)` /
   `loan-reserve.withdraw-stx(amount)`.
10. Between loans, borrower can swap reserves:
    `snpl.set-reserve(new-reserve-trait)`. Blocked while a loan is
    active so the borrower can't redirect payoff away from the
    funding reserve.

## Canonical bytecode

Neither contract contains a hardcoded mainnet principal beyond the
SBTC token contract address. The `LENDER`, `BORROWER`, and `RESERVE`
of the original PoC have all been replaced with data-vars defaulting
to `SAINT` (`'SP000000000000000000002Q6VF78`), set at deploy time via
`initialize`. This means a registry of approved snpl/reserve
implementations only needs to track one source-hash per contract type.

## Post-POC follow-ups

### Loan record shape locked into the trait

`snpl-trait.get-loan` specifies the full loan record shape. Future
snpl variants that need different fields (e.g., a different swap
venue with different metadata) will require a trait revision and
parallel deployment.
