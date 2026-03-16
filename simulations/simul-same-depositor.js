// simul-same-depositor.js
// Stxer simulation: same address deposits on both STX and sBTC sides, then settle
//
// Run: npx tsx simulations/simul-same-depositor.js
import fs from "node:fs";
import { ClarityVersion, uintCV } from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

// Same address for both sides — has both STX and sBTC on mainnet
const DEPOSITOR = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const STX_100 = 100_000_000;
const SBTC_100K = 100_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer.clar",
    "utf8"
  );

  console.log("=== SAME DEPOSITOR BOTH SIDES ===\n");
  console.log("1 address deposits STX + sBTC, then settle\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Fund depositor with STX
    .withSender("SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3")
    .addSTXTransfer({ recipient: DEPOSITOR, amount: 200_000_000 }) // 200 STX

    // Same address deposits STX
    .withSender(DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100)],
    })

    // Same address deposits sBTC
    .withSender(DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // Read state
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // Close + settle
    .withSender(DEPOSITOR)
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

    // Read results
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u1 '${DEPOSITOR})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u1 '${DEPOSITOR})`
    )

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
