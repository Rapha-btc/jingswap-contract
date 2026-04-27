// simul-jing-loan-serial.js
// Stxer mainnet fork simulation: two consecutive loans in the same contract.
//
// Proves that after a clean repay:
//   - `active-loan` clears to `none`
//   - `next-loan-id` increments
//   - A second borrow creates loan u2 with fresh state (principal, deadline,
//     status u0) while the prior loan u1 is preserved with status u2 (REPAID)
//   - The second loan goes through the full swap-deposit → cancel-swap →
//     repay cycle independently
//
// Both loans use the cancel-swap path (not real Jing settlement) for brevity.
// The true-happy-path and rollover simulations already prove Jing integration.
//
// Run: npx tsx simulations/simul-jing-loan-serial.js
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
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

const WHALE_TO_LENDER = 100_000_000;
const WHALE_TO_BORROWER = 5_000_000;  // covers interest on both loans
const FUND_AMOUNT = 60_000_000;       // 0.6 sBTC — enough for 2 serial loans
const LOAN1_PRINCIPAL = 20_000_000;   // 0.2 sBTC
const LOAN2_PRINCIPAL = 25_000_000;   // 0.25 sBTC — different size to distinguish
const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN SERIAL LOANS STXER SIMULATION ===\n");
  console.log("loan 1: borrow→swap-deposit→cancel-swap→repay");
  console.log("loan 2: borrow→swap-deposit→cancel-swap→repay\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Seed LENDER + BORROWER
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

    // Fund pool
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })

    // ---------------- LOAN 1 ----------------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN1_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // (some u1)

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
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")     // status u2 (REPAID)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // none ← critical
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // 40M (60M - 20M)

    // ---------------- LOAN 2 ----------------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN2_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // (some u2) ← next-loan-id incremented
    .addEvalCode(CONTRACT_ID, "(get-loan u2)")     // fresh loan: status u0, principal 25M
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")     // loan 1 still status u2 (REPAID) — preserved
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // 15M (40M - 25M)

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(2), uintCV(LIMIT_PRICE)],
    })

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(2)],
    })

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(2)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u2)")     // status u2 (REPAID)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // none again
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // 15M (untouched)

    // Final balances
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect 15M (only the remaining available-sbtc)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    ) // LENDER net: -60M fund + 20.2M (loan1 owed) + 25.25M (loan2 owed) + initial balance

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN SERIAL");
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
