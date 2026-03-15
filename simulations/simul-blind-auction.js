// simul-blind-auction.js
// Stxer mainnet fork simulation: full blind-auction lifecycle
// Uses a modified contract with zeroed block thresholds since stxer is single-block.
//
// Run: npx tsx simulations/simul-blind-auction.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
  boolCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Mainnet addresses ---
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
// STX whale: ~18k STX
const STX_DEPOSITOR_1 = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
// sBTC whale: ~40.5 BTC
const SBTC_DEPOSITOR_1 = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

// Amounts
const STX_100 = 100_000_000; // 100 STX
const STX_50 = 50_000_000; // 50 STX
const SBTC_100K = 100_000; // 0.001 BTC
const SBTC_50K = 50_000; // 0.0005 BTC

async function main() {
  // Read stxer variant with zeroed block thresholds + relaxed staleness
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer.clar",
    "utf8"
  );

  console.log("=== BLIND AUCTION - FULL LIFECYCLE STXER SIMULATION ===\n");
  console.log("Scenario:");
  console.log("1.  Deploy blind-auction (zeroed block thresholds)");
  console.log("2.  STX depositor deposits 100 STX");
  console.log("3.  sBTC depositor deposits 100k sats");
  console.log("4.  Read cycle state");
  console.log("5.  STX depositor top-up +50 STX");
  console.log("6.  Close deposits");
  console.log("7.  Settle using stored Pyth prices");
  console.log("8.  Read settlement results");
  console.log("9.  Verify cycle advanced to 1");
  console.log("10. Read final balances");
  console.log("");

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
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100)],
    })

    // ============================================================
    // STEP 3: sBTC depositor deposits 100k sats
    // ============================================================
    .withSender(SBTC_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // ============================================================
    // STEP 4: Read cycle state after deposits
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u0 '${STX_DEPOSITOR_1})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u0 '${SBTC_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // ============================================================
    // STEP 5: STX depositor top-up +50 STX
    // ============================================================
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_50)],
    })

    // ============================================================
    // STEP 6: Read updated deposit
    // ============================================================
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u0 '${STX_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // ============================================================
    // STEP 7: Close deposits (DEPOSIT_MIN_BLOCKS = 0, so immediate)
    // ============================================================
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // ============================================================
    // STEP 8: Read phase (should be SETTLE since BUFFER_BLOCKS = 0)
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // ============================================================
    // STEP 9: Settle using stored Pyth prices
    // MAX_STALENESS raised to accept stored mainnet prices
    // ============================================================
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // ============================================================
    // STEP 10: Read settlement results
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // ============================================================
    // STEP 11: Read DEX price (sanity check)
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-dex-price)")

    // ============================================================
    // STEP 12: Verify cycle 1 rollover state
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u1 '${SBTC_DEPOSITOR_1})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u1 '${STX_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
