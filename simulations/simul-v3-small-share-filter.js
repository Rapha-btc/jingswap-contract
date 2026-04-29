// simul-v3-small-share-filter.js
// Stxer simulation: small-share filter for v3 (sBTC/USDCx).
// 3 small fish below 0.2% get rolled across cycles 0 and 1, then settle in cycle 2.
//
// Run: npx tsx simulations/simul-v3-small-share-filter.js
import fs from "node:fs";
import {
  ClarityVersion, uintCV, contractPrincipalCV, stringAsciiCV, bufferCV,
  standardPrincipalCV, noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_NAME = "token-x-token-y-jing-v3";
const CONTRACT_ID = `${DEPLOYER}.${CONTRACT_NAME}`;

const USDCX_WHALE = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const SMALL_1 = DEPLOYER;
const SMALL_2 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const SMALL_3 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";

const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_NAME = "sbtc-token";
const USDCX_ADDR = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_NAME = "usdcx";
const USDCX_TOKEN = `${USDCX_ADDR}.${USDCX_NAME}`;
const BTC_USD_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// Whale deposits 600 USDCx (fits current ~832 USDCx balance after 15 USDCx of funding).
// Each fish at 1 USDCx = 1/(600+3) = 0.166% — under the 0.2% small-share threshold.
const USDCX_WHALE_AMOUNT = 600_000_000;
const USDCX_SMALL_AMOUNT = 1_000_000;
const SBTC_AMOUNT = 100_000;
const SBTC_BIG_AMOUNT = 2_000_000;
const SBTC_SMALL_AMOUNT = 100_000;

const MIN_SBTC = 1000;
const MIN_USDCX = 1_000_000;
const USDCX_LIMIT_HIGH = 1_000_000_000_000_000;
const SBTC_LIMIT_LOW = 1;

const sbtcTrait = contractPrincipalCV(SBTC_ADDR, SBTC_NAME);
const usdcxTrait = contractPrincipalCV(USDCX_ADDR, USDCX_NAME);
const sbtcAsset = stringAsciiCV("sbtc-token");
const usdcxAsset = stringAsciiCV("usdcx-token");
const feedBuf = bufferCV(Buffer.from(BTC_USD_FEED_HEX, "hex"));

async function main() {
  const source = fs.readFileSync("./contracts/v3/token-x-token-y-jing-v3-stxer.clar", "utf8");
  const jingCoreSource = fs.readFileSync("./contracts/jing-core.clar", "utf8");

  console.log("=== V3 SMALL-SHARE FILTER - SBTC/USDCX ===\n");
  console.log("3 small fish (1 USDCx each, ~0.1%) get rolled in cycles 0 and 1,");
  console.log("then finally settle in cycle 2 once they're > 0.2% of remaining pool.\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({ contract_name: "jing-core", source_code: jingCoreSource, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: CONTRACT_NAME, source_code: source, clarity_version: ClarityVersion.Clarity4 })
    .addContractCall({
      contract_id: `${DEPLOYER}.jing-core`, function_name: "approve-market",
      function_args: [contractPrincipalCV(DEPLOYER, CONTRACT_NAME)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "initialize",
      function_args: [sbtcTrait, usdcxTrait, uintCV(MIN_SBTC), uintCV(MIN_USDCX), feedBuf],
    })

    // Fund 3 small fish with 5 USDCx each
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: USDCX_TOKEN, function_name: "transfer",
      function_args: [uintCV(5_000_000), standardPrincipalCV(USDCX_WHALE), standardPrincipalCV(SMALL_1), noneCV()],
    })
    .addContractCall({
      contract_id: USDCX_TOKEN, function_name: "transfer",
      function_args: [uintCV(5_000_000), standardPrincipalCV(USDCX_WHALE), standardPrincipalCV(SMALL_2), noneCV()],
    })
    .addContractCall({
      contract_id: USDCX_TOKEN, function_name: "transfer",
      function_args: [uintCV(5_000_000), standardPrincipalCV(USDCX_WHALE), standardPrincipalCV(SMALL_3), noneCV()],
    })

    // === Cycle 0 ===
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_WHALE_AMOUNT), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    })
    .withSender(SMALL_1)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_SMALL_AMOUNT), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    })
    .withSender(SMALL_2)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_SMALL_AMOUNT), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    })
    .withSender(SMALL_3)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_SMALL_AMOUNT), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    })
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-x",
      function_args: [uintCV(SBTC_AMOUNT), uintCV(SBTC_LIMIT_LOW), sbtcTrait, sbtcAsset],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u0)")

    .withSender(USDCX_WHALE)
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "close-deposits", function_args: [] })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u1)")
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${SMALL_1})`)
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${SMALL_2})`)
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${SMALL_3})`)

    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "settle",
      function_args: [sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset],
    })
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u1)")

    // === Cycle 1: Big sBTC clears most whale USDCx ===
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-x",
      function_args: [uintCV(SBTC_BIG_AMOUNT), uintCV(SBTC_LIMIT_LOW), sbtcTrait, sbtcAsset],
    })
    .withSender(USDCX_WHALE)
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "close-deposits", function_args: [] })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u2)")

    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "settle",
      function_args: [sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset],
    })
    .addEvalCode(CONTRACT_ID, "(get-settlement u1)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u2)")

    // === Cycle 2: Fish finally settles ===
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-x",
      function_args: [uintCV(SBTC_SMALL_AMOUNT), uintCV(SBTC_LIMIT_LOW), sbtcTrait, sbtcAsset],
    })
    .withSender(USDCX_WHALE)
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "close-deposits", function_args: [] })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u2)")

    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "settle",
      function_args: [sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset],
    })
    .addEvalCode(CONTRACT_ID, "(get-settlement u2)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
