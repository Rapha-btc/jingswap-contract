// simul-blind-premium-cancel-flows.js
// Stxer simulation: test cancel deposit + cancel-cycle flows for blind-premium
//
// Tests:
// 1. Cancel STX deposit during deposit phase -> should succeed
// 2. Cancel sBTC deposit during deposit phase -> should succeed
// 3. Close deposits, try cancel during settle phase -> should fail
// 4. Cancel-cycle after threshold -> rolls deposits to next cycle
// 5. Cancel rolled deposit in new cycle -> should succeed
//
// Run: npx tsx simulations/simul-blind-premium-cancel-flows.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-premium`;

const STX_USER = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_USER = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const STX_USER_2 = "SP1AE7DW1ZXBH983N89YY6VA5JKPFJWT89RFBPEAY";

const STX_100 = 100_000_000;
const STX_50 = 50_000_000;
const SBTC_100K = 100_000;

// Permissive limits
const LIMIT_STX = 99_999_999_999_999;
const LIMIT_SBTC = 1;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-premium-stxer.clar",
    "utf8"
  );

  console.log("=== BLIND PREMIUM - CANCEL FLOWS TEST ===\n");
  console.log("Part A: Cancel deposits during deposit phase");
  console.log("  1. Deposit STX + sBTC");
  console.log("  2. Cancel STX deposit -> refund");
  console.log("  3. Cancel sBTC deposit -> refund");
  console.log("  4. Cancel again with nothing -> should fail");
  console.log("");
  console.log("Part B: Cancel during wrong phase");
  console.log("  5. Re-deposit both sides");
  console.log("  6. Close deposits");
  console.log("  7. Try cancel during settle phase -> should fail");
  console.log("");
  console.log("Part C: Cancel-cycle flow");
  console.log("  8. Cancel-cycle -> rolls deposits to cycle 1");
  console.log("  9. Verify rollover state + limits persist");
  console.log("  10. Cancel rolled deposit in new cycle -> should succeed");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ============================================================
    // PART A: Cancel during deposit phase
    // ============================================================

    // Deposit 100 STX
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(LIMIT_STX)],
    })

    // Deposit 100k sats sBTC
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(LIMIT_SBTC)],
    })

    // Read totals before cancel
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Cancel STX deposit -> should succeed
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // Cancel sBTC deposit -> should succeed
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // Read totals after cancel -> should be zero
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // Verify limits cleared after cancel
    .addEvalCode(CONTRACT_ID, `(get-stx-limit '${STX_USER})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-limit '${SBTC_USER})`)

    // Cancel again with no deposit -> should fail ERR_NOTHING_TO_WITHDRAW
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // ============================================================
    // PART B: Cancel during wrong phase
    // ============================================================

    // Re-deposit both sides
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(LIMIT_STX)],
    })
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(LIMIT_SBTC)],
    })

    // Fund STX_USER_2 before depositing
    .withSender(STX_USER)
    .addSTXTransfer({ recipient: STX_USER_2, amount: STX_100 })

    // Also deposit from STX_USER_2
    .withSender(STX_USER_2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_50), uintCV(LIMIT_STX)],
    })

    // Close deposits
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Read phase -> should be SETTLE (no buffer)
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Try cancel STX during settle -> ERR_NOT_DEPOSIT_PHASE (u1002)
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // Try cancel sBTC during settle -> ERR_NOT_DEPOSIT_PHASE (u1002)
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // ============================================================
    // PART C: Cancel-cycle flow
    // ============================================================

    // Read totals before cancel-cycle
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Cancel-cycle (CANCEL_THRESHOLD=0 in stxer variant)
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-cycle",
      function_args: [],
    })

    // Verify cycle advanced to 1, deposit phase
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Verify rollover -- all deposits moved to cycle 1
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_USER})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_USER_2})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_USER})`)
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")

    // Verify limits persist across rollover
    .addEvalCode(CONTRACT_ID, `(get-stx-limit '${STX_USER})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-limit '${SBTC_USER})`)

    // Cycle 0 should be empty
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Cancel rolled STX deposit in new cycle -> should succeed
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // Cancel rolled sBTC deposit in new cycle -> should succeed
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // Read final state -- STX_USER_2 should still be in cycle 1
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
