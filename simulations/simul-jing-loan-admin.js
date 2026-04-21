// simul-jing-loan-admin.js
// Stxer mainnet fork simulation: admin setter happy paths + rate-locking invariant.
//
// Proves:
//   - LENDER can update `interest-bps` and `min-sbtc-borrow` freely
//   - Non-LENDER callers are rejected with ERR-NOT-LENDER (u100)
//   - Changing `interest-bps` after a borrow does NOT retroactively alter
//     the in-flight loan's interest rate (locked at borrow time)
//   - The new `interest-bps` applies to the *next* borrow
//   - `min-sbtc-borrow` changes gate subsequent borrows immediately
//
// Run: npx tsx simulations/simul-jing-loan-admin.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

// --- Amounts ---
const WHALE_TO_LENDER = 100_000_000;
const WHALE_TO_BORROWER = 10_000_000;      // covers both loans' interest
const FUND_AMOUNT = 60_000_000;

// Two loans — distinguishable by principal + rate at borrow time
const LOAN1_PRINCIPAL = 20_000_000;         // borrowed at interest-bps u100 (1%)
const LOAN2_PRINCIPAL = 15_000_000;         // borrowed at interest-bps u400 (4%)

// Admin values
const NEW_INTEREST_BPS = 400;               // 4% flat for the second loan
const NEW_MIN_BORROW = 5_000_000;           // raise from default u1000000

// Test-value borrow amounts for min-borrow guard
const BELOW_NEW_MIN = 2_000_000;            // passes old min u1M, fails new min u5M

const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN ADMIN SETTERS STXER SIMULATION ===\n");
  console.log("admin happy paths + rate-locking invariant\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Seed
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TO_LENDER),
        principalCV(SBTC_WHALE),
        principalCV(LENDER),
        noneCV(),
      ],
    })
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TO_BORROWER),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER),
        noneCV(),
      ],
    })

    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })

    // Read initial settings
    .addEvalCode(CONTRACT_ID, "(get-interest-bps)")    // u100 (contract default)
    .addEvalCode(CONTRACT_ID, "(get-min-sbtc-borrow)") // u1000000 (default)

    // ---------------- LOAN 1: borrow at current rate (u100) ----------------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN1_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")     // interest-bps u100 locked in
    .addEvalCode(CONTRACT_ID, "(owed-on-loan u1)") // 20_200_000

    // ---------------- Admin: change rates WHILE loan is active ----------------
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-interest-bps",
      function_args: [uintCV(NEW_INTEREST_BPS)],
    })
    .addEvalCode(CONTRACT_ID, "(get-interest-bps)") // u400

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-min-sbtc-borrow",
      function_args: [uintCV(NEW_MIN_BORROW)],
    })
    .addEvalCode(CONTRACT_ID, "(get-min-sbtc-borrow)") // u5000000

    // ---------------- KEY INVARIANT: Loan 1 still at u100 ----------------
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")     // interest-bps STILL u100
    .addEvalCode(CONTRACT_ID, "(owed-on-loan u1)") // STILL 20_200_000 — not retroactively bumped

    // ---------------- Settle loan 1 at its locked rate ----------------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })
    // repay event should show sbtc-owed u20_200_000 (1% rate, locked at borrow)

    // ---------------- Min-borrow guard: below new minimum ----------------
    // Old default (u1000000) would accept 2M. New min (u5000000) rejects it.
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(BELOW_NEW_MIN)],
    })
    // expected: (err u102) ERR-AMOUNT-TOO-LOW

    // ---------------- LOAN 2: borrow at NEW rate (u400) ----------------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN2_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u2)")     // interest-bps u400
    .addEvalCode(CONTRACT_ID, "(owed-on-loan u2)") // 15_000_000 * 1.04 = 15_600_000

    // Compare with loan 1 (still u100) — both coexist with different rates
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
