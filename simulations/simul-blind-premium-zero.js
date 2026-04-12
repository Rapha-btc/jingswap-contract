// simul-blind-premium-zero.js
// Stxer mainnet fork simulation: full blind-premium-zero lifecycle
// Uses blind-premium-zero-stxer.clar with zeroed block thresholds + relaxed staleness.
// Tests the premium clearing price (oracle * (1 - 20bps)) and per-depositor limits.
//
// Run: npx tsx simulations/simul-blind-premium-zero.js
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

const CONTRACT_ID = `${DEPLOYER}.blind-premium-zero`;

// Amounts
const STX_100 = 100_000_000; // 100 STX
const STX_50 = 50_000_000; // 50 STX
const SBTC_100K = 100_000; // 0.001 BTC
const SBTC_50K = 50_000; // 0.0005 BTC

// Permissive limits (always fill)
// STX side: max STX-per-sBTC they'll pay (way above any clearing)
const LIMIT_STX = 99_999_999_999_999;
// sBTC side: min STX-per-sBTC they'll accept (way below any clearing)
const LIMIT_SBTC = 1;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-premium-zero-stxer.clar",
    "utf8"
  );

  console.log("=== BLIND PREMIUM - FULL LIFECYCLE STXER SIMULATION ===\n");
  console.log("Scenario:");
  console.log("1.  Deploy blind-premium-zero (zeroed block thresholds)");
  console.log("2.  STX depositor deposits 100 STX (permissive limit)");
  console.log("3.  sBTC depositor deposits 100k sats (permissive limit)");
  console.log("4.  Read cycle state + limits");
  console.log("5.  STX depositor top-up +50 STX");
  console.log("6.  Close deposits");
  console.log("7.  Settle using stored Pyth prices");
  console.log("8.  Read settlement results (clearing = oracle * 0.998)");
  console.log("9.  Verify cycle advanced to 1");
  console.log("10. Read final balances");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // ============================================================
    // STEP 1: Deploy blind-premium-zero
    // ============================================================
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium-zero",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ============================================================
    // STEP 2: STX depositor deposits 100 STX with permissive limit
    // ============================================================
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(LIMIT_STX)],
    })

    // ============================================================
    // STEP 3: sBTC depositor deposits 100k sats with permissive limit
    // ============================================================
    .withSender(SBTC_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(LIMIT_SBTC)],
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
    // Read limits
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-limit '${STX_DEPOSITOR_1})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-limit '${SBTC_DEPOSITOR_1})`
    )

    // ============================================================
    // STEP 5: STX depositor top-up +50 STX (overwrites limit)
    // ============================================================
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_50), uintCV(LIMIT_STX)],
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
    // STEP 8: Read phase (should be SETTLE, no buffer)
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // ============================================================
    // STEP 9: Settle using stored Pyth prices
    // MAX_STALENESS raised in stxer variant to accept stored prices
    // ============================================================
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // ============================================================
    // STEP 10: Read settlement results
    // Price should be oracle * (10000 - 20) / 10000 (20 bps premium)
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
