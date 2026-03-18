// simul-dust-filter.js
// Stxer simulation: dust filter at close-deposits + dust refund at distribute
// Tests Rule 1 (filter depositors whose pro-rata share rounds to 0 at close)
// and Rule 2 (refund unfilled amounts below minimum instead of rolling at distribute)
//
// Run: npx tsx simulations/simul-dust-filter.js
import fs from "node:fs";
import { ClarityVersion, uintCV } from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const STX_WHALE = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3"; // ~18k STX
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2"; // ~40.5 BTC
// Small depositor with some STX
const DUST_DEPOSITOR = "SP3EKD9VTV30VBC7SVMC34K2MN7PE14KQDBPHF8VH";

const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

async function main() {
  const source = fs.readFileSync("./contracts/blind-auction-stxer.clar", "utf8");

  console.log("=== DUST FILTER SIMULATION ===\n");
  console.log("Scenario A: Dust depositor filtered at close-deposits (Rule 1)");
  console.log("  - STX whale deposits 10,000 STX");
  console.log("  - Dust depositor deposits 1 STX (min)");
  console.log("  - sBTC depositor deposits 1,000 sats (tiny — makes dust depositor's share round to 0)");
  console.log("  - Close deposits → dust depositor should be refunded\n");
  console.log("Scenario B: Dust unfilled refunded at distribute (Rule 2)");
  console.log("  - After settlement, unfilled STX below 1 STX should be refunded, not rolled\n");

  const sessionId = await SimulationBuilder.new()
    // Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Fund dust depositor with 5 STX from deployer
    .withSender(DEPLOYER)
    .addSTXTransfer({ recipient: DUST_DEPOSITOR, amount: 5_000_000 })

    // === SCENARIO A: Dust filter at close ===

    // STX whale deposits 10,000 STX
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(10_000_000_000)], // 10k STX
    })

    // Dust depositor deposits 1 STX (minimum)
    .withSender(DUST_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(1_000_000)], // 1 STX
    })

    // sBTC whale deposits only 1,000 sats
    // This makes the sBTC pool tiny relative to STX pool
    // dust depositor's share: (1M * 1000 * 9990) / (10001M * 10000) ≈ 0 — gets filtered
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(1_000)], // 1k sats
    })

    // Read state before close
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")

    // Close deposits — should trigger dust filter, refunding dust depositor
    .withSender(DEPLOYER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Read state after close — dust depositor should be gone
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u0 '${DUST_DEPOSITOR})`)

    // Settle
    .withSender(DEPLOYER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // Read settlement
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")

    // === SCENARIO B: Dust unfilled refund at distribute ===
    // In cycle 1, the whale's unfilled STX should be checked against min
    // If unfilled < 1 STX, it gets refunded instead of rolled

    // Check cycle 1 state (rollovers from cycle 0)
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_WHALE})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${DUST_DEPOSITOR})`)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
