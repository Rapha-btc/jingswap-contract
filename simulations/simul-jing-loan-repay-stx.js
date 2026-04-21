// simul-jing-loan-repay-stx.js
// Stxer mainnet fork simulation: jing-loan repay with STX release branch.
//
// Variant of the happy path that injects a synthetic STX payout into the
// contract before `repay`, proving the `(if (> stx-out u0) ...)` branch
// releases STX to BORROWER. In production this STX would arrive from Jing
// cycle settlement; here we impersonate an STX whale.
//
// Run: npx tsx simulations/simul-jing-loan-repay-stx.js
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
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
const STX_WHALE = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3"; // ~18k STX

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

const FUND_AMOUNT = 22_000_000;
const LOAN_PRINCIPAL = 22_000_000;
const WHALE_SBTC_TOPUP = 20_000_000;           // covers interest shortfall
const SYNTHETIC_STX_PAYOUT = 5_000_000_000;    // 5,000 STX — stands in for Jing payout
const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN REPAY WITH STX PAYOUT STXER SIMULATION ===\n");
  console.log("fund → borrow → swap-deposit → cancel-swap → STX payout → sBTC topup → repay\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })

    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // status u1

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect 22_000_000

    // STX whale → contract (simulates Jing STX payout)
    .withSender(STX_WHALE)
    .addSTXTransfer({ recipient: CONTRACT_ID, amount: SYNTHETIC_STX_PAYOUT })
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`) // expect 5_000_000_000

    // sBTC whale → BORROWER (covers interest shortfall at repay)
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_SBTC_TOPUP),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER),
        noneCV(),
      ],
    })

    // Capture pre-repay STX balance for delta check
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${BORROWER})`)

    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")          // status u2 (REPAID)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)")      // expect none
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`) // expect u0 — all STX released
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect u0 — owed paid out
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${BORROWER})`) // BORROWER STX += 5_000 STX
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    ) // LENDER sBTC += owed (with u100 bps: 22M + 220k = 22,220,000)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
