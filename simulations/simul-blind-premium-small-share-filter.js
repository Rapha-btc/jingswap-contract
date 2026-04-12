// simul-blind-premium-small-share-filter.js
// Stxer simulation: small-share filter at close-deposits (MIN_SHARE_BPS = 0.20%)
// Tests that depositors below 0.20% of their side total get rolled to next cycle.
// Multi-cycle: fish get rolled until whale's STX is mostly cleared, then they settle.
// Ported from simul-small-share-filter.js with limit-price args added.
//
// Run: npx tsx simulations/simul-blind-premium-small-share-filter.js
import fs from "node:fs";
import { ClarityVersion, uintCV } from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const STX_WHALE = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const SMALL_1 = DEPLOYER;
const SMALL_2 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const SMALL_3 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";

const CONTRACT_ID = `${DEPLOYER}.blind-premium`;

const STX_WHALE_AMOUNT = 1000_000_000;   // 1000 STX
const STX_SMALL_AMOUNT = 1_000_000;       // 1 STX (~0.1%, below 0.2%)
const SBTC_AMOUNT = 100_000;              // 0.001 BTC (cycle 0)
const SBTC_BIG_AMOUNT = 300_000_000;      // 3 BTC (cycle 1 — clears most STX)
const SBTC_SMALL_AMOUNT = 100_000;        // 0.001 BTC (cycle 2)

const LIMIT_STX = 99_999_999_999_999;
const LIMIT_SBTC = 1;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-premium-stxer.clar",
    "utf8"
  );

  console.log("=== BLIND PREMIUM - SMALL-SHARE FILTER (3 small fish) ===\n");
  console.log("Cycle 0:");
  console.log("  1. STX whale deposits 1000 STX");
  console.log("  2. 3 small fish deposit 1 STX each (~0.1% each, below 0.2%)");
  console.log("  3. sBTC whale deposits 100k sats");
  console.log("  4. Close deposits -> all 3 small fish rolled to cycle 1");
  console.log("  5. Settle cycle 0 (whale only)");
  console.log("");
  console.log("Cycle 1: clear most whale STX");
  console.log("  6. sBTC whale deposits 3 BTC -> clears most whale STX");
  console.log("  7. Close + settle cycle 1 -> fish rolled again");
  console.log("");
  console.log("Cycle 2: fish finally settles");
  console.log("  8. sBTC whale deposits small amount");
  console.log("  9. Close cycle 2 -> fish now >0.2%, stays!");
  console.log("  10. Settle cycle 2 -> fish receives sBTC");
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
    // CYCLE 0
    // ============================================================

    // STX whale deposits 1000 STX
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_WHALE_AMOUNT), uintCV(LIMIT_STX)],
    })

    // 3 small fish deposit 1 STX each
    .withSender(SMALL_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_SMALL_AMOUNT), uintCV(LIMIT_STX)],
    })
    .withSender(SMALL_2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_SMALL_AMOUNT), uintCV(LIMIT_STX)],
    })
    .withSender(SMALL_3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_SMALL_AMOUNT), uintCV(LIMIT_STX)],
    })

    // sBTC whale deposits 100k sats
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_AMOUNT), uintCV(LIMIT_SBTC)],
    })

    // Read state before close
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")

    // Close deposits -> 3 small fish rolled
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

    // Settle cycle 0
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
    // CYCLE 1: Big sBTC to clear most whale STX
    // ============================================================

    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_BIG_AMOUNT), uintCV(LIMIT_SBTC)],
    })

    // Close cycle 1
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

    // Settle cycle 1
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
    // CYCLE 2: Fish finally big enough
    // ============================================================

    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_SMALL_AMOUNT), uintCV(LIMIT_SBTC)],
    })

    // Close cycle 2 -> fish should stay
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u2)")

    // Settle cycle 2 -> fish gets sBTC!
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
