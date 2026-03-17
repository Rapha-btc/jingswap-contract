// simul-same-depositor-usdcx.js
// Stxer simulation: same address deposits on both USDCx and sBTC sides
// Proves the contract handles the same principal in both depositor lists.
//
// Run: npx tsx simulations/simul-same-depositor-usdcx.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-auction-usdcx`;

// This address needs both USDCx AND sBTC.
// SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51 has USDCx but no sBTC.
// We'll use the sBTC whale and fund them USDCx from the USDCx whale.
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const USDCX_WHALE = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";

const USDCX_TOKEN = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";

const USDCX_100 = 100_000_000; // 100 USDCx
const SBTC_100K = 100_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer-usdcx.clar",
    "utf8"
  );

  console.log("=== SBTC/USDCX SAME DEPOSITOR BOTH SIDES SIMULATION ===\n");
  console.log("1. Deploy");
  console.log("2. Fund sBTC whale with 200 USDCx from USDCx whale");
  console.log("3. sBTC whale deposits 100 USDCx");
  console.log("4. sBTC whale deposits 100k sats sBTC");
  console.log("5. Close + settle");
  console.log("6. Verify distributions to same address");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction-usdcx",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Fund sBTC whale with USDCx
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: USDCX_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(200_000_000), // 200 USDCx
        principalCV(USDCX_WHALE),
        principalCV(SBTC_WHALE),
        noneCV(),
      ],
    })

    // Same depositor deposits USDCx
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_100)],
    })

    // Same depositor deposits sBTC
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // Read state
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // Close + settle
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })
    .withSender(SBTC_WHALE)
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
      `(get-usdcx-deposit u1 '${SBTC_WHALE})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u1 '${SBTC_WHALE})`
    )

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
