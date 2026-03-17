// simul-blind-auction-usdcx.js
// Stxer mainnet fork simulation: full sBTC/USDCx blind-auction lifecycle
// Uses blind-auction-stxer-usdcx.clar with zeroed block thresholds.
//
// Run: npx tsx simulations/simul-blind-auction-usdcx.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Mainnet addresses ---
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
// USDCx whale: ~28.6k USDCx
const USDCX_DEPOSITOR_1 = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
// sBTC whale: ~40.5 BTC
const SBTC_DEPOSITOR_1 = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const CONTRACT_ID = `${DEPLOYER}.blind-auction-usdcx`;

// Amounts (USDCx has 6 decimals)
const USDCX_100 = 100_000_000; // 100 USDCx
const USDCX_50 = 50_000_000;   // 50 USDCx
const SBTC_100K = 100_000;      // 0.001 BTC

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer-usdcx.clar",
    "utf8"
  );

  console.log("=== SBTC/USDCX BLIND AUCTION - FULL LIFECYCLE STXER SIMULATION ===\n");
  console.log("Scenario:");
  console.log("1.  Deploy blind-auction-usdcx (zeroed block thresholds)");
  console.log("2.  USDCx depositor deposits 100 USDCx");
  console.log("3.  sBTC depositor deposits 100k sats");
  console.log("4.  Read cycle state");
  console.log("5.  USDCx depositor top-up +50 USDCx");
  console.log("6.  Close deposits");
  console.log("7.  Settle using stored Pyth prices");
  console.log("8.  Read settlement results");
  console.log("9.  Verify cycle advanced to 1");
  console.log("10. Read rollover state");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // STEP 1: Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction-usdcx",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // STEP 2: USDCx depositor deposits 100 USDCx
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_100)],
    })

    // STEP 3: sBTC depositor deposits 100k sats
    .withSender(SBTC_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // STEP 4: Read cycle state after deposits
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-usdcx-deposit u0 '${USDCX_DEPOSITOR_1})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u0 '${SBTC_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // STEP 5: USDCx depositor top-up +50 USDCx
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_50)],
    })

    // STEP 6: Read updated deposit
    .addEvalCode(
      CONTRACT_ID,
      `(get-usdcx-deposit u0 '${USDCX_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // STEP 7: Close deposits
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // STEP 8: Read phase (should be SETTLE since BUFFER_BLOCKS = 0)
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // STEP 9: Settle using stored Pyth prices
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // STEP 10: Read settlement results
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // STEP 11: Verify cycle 1 rollover state
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u1 '${SBTC_DEPOSITOR_1})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-usdcx-deposit u1 '${USDCX_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
