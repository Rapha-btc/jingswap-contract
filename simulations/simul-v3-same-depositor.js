// simul-v3-same-depositor.js
// Stxer simulation: same address deposits on both sides for v3 (sBTC/USDCx).
// Proves the contract handles the same principal in both depositor lists.
//
// Run: npx tsx simulations/simul-v3-same-depositor.js
import fs from "node:fs";
import {
  ClarityVersion, uintCV, contractPrincipalCV, stringAsciiCV, bufferCV,
  principalCV, noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_NAME = "token-x-token-y-jing-v3";
const CONTRACT_ID = `${DEPLOYER}.${CONTRACT_NAME}`;

const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const USDCX_WHALE = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";

const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_NAME = "sbtc-token";
const USDCX_ADDR = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_NAME = "usdcx";
const USDCX_TOKEN = `${USDCX_ADDR}.${USDCX_NAME}`;
const BTC_USD_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const USDCX_100 = 100_000_000;
const SBTC_100K = 100_000;
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

  console.log("=== V3 SAME DEPOSITOR BOTH SIDES - SBTC/USDCX ===\n");

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

    // Fund sBTC whale with USDCx
    .withSender(USDCX_WHALE)
    .addContractCall({
      contract_id: USDCX_TOKEN, function_name: "transfer",
      function_args: [uintCV(200_000_000), principalCV(USDCX_WHALE), principalCV(SBTC_WHALE), noneCV()],
    })

    // Same depositor deposits USDCx
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_100), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    })
    // Same depositor deposits sBTC
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-x",
      function_args: [uintCV(SBTC_100K), uintCV(SBTC_LIMIT_LOW), sbtcTrait, sbtcAsset],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-token-x-depositors u0)")

    .withSender(SBTC_WHALE)
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "close-deposits", function_args: [] })
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "settle",
      function_args: [sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset],
    })

    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${SBTC_WHALE})`)
    .addEvalCode(CONTRACT_ID, `(get-token-x-deposit u1 '${SBTC_WHALE})`)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
