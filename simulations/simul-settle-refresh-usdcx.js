// simul-settle-refresh-usdcx.js
// Stxer simulation: test settle-with-refresh for sBTC/USDCx using live Pyth VAAs
// Uses real MAX_STALENESS (u60) to prove fresh price updates pass the gate.
//
// Run: npx tsx simulations/simul-settle-refresh-usdcx.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  bufferCV,
  contractPrincipalCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-auction-usdcx`;

const USDCX_DEPOSITOR = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const SBTC_DEPOSITOR = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

// Pyth mainnet contracts
const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v4`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v3`;
const WORMHOLE_CORE = `${PYTH_DEPLOYER}.wormhole-core-v4`;

// Pyth feed IDs (no 0x prefix for Hermes API)
const BTC_USD_FEED =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_USD_FEED =
  "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

const USDCX_100 = 100_000_000; // 100 USDCx
const SBTC_100K = 100_000;

async function fetchPythVAA(timestamp) {
  const url = `https://hermes.pyth.network/v2/updates/price/${timestamp}?ids[]=${BTC_USD_FEED}&ids[]=${STX_USD_FEED}`;
  console.log(`Fetching Pyth VAA at timestamp ${timestamp}...`);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const data = await response.json();
  if (!data.binary?.data?.[0]) {
    throw new Error(`No price data found for timestamp ${timestamp}`);
  }
  console.log(
    `Got VAA (${data.binary.data[0].length} hex chars), ${data.parsed.length} feeds`
  );
  for (const p of data.parsed) {
    const price = Number(p.price.price) / 1e8;
    console.log(`  ${p.id.slice(0, 8)}... = $${price.toFixed(4)}`);
  }
  return data.binary.data[0];
}

async function main() {
  // Read the stxer-usdcx contract and patch MAX_STALENESS to real value
  let source = fs.readFileSync(
    "./contracts/blind-auction-stxer-usdcx.clar",
    "utf8"
  );
  source = source.replace(
    "(define-constant MAX_STALENESS u999999999)",
    "(define-constant MAX_STALENESS u60)"
  );
  // NOTE: MAX_STALENESS now u60 — we're testing that fresh VAAs pass!

  // Fetch a recent VAA (30 seconds ago to ensure it exists)
  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  console.log("\n=== SBTC/USDCX SETTLE-WITH-REFRESH SIMULATION ===\n");
  console.log("Uses real MAX_STALENESS (u60) — fresh Pyth VAAs required.");
  console.log("1. Deploy contract (zeroed block thresholds, real staleness)");
  console.log("2. Deposit 100 USDCx + 100k sats");
  console.log("3. Close deposits");
  console.log("4. Try settle (stored prices) -> likely ERR_STALE_PRICE");
  console.log("5. settle-with-refresh (fresh VAA) -> should succeed");
  console.log("6. Read settlement + cycle 1 rollover");
  console.log("");

  const [pythStorageAddr, pythStorageName] = PYTH_STORAGE.split(".");
  const [pythDecoderAddr, pythDecoderName] = PYTH_DECODER.split(".");
  const [wormholeAddr, wormholeName] = WORMHOLE_CORE.split(".");

  const sessionId = await SimulationBuilder.new()
    // Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction-usdcx",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Deposit USDCx
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_100)],
    })

    // Deposit sBTC
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K)],
    })

    // Close deposits
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Read phase
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Try settle with stored (possibly stale) prices
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // settle-with-refresh using fresh Pyth VAA
    .withSender(USDCX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle-with-refresh",
      function_args: [
        vaaBuffer, // btc-vaa
        vaaBuffer, // stx-vaa (same combined VAA works for both)
        contractPrincipalCV(pythStorageAddr, pythStorageName),
        contractPrincipalCV(pythDecoderAddr, pythDecoderName),
        contractPrincipalCV(wormholeAddr, wormholeName),
      ],
    })

    // Read results
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
