// simul-blind-premium-zero-limit-edge.js
// Stxer simulation: boundary test where clearing price == limit exactly
//
// STX side: limit = max STX-per-sBTC they'll pay. Roll condition: (> clearing limit)
//   -> If clearing == limit, NOT greater, so should FILL.
//
// sBTC side: limit = min STX-per-sBTC they'll accept. Roll condition: (< clearing limit)
//   -> If clearing == limit, NOT less, so should FILL.
//
// Strategy: first cycle settles to discover the exact clearing price,
// then second cycle uses that exact clearing price as limits.
//
// Run: npx tsx simulations/simul-blind-premium-zero-limit-edge.js
import fs from "node:fs";
import { ClarityVersion, uintCV } from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-premium-zero`;

const STX_DEPOSITOR = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_DEPOSITOR = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const STX_100 = 100_000_000;
const SBTC_100K = 100_000;

// Permissive limits for cycle 0 (discovery cycle)
const LIMIT_STX_PERMISSIVE = 99_999_999_999_999;
const LIMIT_SBTC_PERMISSIVE = 1;

// The exact clearing price will be discovered from cycle 0 settlement.
// With stored mainnet Pyth prices, clearing = oracle * 9980/10000.
// From previous simulations: clearing = 33371404794442
// We'll use this exact value as limits in cycle 1.
//
// If the oracle hasn't changed between simulations, this should be exact.
// STX side: set limit = clearing (max they'll pay = exactly clearing)
// sBTC side: set limit = clearing (min they'll accept = exactly clearing)
// Both should FILL because the roll conditions use strict inequality.
const EXPECTED_CLEARING = 33371404794442;

async function main() {
  const source = fs.readFileSync("./contracts/blind-premium-zero-stxer.clar", "utf8");

  console.log("=== BLIND PREMIUM - LIMIT EDGE: clearing == limit ===\n");
  console.log("Cycle 0: discovery cycle with permissive limits");
  console.log("  -> settle to confirm clearing price\n");
  console.log("Cycle 1: set limits = exact clearing price");
  console.log(`  -> STX limit = ${EXPECTED_CLEARING} (max pay = clearing)`);
  console.log(`  -> sBTC limit = ${EXPECTED_CLEARING} (min accept = clearing)`);
  console.log("  -> Both should FILL (strict inequality: > and < don't trigger at ==)\n");
  console.log("Cycle 2: set limits = clearing - 1 (STX) and clearing + 1 (sBTC)");
  console.log("  -> Both should be ROLLED (off by 1 triggers the inequality)\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium-zero",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ============================================================
    // CYCLE 0: Discovery - confirm clearing price
    // ============================================================
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(LIMIT_STX_PERMISSIVE)],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(LIMIT_SBTC_PERMISSIVE)],
    })
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // Read clearing price from cycle 0
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")

    // ============================================================
    // CYCLE 1: Limit == clearing (should FILL)
    // ============================================================
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(EXPECTED_CLEARING)],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(EXPECTED_CLEARING)],
    })

    // Read limits to confirm they match clearing
    .addEvalCode(CONTRACT_ID, `(get-stx-limit '${STX_DEPOSITOR})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-limit '${SBTC_DEPOSITOR})`)

    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // Check: both should have filled (no limit-roll events)
    .addEvalCode(CONTRACT_ID, "(get-settlement u1)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    // STX depositor should have 0 in cycle 2 (filled, not rolled by limit)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u2 '${STX_DEPOSITOR})`)
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u2)")

    // ============================================================
    // CYCLE 2: Limit off by 1 (should ROLL)
    // STX: limit = clearing - 1 (max pay is 1 below clearing -> rolled)
    // sBTC: limit = clearing + 1 (min accept is 1 above clearing -> rolled)
    // ============================================================
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(EXPECTED_CLEARING - 1)],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(EXPECTED_CLEARING + 1)],
    })

    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // Should fail ERR_NOTHING_TO_SETTLE (u1012) because both sides rolled out
    // OR settle with 0 cleared. Let's see what happens.
    // Actually: after both are rolled, totals drop to the unfilled amounts
    // from cycle 1 (if any). If no unfilled from cycle 1, totals = 0 -> ERR_NOTHING_TO_SETTLE

    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u3)")
    // Rolled depositors should be in cycle 3
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u3 '${STX_DEPOSITOR})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u3 '${SBTC_DEPOSITOR})`)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
