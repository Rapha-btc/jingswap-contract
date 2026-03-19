// simul-small-share-filter.js
// Stxer mainnet fork simulation: small-share filter at close-deposits
// Tests that multiple depositors below 0.2% of their side's total get rolled to next cycle,
// then settle successfully in the following cycle.
//
// Run: npx tsx simulations/simul-small-share-filter.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Mainnet addresses ---
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const STX_WHALE = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
// 3 small fish — known mainnet addresses with STX
const SMALL_1 = DEPLOYER;
const SMALL_2 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const SMALL_3 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";

const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

// Whale: 1000 STX. Each small fish: 1 STX (~0.1% each, all below 0.2%)
const STX_WHALE_AMOUNT = 1000_000_000;
const STX_SMALL_AMOUNT = 1_000_000;       // 1 STX
const SBTC_AMOUNT = 100_000;              // 0.001 BTC (cycle 0)
const SBTC_BIG_AMOUNT = 300_000_000;      // 3 BTC (cycle 1 — clears most STX)
const SBTC_SMALL_AMOUNT = 100_000;        // 0.001 BTC (cycle 2)

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer.clar",
    "utf8"
  );

  console.log("=== SMALL-SHARE FILTER SIMULATION (3 small fish) ===\n");
  console.log("Cycle 0:");
  console.log("  1. Deploy");
  console.log("  2. STX whale deposits 1000 STX");
  console.log("  3. 3 small fish deposit 1 STX each (~0.1% each)");
  console.log("  4. sBTC whale deposits 100k sats");
  console.log("  5. Close deposits → all 3 small fish rolled to cycle 1");
  console.log("  6. Settle cycle 0 (whale only)");
  console.log("");
  console.log("Cycle 1: clear most of whale's STX");
  console.log("  7. sBTC whale deposits 3 BTC → clears most whale STX");
  console.log("  8. Close + settle cycle 1 → fish rolled again (still tiny vs whale)");
  console.log("");
  console.log("Cycle 2: fish finally settles");
  console.log("  9. sBTC whale deposits small amount");
  console.log("  10. Close cycle 2 → fish now >0.2% of remaining STX, stays!");
  console.log("  11. Settle cycle 2 → fish receives sBTC");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // STEP 1: Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // STEP 2: STX whale deposits 1000 STX
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_WHALE_AMOUNT)],
    })

    // STEP 3a: Small fish 1 deposits 1 STX
    .withSender(SMALL_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_SMALL_AMOUNT)],
    })

    // STEP 3b: Small fish 2 deposits 1 STX
    .withSender(SMALL_2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_SMALL_AMOUNT)],
    })

    // STEP 3c: Small fish 3 deposits 1 STX
    .withSender(SMALL_3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_SMALL_AMOUNT)],
    })

    // STEP 4: sBTC whale deposits 100k sats
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_AMOUNT)],
    })

    // Read state before close
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")

    // STEP 5: Close deposits → 3 small fish rolled
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Verify: cycle 0 has only whale, cycle 1 has 3 small fish
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${SMALL_1})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${SMALL_2})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${SMALL_3})`)

    // STEP 6: Settle cycle 0
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")

    // ============================================================
    // CYCLE 1: Big sBTC deposit to clear most whale STX
    // ============================================================

    // STEP 7: sBTC whale deposits 3 BTC into cycle 1
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_BIG_AMOUNT)],
    })

    // STEP 8: Close cycle 1
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u2)")

    // STEP 9: Settle cycle 1
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-settlement u1)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u2)")

    // ============================================================
    // CYCLE 2: Fish finally big enough to settle
    // ============================================================

    // STEP 10: Small sBTC deposit
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_SMALL_AMOUNT)],
    })

    // STEP 11: Close cycle 2 — fish should stay (>0.2% of small remainder)
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u2)")

    // STEP 12: Settle cycle 2 — fish gets sBTC!
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-settlement u2)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
