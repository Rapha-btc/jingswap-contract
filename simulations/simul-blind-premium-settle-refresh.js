// simul-blind-premium-settle-refresh.js
// Stxer simulation: test settle-with-refresh using live Pyth VAAs
// Uses real MAX_STALENESS (u80) to prove fresh price updates pass the gate.
// Also tests the bundled close-and-settle-with-refresh in a second cycle.
//
// Run: npx tsx simulations/simul-blind-premium-settle-refresh.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  bufferCV,
  contractPrincipalCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-premium`;

const STX_DEPOSITOR = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
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

const STX_100 = 100_000_000;
const SBTC_100K = 100_000;

const LIMIT_STX = 99_999_999_999_999;
const LIMIT_SBTC = 1;

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
  // Read main contract and only patch block thresholds (keep MAX_STALENESS u80)
  let source = fs.readFileSync("./contracts/blind-premium.clar", "utf8");
  source = source
    .replace(
      "(define-constant DEPOSIT_MIN_BLOCKS u10)",
      "(define-constant DEPOSIT_MIN_BLOCKS u0)"
    )
    .replace(
      "(define-constant CANCEL_THRESHOLD u42)",
      "(define-constant CANCEL_THRESHOLD u0)"
    );
  // NOTE: MAX_STALENESS stays at u80 -- we're testing that fresh VAAs pass!

  // Fetch a recent VAA (30 seconds ago to ensure it exists)
  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  const [pythStorageAddr, pythStorageName] = PYTH_STORAGE.split(".");
  const [pythDecoderAddr, pythDecoderName] = PYTH_DECODER.split(".");
  const [wormholeAddr, wormholeName] = WORMHOLE_CORE.split(".");

  console.log("\n=== BLIND PREMIUM - SETTLE-WITH-REFRESH + BUNDLED CLOSE-AND-SETTLE ===\n");
  console.log("Part A: settle-with-refresh (separate close + settle)");
  console.log("  Uses real MAX_STALENESS (u80) -- fresh Pyth VAAs required.");
  console.log("  1. Deploy contract (zeroed block thresholds, real staleness)");
  console.log("  2. Deposit 100 STX + 100k sats");
  console.log("  3. Close deposits");
  console.log("  4. Try settle (stored prices) -> likely ERR_STALE_PRICE");
  console.log("  5. settle-with-refresh (fresh VAA) -> should succeed");
  console.log("");
  console.log("Part B: close-and-settle-with-refresh (bundled)");
  console.log("  6. Deposit again in cycle 1");
  console.log("  7. close-and-settle-with-refresh -> one tx does both");
  console.log("  8. Verify cycle advanced to 2");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // Deploy
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ============================================================
    // PART A: settle-with-refresh (separate)
    // ============================================================

    // Deposit STX
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(LIMIT_STX)],
    })

    // Deposit sBTC
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(LIMIT_SBTC)],
    })

    // Close deposits
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Read phase
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // Try settle with stored (possibly stale) prices
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // settle-with-refresh using fresh Pyth VAA
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle-with-refresh",
      function_args: [
        vaaBuffer,
        vaaBuffer,
        contractPrincipalCV(pythStorageAddr, pythStorageName),
        contractPrincipalCV(pythDecoderAddr, pythDecoderName),
        contractPrincipalCV(wormholeAddr, wormholeName),
      ],
    })

    // Read results
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-dex-price)")

    // ============================================================
    // PART B: close-and-settle-with-refresh (bundled)
    // ============================================================

    // Deposit into cycle 1
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_100), uintCV(LIMIT_STX)],
    })
    .withSender(SBTC_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_100K), uintCV(LIMIT_SBTC)],
    })

    // Bundled close-and-settle-with-refresh
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-and-settle-with-refresh",
      function_args: [
        vaaBuffer,
        vaaBuffer,
        contractPrincipalCV(pythStorageAddr, pythStorageName),
        contractPrincipalCV(pythDecoderAddr, pythDecoderName),
        contractPrincipalCV(wormholeAddr, wormholeName),
      ],
    })

    // Verify cycle 2
    .addEvalCode(CONTRACT_ID, "(get-settlement u1)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u2)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
