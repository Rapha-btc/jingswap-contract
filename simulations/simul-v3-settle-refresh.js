// simul-v3-settle-refresh.js
// Stxer simulation: settle-with-refresh for v3 (sBTC/USDCx) using a live Pyth VAA.
// Patches MAX_STALENESS to u60 so we prove fresh updates pass the gate.
// Note: v3 dropped the stx-vaa parameter (single-feed contract now).
//
// Run: npx tsx simulations/simul-v3-settle-refresh.js
import fs from "node:fs";
import {
  ClarityVersion, uintCV, contractPrincipalCV, stringAsciiCV, bufferCV,
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
  console.log(`Got VAA (${data.binary.data[0].length} hex chars), ${data.parsed.length} feeds`);
  for (const p of data.parsed) {
    console.log(`  ${p.id.slice(0, 8)}... = $${(Number(p.price.price) / 1e8).toFixed(4)}`);
  }
  return data.binary.data[0];
}

async function main() {
  // Read v3 stxer source and patch MAX_STALENESS down to u60 (real value)
  let source = fs.readFileSync("./contracts/v3/token-x-token-y-jing-v3-stxer.clar", "utf8");
  source = source.replace(
    "(define-constant MAX_STALENESS u999999999)",
    "(define-constant MAX_STALENESS u60)"
  );
  const jingCoreSource = fs.readFileSync("./contracts/jing-core.clar", "utf8");

  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  console.log("\n=== V3 SETTLE-WITH-REFRESH - SBTC/USDCX ===\n");
  console.log("MAX_STALENESS = u60 (real). Stored prices likely too old.");
  console.log("settle should fail with ERR_STALE_PRICE; settle-with-refresh should pass.\n");

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

    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_100), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-x",
      function_args: [uintCV(SBTC_100K), uintCV(SBTC_LIMIT_LOW), sbtcTrait, sbtcAsset],
    })

    .withSender(USDCX_DEPOSITOR)
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "close-deposits", function_args: [] })
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Try settle with stored (likely stale) prices — should fail
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "settle",
      function_args: [sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset],
    })

    // settle-with-refresh using fresh Pyth VAA -- v3 takes only btc-vaa now
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "settle-with-refresh",
      function_args: [
        vaaBuffer,
        contractPrincipalCV(pythStoreAddr, pythStoreName),
        contractPrincipalCV(pythDecAddr, pythDecName),
        contractPrincipalCV(wormAddr, wormName),
        sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset,
      ],
    })

    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
