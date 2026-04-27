// simul-jing-loan-seize.js
// Stxer mainnet fork simulation: jing-loan seize (default) path.
//
// Flow:
//   1. LENDER fund
//   2. BORROWER borrow
//   3. BORROWER swap-deposit                     (real Jing v2 deposit)
//   4. LENDER cancel-swap                        (allowed because CLAWBACK-DELAY
//                                                  u0 makes deadline=now, so
//                                                  lender can unilaterally pull
//                                                  sBTC back to unblock seize)
//   5. STX whale → contract                      (simulates Jing STX payout that
//                                                  would normally land via
//                                                  cycle settlement)
//   6. LENDER seize
//
// Run: npx tsx simulations/simul-jing-loan-seize.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";
import { verifyAndReport } from "./_verify.js";

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const STX_WHALE = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3"; // ~18k STX

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

// --- Amounts ---
const FUND_AMOUNT = 22_000_000;    // 0.22 sBTC
const LOAN_PRINCIPAL = 22_000_000; // whole stash
const SYNTHETIC_STX_PAYOUT = 5_000_000_000; // 5,000 STX — stands in for Jing payout
const LIMIT_PRICE = 31_152_648_000_000; // 311,526.48 STX/BTC (1e8 precision)

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN SEIZE PATH STXER SIMULATION ===\n");
  console.log("fund → borrow → swap-deposit → LENDER cancel-swap → STX payout → seize\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    // 1. Deploy as LENDER
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // 2. LENDER funds
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect 22_000_000

    // 3. BORROWER borrows
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // status u0 (PRE-SWAP)
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect u0

    // 4. BORROWER deposits into Jing
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // status u1 (SWAP-DEPOSITED)
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${CONTRACT_ID})`
    ) // expect 22_000_000

    // 5. LENDER cancel-swap — deadline satisfied immediately (CLAWBACK-DELAY u0)
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${CONTRACT_ID})`
    ) // expect u0
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect 22_000_000 — recovered

    // 6. STX whale → contract (simulates Jing STX payout)
    .withSender(STX_WHALE)
    .addSTXTransfer({ recipient: CONTRACT_ID, amount: SYNTHETIC_STX_PAYOUT })
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`) // expect SYNTHETIC_STX_PAYOUT

    // 7. LENDER seizes
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "seize",
      function_args: [uintCV(1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")       // status u3 (SEIZED)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)")   // expect none
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`) // expect u0 — all STX to LENDER
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect u0 — recovered sBTC also to LENDER
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    ) // LENDER sBTC restored to ~start (got recovered 22M back, no interest earned)
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${LENDER})`) // LENDER's STX += 5000 STX

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN SEIZE");
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
