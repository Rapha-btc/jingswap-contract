// simul-cancel-flows-usdcx.js
// Stxer simulation: cancel flows for sBTC/USDCx blind auction
// Tests cancel-deposit, cancel during settle (should fail), and cancel-cycle rollforward.
//
// Run: npx tsx simulations/simul-cancel-flows-usdcx.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const USDCX_DEPOSITOR = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const SBTC_DEPOSITOR = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const CONTRACT_ID = `${DEPLOYER}.blind-auction-usdcx`;

const USDCX_100 = 100_000_000; // 100 USDCx
const SBTC_100K = 100_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer-usdcx.clar",
    "utf8"
  );

  console.log("=== SBTC/USDCX CANCEL FLOWS SIMULATION ===\n");

  const sessionId = await SimulationBuilder.new()
    // Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction-usdcx",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // === Part A: Cancel during deposit phase ===

    // Deposit USDCx
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_100)],
    })

    // Deposit sBTC
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // Read totals
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Cancel USDCx deposit
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-usdcx-deposit",
      function_args: [],
    })

    // Cancel sBTC deposit
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // Read totals after cancel
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // Cancel again (nothing) — should fail
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-usdcx-deposit",
      function_args: [],
    })

    // === Part B: Cancel during settle phase (should fail) ===

    // Re-deposit
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_100)],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // Close deposits
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Read phase
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Cancel during settle — should fail
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-usdcx-deposit",
      function_args: [],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // === Part C: Cancel-cycle + rollforward ===

    // Read totals before cancel-cycle
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Cancel cycle
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-cycle",
      function_args: [],
    })

    // Read new cycle state
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-usdcx-deposit u1 '${USDCX_DEPOSITOR})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u1 '${SBTC_DEPOSITOR})`
    )
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")

    // Cycle 0 should be wiped
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Cancel rolled deposits in new cycle
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-usdcx-deposit",
      function_args: [],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // Verify empty
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
