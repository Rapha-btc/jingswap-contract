// simul-jing-loan-rollover.js
// Stxer mainnet fork simulation: TRUE happy path, STX-binding rollover case.
//
// Deposits more sBTC (80M sats ≈ 0.8 BTC) than the Jing market's STX side can
// absorb. STX becomes the binding side: all STX is consumed, the unfilled
// sBTC portion rolls to the next Jing cycle. BORROWER then calls cancel-swap
// on the new cycle to pull the rolled sBTC back; repay folds it into
// `excess-sbtc` and the borrower's shortfall is reduced accordingly.
//
// Flow:
//   1. SBTC_WHALE → LENDER          (LENDER needs >0.8 BTC to fund the loan)
//   2. SBTC_WHALE → BORROWER        (covers repay shortfall)
//   3. LENDER.fund(100M)
//   4. BORROWER.borrow(80M)
//   5. BORROWER.swap-deposit(1, limit)
//   6. close-and-settle-with-refresh on Jing — STX binding, sBTC rolls
//   7. BORROWER.cancel-swap(1)      (pulls rolled sBTC back)
//   8. BORROWER.repay(1)
//
// Run: npx tsx simulations/simul-jing-loan-rollover.js
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

const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2"; // ~40.5 BTC

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v4`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v3`;
const WORMHOLE_CORE = `${PYTH_DEPLOYER}.wormhole-core-v4`;

const BTC_USD_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_USD_FEED = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

// --- Amounts ---
const WHALE_TO_LENDER = 100_000_000;   // 1 sBTC seed for lender (needs >0.8 for fund)
const WHALE_TO_BORROWER = 85_000_000;  // 0.85 sBTC — covers full owed shortfall
const FUND_AMOUNT = 100_000_000;       // lender deposits 1 sBTC
const LOAN_PRINCIPAL = 80_000_000;     // 0.8 sBTC — deliberately > Jing's STX-side capacity
const LIMIT_PRICE = 31_152_648_000_000;

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

  console.log("\n=== JING-LOAN STX-BINDING ROLLOVER STXER SIMULATION ===\n");
  console.log("Big loan: 80M sats sBTC vs ~246k STX liquidity on Jing\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-jing-loan-rollover"].block_height)
    // Deploy
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Seed LENDER with sBTC from whale
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TO_LENDER),
        principalCV(SBTC_WHALE),
        principalCV(LENDER),
        noneCV(),
      ],
    })

    // Seed BORROWER with sBTC from whale
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TO_BORROWER),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER),
        noneCV(),
      ],
    })

    // Fund
    .withSender(LENDER)
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
    .addEvalCode(CONTRACT_ID, "(owed-on-loan u1)") // expect 80_800_000

    // Swap-deposit
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-cycle-totals (contract-call? '${JING_MARKET} get-current-cycle))`
    )

    // Jing close-and-settle (any sender can call)
    .addContractCall({
      contract_id: JING_MARKET,
      function_name: "close-and-settle-with-refresh",
      function_args: [
        vaaBuffer,
        vaaBuffer,
        contractPrincipalCV(pythStorageAddr, pythStorageName),
        contractPrincipalCV(pythDecoderAddr, pythDecoderName),
        contractPrincipalCV(wormholeAddr, wormholeName),
      ],
    })

    // Post-settle: STX balance (from Jing payout) + rollover check
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${CONTRACT_ID})`
    ) // rolled amount on new cycle — expect > 0

    // Cancel-swap on the new cycle to pull the rolled sBTC back
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${CONTRACT_ID})`
    ) // expect u0
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect available + rolled

    // Repay
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")       // status u2 (REPAID)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)")   // none
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`) // u0
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect available-sbtc (20M)
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${BORROWER})`)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN ROLLOVER", expectations["simul-jing-loan-rollover"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
