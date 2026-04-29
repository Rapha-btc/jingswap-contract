// simul-v3-swap.js
// Stxer simulation: atomic taker swap on v3 (sBTC/USDCx).
// Scenario:
//   - USDCx depositor pre-stages 100 USDCx of liquidity in cycle 0
//   - sBTC depositor calls swap-token-x atomically: deposit + close + settle-with-refresh
//   - Verifies sBTC depositor walks away with USDCx in a single tx
//
// Run: npx tsx simulations/simul-v3-swap.js
import fs from "node:fs";
import {
  ClarityVersion, uintCV, contractPrincipalCV, stringAsciiCV, bufferCV, trueCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_NAME = "token-x-token-y-jing-v3";
const CONTRACT_ID = `${DEPLOYER}.${CONTRACT_NAME}`;

const USDCX_DEPOSITOR = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const SBTC_DEPOSITOR = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v4`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v3`;
const WORMHOLE_CORE = `${PYTH_DEPLOYER}.wormhole-core-v4`;

const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_NAME = "sbtc-token";
const USDCX_ADDR = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_NAME = "usdcx";
const BTC_USD_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

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
const feedBuf = bufferCV(Buffer.from(BTC_USD_FEED, "hex"));

async function fetchPythVAA(timestamp) {
  const url = `https://hermes.pyth.network/v2/updates/price/${timestamp}?ids[]=${BTC_USD_FEED}`;
  console.log(`Fetching Pyth VAA at timestamp ${timestamp}...`);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json();
  if (!data.binary?.data?.[0]) throw new Error(`No price data at ${timestamp}`);
  console.log(`Got VAA (${data.binary.data[0].length} hex chars)`);
  for (const p of data.parsed) {
    console.log(`  ${p.id.slice(0, 8)}... = $${(Number(p.price.price) / 1e8).toFixed(4)}`);
  }
  return data.binary.data[0];
}

async function main() {
  const source = fs.readFileSync("./contracts/v3/token-x-token-y-jing-v3-stxer.clar", "utf8");
  const jingCoreSource = fs.readFileSync("./contracts/jing-core.clar", "utf8");

  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  console.log("\n=== V3 ATOMIC SWAP - SBTC TAKES USDCx LIQUIDITY ===\n");
  console.log("1. USDCx depositor pre-stages 100 USDCx");
  console.log("2. sBTC depositor calls swap-token-x:");
  console.log("   - deposit 100k sats");
  console.log("   - close-deposits");
  console.log("   - settle-with-refresh (fresh Pyth VAA)");
  console.log("   All in one atomic tx.");
  console.log("3. Verify caller (sBTC depositor) received USDCx.\n");

  const [pythStoreAddr, pythStoreName] = PYTH_STORAGE.split(".");
  const [pythDecAddr, pythDecName] = PYTH_DECODER.split(".");
  const [wormAddr, wormName] = WORMHOLE_CORE.split(".");

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

    // STEP 4: USDCx pre-staged liquidity (the "book" the swapper consumes)
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_100), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    })

    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u0)")

    // STEP 5: ATOMIC SWAP — sBTC depositor takes the USDCx liquidity
    // deposit-x = true means caller deposits token-x (sBTC), sells for token-y (USDCx).
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "swap",
      function_args: [
        uintCV(SBTC_100K),
        uintCV(SBTC_LIMIT_LOW),
        vaaBuffer,
        contractPrincipalCV(pythStoreAddr, pythStoreName),
        contractPrincipalCV(pythDecAddr, pythDecName),
        contractPrincipalCV(wormAddr, wormName),
        sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset,
        trueCV(),                    // deposit-x = true (last param)
      ],
    })

    // STEP 6: Verify settlement happened in the same tx
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    // sBTC depositor's view: they should have 0 sBTC left in cycle 1 (fully cleared)
    // and any USDCx unfilled rolled
    .addEvalCode(CONTRACT_ID, `(get-token-x-deposit u1 '${SBTC_DEPOSITOR})`)
    // USDCx depositor: should have unfilled USDCx rolled to cycle 1
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${USDCX_DEPOSITOR})`)
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
