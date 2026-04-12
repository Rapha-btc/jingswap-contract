// simul-blind-premium-zero-dust-filter.js
// Stxer simulation: dust filter at close-deposits
// Tests that depositors whose pro-rata share rounds to 0 get rolled at close.
// Ported from simul-dust-filter.js with limit-price args added.
//
// Run: npx tsx simulations/simul-blind-premium-zero-dust-filter.js
import fs from "node:fs";
import { ClarityVersion, uintCV } from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const STX_WHALE = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const DUST_DEPOSITOR = "SP3EKD9VTV30VBC7SVMC34K2MN7PE14KQDBPHF8VH";

const CONTRACT_ID = `${DEPLOYER}.blind-premium-zero`;

const LIMIT_STX = 99_999_999_999_999;
const LIMIT_SBTC = 1;

async function main() {
  const source = fs.readFileSync("./contracts/blind-premium-zero-stxer.clar", "utf8");

  console.log("=== BLIND PREMIUM - DUST FILTER SIMULATION ===\n");
  console.log("Scenario: Dust depositor filtered at close-deposits");
  console.log("  - STX whale deposits 10,000 STX");
  console.log("  - Dust depositor deposits 1 STX (min)");
  console.log("  - sBTC depositor deposits 1,000 sats");
  console.log("  - Close deposits -> dust depositor should be rolled to next cycle");
  console.log("  - Settle -> verify only whale participates\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium-zero",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Fund dust depositor
    .withSender(DEPLOYER)
    .addSTXTransfer({ recipient: DUST_DEPOSITOR, amount: 5_000_000 })

    // STX whale deposits 10,000 STX
    .withSender(STX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(10_000_000_000), uintCV(LIMIT_STX)],
    })

    // Dust depositor deposits 1 STX
    .withSender(DUST_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(1_000_000), uintCV(LIMIT_STX)],
    })

    // sBTC whale deposits 1,000 sats
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(1_000), uintCV(LIMIT_SBTC)],
    })

    // Read state before close
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")

    // Close deposits — should roll dust depositor
    .withSender(DEPLOYER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Read state after close — dust depositor should be gone from cycle 0
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u0 '${DUST_DEPOSITOR})`)

    // Verify dust depositor rolled to cycle 1
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${DUST_DEPOSITOR})`)
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")

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

    // Verify cycle 1 state
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${DUST_DEPOSITOR})`)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
