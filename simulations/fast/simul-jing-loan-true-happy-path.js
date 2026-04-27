// simul-jing-loan-true-happy-path.js
// Stxer mainnet fork simulation: TRUE happy path.
//
// Exercises the full real-world lifecycle — no stxer-only shortcuts for the
// STX payout. Jing v2's real close-and-settle-with-refresh is called with a
// live Pyth VAA, so STX lands in the contract via actual distribute-to-sbtc-
// depositor logic.
//
// Flow:
//   1. LENDER fund
//   2. BORROWER borrow
//   3. BORROWER swap-deposit                          (22M sBTC → Jing cycle N)
//   4. close-and-settle-with-refresh(btc-vaa, stx-vaa, ...) on Jing
//        → Jing clears (part of) our sBTC, sends STX to this contract,
//          advances to cycle N+1 with any unfilled sBTC rolled
//   5. [IF rollover] BORROWER.cancel-swap(1) → pulls back rolled sBTC
//        (keeps `our-sbtc-in-jing current-cycle = 0` assertion in repay)
//   6. sBTC whale → BORROWER                          (covers shortfall)
//   7. BORROWER.repay(1)                              (LENDER gets owed sBTC,
//                                                      BORROWER gets STX)
//
// Run: npx tsx simulations/simul-jing-loan-true-happy-path.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
  bufferCV,
  contractPrincipalCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";
import { verifyAndReport } from "./_verify.js";
import { expectations } from "./_expectations.js";
import { blockPins } from "./_block-pins.js";

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

// Pyth mainnet contracts (same set used by blind-auction settle-refresh sim)
const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v4`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v3`;
const WORMHOLE_CORE = `${PYTH_DEPLOYER}.wormhole-core-v4`;

const BTC_USD_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_USD_FEED = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

const FUND_AMOUNT = 22_000_000;
const LOAN_PRINCIPAL = 22_000_000;
// In the 100%-cleared binding-sbtc case, excess-sbtc in contract = 0, so
// borrower must top up the full owed (principal + interest) from their wallet.
// 0.5 sBTC covers 22.22M owed comfortably.
const WHALE_SBTC_TOPUP = 50_000_000;   // 0.5 sBTC
const LIMIT_PRICE = 31_152_648_000_000; // 311,526.48 STX/BTC

async function fetchPythVAA(timestamp) {
  const url = `https://hermes.pyth.network/v2/updates/price/${timestamp}?ids[]=${BTC_USD_FEED}&ids[]=${STX_USD_FEED}`;
  console.log(`Fetching Pyth VAA at timestamp ${timestamp}...`);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json();
  if (!data.binary?.data?.[0]) {
    throw new Error(`No price data found for timestamp ${timestamp}`);
  }
  console.log(`Got VAA (${data.binary.data[0].length} hex chars), ${data.parsed.length} feeds`);
  for (const p of data.parsed) {
    const price = Number(p.price.price) / 1e8;
    console.log(`  ${p.id.slice(0, 8)}... = $${price.toFixed(4)}`);
  }
  return data.binary.data[0];
}

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  const [pythStorageAddr, pythStorageName] = PYTH_STORAGE.split(".");
  const [pythDecoderAddr, pythDecoderName] = PYTH_DECODER.split(".");
  const [wormholeAddr, wormholeName] = WORMHOLE_CORE.split(".");

  console.log("\n=== JING-LOAN TRUE HAPPY PATH STXER SIMULATION ===\n");
  console.log("fund → borrow → swap-deposit → Jing close+settle-with-refresh");
  console.log("  → (maybe cancel rolled) → whale topup → repay\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-jing-loan-true-happy-path"].block_height)
    // Deploy
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Fund
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })

    // Borrow
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL)],
    })

    // Swap-deposit
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")
    .addEvalCode(`${JING_MARKET.split(".")[0]}.${JING_MARKET.split(".")[1]}`, "(get-cycle-phase)")
    .addEvalCode(`${JING_MARKET.split(".")[0]}.${JING_MARKET.split(".")[1]}`, "(get-current-cycle)")
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-cycle-totals (contract-call? '${JING_MARKET} get-current-cycle))`
    )

    // Jing: close + settle with fresh Pyth VAA (anyone can call)
    .addContractCall({
      contract_id: JING_MARKET,
      function_name: "close-and-settle-with-refresh",
      function_args: [
        vaaBuffer, // btc-vaa
        vaaBuffer, // stx-vaa
        contractPrincipalCV(pythStorageAddr, pythStorageName),
        contractPrincipalCV(pythDecoderAddr, pythDecoderName),
        contractPrincipalCV(wormholeAddr, wormholeName),
      ],
    })

    // Post-settle state: Jing has advanced cycle, contract should now have STX
    .addEvalCode(`${JING_MARKET.split(".")[0]}.${JING_MARKET.split(".")[1]}`, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    )
    // Check for rollover: our sBTC in the new (post-settle) cycle
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${CONTRACT_ID})`
    )

    // sBTC whale → BORROWER (covers any shortfall at repay)
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_SBTC_TOPUP),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER),
        noneCV(),
      ],
    })

    // Repay
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")       // status u2 (REPAID)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)")   // expect none
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`) // expect u0
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect u0
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${BORROWER})`)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN TRUE HAPPY PATH", expectations["simul-jing-loan-true-happy-path"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
