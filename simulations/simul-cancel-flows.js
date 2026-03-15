// simul-cancel-flows.js
// Stxer simulation: test cancel deposit + cancel-cycle flows
//
// Tests:
// 1. Cancel STX deposit during deposit phase → should succeed
// 2. Cancel sBTC deposit during deposit phase → should succeed
// 3. Close deposits, try cancel during settle phase → should fail
// 4. Settle fails (we won't deposit on one side) → ERR_NOTHING_TO_SETTLE
// 5. Cancel-cycle after threshold → rolls deposits to next cycle
// 6. Cancel in new cycle after rollforward → should succeed
//
// Run: npx tsx simulations/simul-cancel-flows.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

const STX_USER = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_USER = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
// Second STX user for cancel-cycle test
const STX_USER_2 = "SP1AE7DW1ZXBH983N89YY6VA5JKPFJWT89RFBPEAY";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const STX_100 = 100_000_000;
const STX_50 = 50_000_000;
const SBTC_100K = 100_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer.clar",
    "utf8"
  );

  console.log("=== CANCEL FLOWS TEST ===\n");
  console.log("Part A: Cancel deposits during deposit phase");
  console.log("  1. Deposit STX + sBTC");
  console.log("  2. Cancel STX deposit → refund");
  console.log("  3. Cancel sBTC deposit → refund");
  console.log("  4. Cancel again with nothing → should fail");
  console.log("");
  console.log("Part B: Cancel during wrong phase");
  console.log("  5. Re-deposit both sides");
  console.log("  6. Close deposits");
  console.log("  7. Try cancel during settle phase → should fail");
  console.log("");
  console.log("Part C: Cancel-cycle flow");
  console.log("  8. Settle fails if one side too small");
  console.log("  9. Cancel-cycle → rolls deposits to cycle 1");
  console.log("  10. Verify rollover state");
  console.log("  11. Cancel rolled deposit in new cycle → should succeed");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // ============================================================
    // Deploy
    // ============================================================
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ============================================================
    // PART A: Cancel during deposit phase
    // ============================================================

    // Step 2: Deposit 100 STX
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100)],
    })

    // Step 3: Deposit 100k sats sBTC
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // Step 4: Read totals before cancel
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Step 5: Cancel STX deposit → should succeed, return 100 STX
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // Step 6: Cancel sBTC deposit → should succeed, return 100k sats
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // Step 7: Read totals after cancel → should be zero
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // Step 8: Cancel again with no deposit → should fail ERR_NOTHING_TO_WITHDRAW
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // ============================================================
    // PART B: Cancel during wrong phase
    // ============================================================

    // Step 9: Re-deposit both sides
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100)],
    })
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // Also deposit from STX_USER_2 so we can test cancel-cycle later
    .withSender(STX_USER_2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_50)],
    })

    // Step 10: Close deposits
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Step 11: Read phase → should be SETTLE (buffer=0)
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Step 12: Try cancel STX during settle → ERR_NOT_DEPOSIT_PHASE (u1002)
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // Step 13: Try cancel sBTC during settle → ERR_NOT_DEPOSIT_PHASE (u1002)
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // ============================================================
    // PART C: Cancel-cycle flow
    // ============================================================

    // Step 14: Read totals before cancel-cycle
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Step 15: Cancel-cycle (CANCEL_THRESHOLD=0 in stxer variant)
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-cycle",
      function_args: [],
    })

    // Step 16: Verify cycle advanced to 1, deposit phase
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Step 17: Verify rollover — all deposits moved to cycle 1
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u1 '${STX_USER})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u1 '${STX_USER_2})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u1 '${SBTC_USER})`
    )
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")

    // Step 18: Cycle 0 should be empty
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // Step 19: Cancel rolled STX deposit in new cycle → should succeed
    .withSender(STX_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-stx-deposit",
      function_args: [],
    })

    // Step 20: Cancel rolled sBTC deposit in new cycle → should succeed
    .withSender(SBTC_USER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-sbtc-deposit",
      function_args: [],
    })

    // Step 21: Read final state — STX_USER_2 should still be in cycle 1
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
