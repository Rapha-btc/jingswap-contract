// simul-small-share-filter-usdcx.js
// Stxer mainnet fork simulation: small-share filter for sBTC/USDCx pair
// Tests that multiple depositors below 0.2% get rolled, then settle in cycle 1.
//
// Run: npx tsx simulations/simul-small-share-filter-usdcx.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  standardPrincipalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Mainnet addresses ---
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const USDCX_WHALE = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
// 3 small fish — known mainnet addresses, funded from whale
const SMALL_1 = DEPLOYER;
const SMALL_2 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const SMALL_3 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";

const CONTRACT_ID = `${DEPLOYER}.blind-auction-usdcx`;
const USDCX_TOKEN = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";

// Whale: 1000 USDCx. Each small fish: 1 USDCx (~0.1% each)
const USDCX_WHALE_AMOUNT = 1000_000_000; // 1000 USDCx
const USDCX_SMALL_AMOUNT = 1_000_000;    // 1 USDCx
const SBTC_AMOUNT = 100_000;             // 0.001 BTC (cycle 0)
const SBTC_BIG_AMOUNT = 2_000_000;       // 0.02 BTC (~$1760, clears most USDCx in cycle 1)
const SBTC_SMALL_AMOUNT = 100_000;       // 0.001 BTC (cycle 2)

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer-usdcx.clar",
    "utf8"
  );

  console.log("=== SMALL-SHARE FILTER SIMULATION (sBTC/USDCx, 3 small fish) ===\n");
  console.log("Cycle 0:");
  console.log("  1. Deploy + fund 3 small fish with USDCx");
  console.log("  2. USDCx whale deposits 1000 USDCx");
  console.log("  3. 3 small fish deposit 1 USDCx each");
  console.log("  4. sBTC whale deposits 100k sats");
  console.log("  5. Close deposits → all 3 rolled to cycle 1");
  console.log("  6. Settle cycle 0");
  console.log("");
  console.log("Cycle 1: clear most whale USDCx");
  console.log("  7. sBTC whale deposits 0.02 BTC → clears most whale USDCx");
  console.log("  8. Close + settle cycle 1 → fish rolled again");
  console.log("");
  console.log("Cycle 2: fish finally settles");
  console.log("  9. sBTC whale deposits small amount");
  console.log("  10. Close cycle 2 → fish >0.2% of remaining, stays");
  console.log("  11. Settle cycle 2 → fish receives sBTC");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // STEP 1: Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction-usdcx",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Fund small fish 1 (deployer) with 5 USDCx
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: USDCX_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(5_000_000),
        standardPrincipalCV(USDCX_WHALE),
        standardPrincipalCV(SMALL_1),
        noneCV(),
      ],
    })

    // Fund small fish 2 with 5 USDCx
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: USDCX_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(5_000_000),
        standardPrincipalCV(USDCX_WHALE),
        standardPrincipalCV(SMALL_2),
        noneCV(),
      ],
    })

    // Fund small fish 3 with 5 USDCx
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: USDCX_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(5_000_000),
        standardPrincipalCV(USDCX_WHALE),
        standardPrincipalCV(SMALL_3),
        noneCV(),
      ],
    })

    // STEP 2: USDCx whale deposits 1000 USDCx
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_WHALE_AMOUNT)],
    })

    // STEP 3a-c: 3 small fish deposit 1 USDCx each
    .withSender(SMALL_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_SMALL_AMOUNT)],
    })
    .withSender(SMALL_2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_SMALL_AMOUNT)],
    })
    .withSender(SMALL_3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_SMALL_AMOUNT)],
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
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u0)")

    // STEP 5: Close deposits → 3 small fish rolled
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Verify
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u1)")
    .addEvalCode(CONTRACT_ID, `(get-usdcx-deposit u1 '${SMALL_1})`)
    .addEvalCode(CONTRACT_ID, `(get-usdcx-deposit u1 '${SMALL_2})`)
    .addEvalCode(CONTRACT_ID, `(get-usdcx-deposit u1 '${SMALL_3})`)

    // STEP 6: Settle cycle 0
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u1)")

    // ============================================================
    // CYCLE 1: Big sBTC deposit to clear most whale USDCx
    // ============================================================

    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_BIG_AMOUNT)],
    })

    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u2)")

    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-settlement u1)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u2)")

    // ============================================================
    // CYCLE 2: Fish finally big enough to settle
    // ============================================================

    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_SMALL_AMOUNT)],
    })

    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u2)")

    .withSender(USDCX_WHALE)
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
