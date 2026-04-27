// simul-jing-loan-errors.js
// Stxer mainnet fork simulation: error-case bundle.
//
// Exercises the contract's assertion guards that haven't been covered by the
// other simulations. Runs a minimal happy-path borrow up front, then fires a
// sequence of intentionally-bad calls and confirms each one errors with the
// expected code.
//
// Not covered here:
//   - ERR-DEADLINE-NOT-REACHED (u108) on seize → CLAWBACK-DELAY u0 in the
//     Stxer clone makes this unreachable. Must be tested against the
//     production contract (CLAWBACK-DELAY u4200).
//
// Run: npx tsx simulations/simul-jing-loan-errors.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";
import { verifyAndReport } from "./_verify.js";

const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

const WHALE_TO_LENDER = 100_000_000; // seed
const FUND_AMOUNT = 50_000_000;
const LOAN_PRINCIPAL = 20_000_000;       // valid borrow
const SECOND_BORROW = 10_000_000;        // would-be second loan — must err u104
const TOO_SMALL_BORROW = 500_000;        // below min-sbtc-borrow u1000000
const ARBITRARY_BAD_ID = 999;            // loan-id that doesn't exist

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN ERROR CASES BUNDLE ===\n");
  console.log("Exercises every reachable assertion guard.\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    // Deploy
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Seed LENDER
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

    // -------- Baseline: fund + valid borrow (creates the active loan) --------
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })

    // Pre-fund error: non-lender `fund` → ERR-NOT-LENDER? Actually `fund` doesn't
    // have that guard — anyone can contribute? Let's check the code:
    //   (asserts! (is-eq caller LENDER) ERR-NOT-LENDER)  ← yes it does
    // Non-LENDER fund should err u100.
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(1_000_000)],
    })
    // expected: (err u100) ERR-NOT-LENDER

    // -------- ERR-AMOUNT-TOO-LOW (u102): borrow below min-sbtc-borrow --------
    // Default min-sbtc-borrow = u1000000. TOO_SMALL_BORROW = 500_000 < 1_000_000.
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(TOO_SMALL_BORROW)],
    })
    // expected: (err u102) ERR-AMOUNT-TOO-LOW

    // -------- ERR-NOT-BORROWER (u101): non-borrower tries to borrow --------
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL)],
    })
    // expected: (err u101) ERR-NOT-BORROWER

    // -------- Valid borrow — creates active loan u1 --------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // (some u1)

    // -------- ERR-ACTIVE-LOAN-EXISTS (u104): 2nd borrow while one is active --------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(SECOND_BORROW)],
    })
    // expected: (err u104) ERR-ACTIVE-LOAN-EXISTS

    // -------- ERR-LOAN-NOT-FOUND (u105): repay a loan-id that doesn't exist --------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(ARBITRARY_BAD_ID)],
    })
    // expected: (err u105) ERR-LOAN-NOT-FOUND

    // -------- ERR-BAD-STATUS (u106): repay on a PRE-SWAP loan (no swap-deposit) --------
    // Loan u1 is in status u0 (PRE-SWAP) since we haven't called swap-deposit.
    // repay requires status = SWAP-DEPOSITED (u1).
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })
    // expected: (err u106) ERR-BAD-STATUS

    // -------- ERR-BAD-STATUS (u106): cancel-swap on a PRE-SWAP loan --------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    // expected: (err u106) ERR-BAD-STATUS

    // -------- ERR-NOT-BORROWER (u101): non-borrower cancel-swap --------
    // (Also, loan is PRE-SWAP — so status assertion would hit first in practice.
    //  The `is-eq status SWAP-DEPOSITED` comes before the caller check in
    //  cancel-swap, so this will actually still be u106. Leaving in for
    //  completeness but noting the order-of-asserts matters.)

    // -------- ERR-NOT-LENDER (u100): non-lender set-interest-bps --------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-interest-bps",
      function_args: [uintCV(500)],
    })
    // expected: (err u100) ERR-NOT-LENDER

    // -------- ERR-NOT-LENDER (u100): non-lender set-min-sbtc-borrow --------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-min-sbtc-borrow",
      function_args: [uintCV(2_000_000)],
    })
    // expected: (err u100) ERR-NOT-LENDER

    // -------- Final sanity checks: loan state still intact --------
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // status u0 (PRE-SWAP), principal LOAN_PRINCIPAL
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // still (some u1)
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // 50M - 20M = 30M
    .addEvalCode(CONTRACT_ID, "(get-interest-bps)") // u100 (unchanged by failed setter)
    .addEvalCode(CONTRACT_ID, "(get-min-sbtc-borrow)") // u1000000 (unchanged)

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN ERRORS");
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
