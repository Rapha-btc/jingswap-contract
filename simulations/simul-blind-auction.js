// simul-blind-auction.js
// Stxer mainnet fork simulation: blind-auction deposit + read-only tests
// Run: npx tsx simulations/simul-blind-auction.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Mainnet addresses ---
// Deployer: will deploy the blind-auction contract
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
// STX depositor: ~18k STX on mainnet
const STX_DEPOSITOR = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
// sBTC depositor: ~40.5 BTC on mainnet
const SBTC_DEPOSITOR = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

async function main() {
  const source = fs.readFileSync("./contracts/blind-auction.clar", "utf8");

  console.log("=== BLIND AUCTION - STXER MAINNET FORK SIMULATION ===\n");
  console.log("Scenario:");
  console.log("1. Deploy blind-auction contract");
  console.log("2. STX depositor deposits 100 STX");
  console.log("3. sBTC depositor deposits 100,000 sats (0.001 BTC)");
  console.log("4. Read cycle state, depositor lists, totals");
  console.log("5. STX depositor deposits 50 more STX (top-up)");
  console.log("6. Read updated state");
  console.log("7. Cancel STX deposit (partial flow test)");
  console.log("");

  const STX_DEPOSIT_1 = 100_000_000; // 100 STX
  const STX_DEPOSIT_2 = 50_000_000; // 50 STX
  const SBTC_DEPOSIT = 100_000; // 0.001 BTC = 100k sats

  const sessionId = await SimulationBuilder.new()
    // ============================================================
    // STEP 1: Deploy blind-auction
    // ============================================================
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ============================================================
    // STEP 2: STX depositor deposits 100 STX
    // ============================================================
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_DEPOSIT_1)],
    })

    // ============================================================
    // STEP 3: sBTC depositor deposits 100k sats
    // ============================================================
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_DEPOSIT)],
    })

    // ============================================================
    // STEP 4: Read cycle state
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u0 '${STX_DEPOSITOR})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u0 '${SBTC_DEPOSITOR})`
    )

    // ============================================================
    // STEP 5: STX depositor top-up (adds 50 more STX)
    // ============================================================
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_DEPOSIT_2)],
    })

    // ============================================================
    // STEP 6: Read updated totals + deposit
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u0 '${STX_DEPOSITOR})`
    )

    // ============================================================
    // STEP 7: Read DEX price + min deposits
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-dex-price)")
    .addEvalCode(CONTRACT_ID, "(get-min-deposits)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
