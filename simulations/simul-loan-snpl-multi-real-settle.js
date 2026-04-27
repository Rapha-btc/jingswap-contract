// simul-loan-snpl-multi-real-settle.js
// Stxer mainnet fork simulation: TWO snpls + REAL Jing settle.
//
// Sim 5 demonstrated multi-snpl with cancel-swap synthetic settlement.
// This companion lets Jing actually settle with both snpls deposited as
// distinct depositors in the same cycle, then proves:
//   - Jing's distribute-sbtc-depositor handles two contract-controlled
//     depositors correctly, with independent sbtc-rolled and stx-received
//     accounting per principal
//   - Both snpls receive STX directly (no cross-contamination)
//   - Both snpls roll their own unfilled portion into N+1 (independent)
//   - Each snpl's borrower can cancel-swap their own rolled portion
//     without affecting the other snpl's Jing position
//   - Both can then repay using their respective reserve, with the
//     STX-release branch firing on each snpl independently
//
// Setup:
//   - Loan size 50M sats per snpl (100M total deposit) — large enough
//     that mainnet's STX side won't fully clear both, guaranteeing roll
//     on each
//   - Both borrow from the same reserve (100M supply, two 50M lines)
//   - Both deposit into the same Jing cycle
//   - Real close-and-settle-with-refresh
//   - Each cancel-swap their own rolled portion
//   - Each repay independently
//
// Run: npx tsx simulations/simul-loan-snpl-multi-real-settle.js
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

const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER_A = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const BORROWER_B = "SP14TZ17WHN486XFHFKHD1KTT6Z721NT40HV59T3K";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v4`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v3`;
const WORMHOLE_CORE = `${PYTH_DEPLOYER}.wormhole-core-v4`;

const BTC_USD_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_USD_FEED = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_NAME = "loan-reserve";
const SNPL_A_NAME = "loan-sbtc-stx-0-jing-a";
const SNPL_B_NAME = "loan-sbtc-stx-0-jing-b";
const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_A_ID = `${LENDER}.${SNPL_A_NAME}`;
const SNPL_B_ID = `${LENDER}.${SNPL_B_NAME}`;

const LENDER_SEED = 110_000_000;
const SUPPLY_AMOUNT = 100_000_000; // serves both 50M loans
const PER_SNPL_CAP = 50_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 50_000_000;
const PAYOFF = 50_500_000;
const PROTOCOL_FEE = 50_000; // 10% of 500k interest
const LENDER_PAYOFF = 50_450_000;
// Both borrowers will need to top up their respective shortfalls.
// Worst case (snpl recovery = 0): need full payoff 50.5M each.
// Conservative: whale tops both with 55M each.
const WHALE_BORROWER_TOPUP = 55_000_000;
const LIMIT_PRICE = 31_152_648_000_000;

async function fetchPythVAA(timestamp) {
  const url = `https://hermes.pyth.network/v2/updates/price/${timestamp}?ids[]=${BTC_USD_FEED}&ids[]=${STX_USD_FEED}`;
  console.log(`Fetching Pyth VAA at timestamp ${timestamp}...`);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json();
  if (!data.binary?.data?.[0]) throw new Error(`No price data for timestamp ${timestamp}`);
  console.log(`Got VAA (${data.binary.data[0].length} hex chars), ${data.parsed.length} feeds`);
  for (const p of data.parsed) {
    const price = Number(p.price.price) / 1e8;
    console.log(`  ${p.id.slice(0, 8)}... = $${price.toFixed(4)}`);
  }
  return data.binary.data[0];
}

async function main() {
  const reserveTraitSrc = fs.readFileSync("./contracts/loan/reserve-trait.clar", "utf8");
  const snplTraitSrc = fs.readFileSync("./contracts/loan/snpl-trait.clar", "utf8");
  const reserveSrc = fs.readFileSync("./contracts/loan/stxer/loan-reserve-stxer.clar", "utf8");
  const snplSrc = fs.readFileSync("./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar", "utf8");

  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  const [pythStorageAddr, pythStorageName] = PYTH_STORAGE.split(".");
  const [pythDecoderAddr, pythDecoderName] = PYTH_DECODER.split(".");
  const [wormholeAddr, wormholeName] = WORMHOLE_CORE.split(".");

  console.log("\n=== MULTI-SNPL REAL SETTLE STXER SIMULATION ===\n");
  console.log("Two 50M-sat snpls in same Jing cycle, real settle, both repay\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(LENDER)
    .addContractDeploy({ contract_name: RESERVE_TRAIT_NAME, source_code: reserveTraitSrc, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: SNPL_TRAIT_NAME, source_code: snplTraitSrc, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: RESERVE_NAME, source_code: reserveSrc, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: SNPL_A_NAME, source_code: snplSrc, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: SNPL_B_NAME, source_code: snplSrc, clarity_version: ClarityVersion.Clarity4 })

    .addContractCall({ contract_id: RESERVE_ID, function_name: "initialize", function_args: [principalCV(LENDER)] })
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "initialize",
      function_args: [principalCV(BORROWER_A), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "initialize",
      function_args: [principalCV(BORROWER_B), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    // Whale seeds LENDER + both borrowers (each needs full-payoff topup
    // since real settle could fully clear small loans on binding-sBTC
    // outcome, leaving recovery near zero)
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(LENDER_SEED), principalCV(SBTC_WHALE), principalCV(LENDER), noneCV()],
    })
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(WHALE_BORROWER_TOPUP), principalCV(SBTC_WHALE), principalCV(BORROWER_A), noneCV()],
    })
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(WHALE_BORROWER_TOPUP), principalCV(SBTC_WHALE), principalCV(BORROWER_B), noneCV()],
    })

    .withSender(LENDER)
    .addContractCall({ contract_id: RESERVE_ID, function_name: "supply", function_args: [uintCV(SUPPLY_AMOUNT)] })
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "open-credit-line",
      function_args: [
        contractPrincipalCV(LENDER, SNPL_A_NAME),
        principalCV(BORROWER_A),
        uintCV(PER_SNPL_CAP),
        uintCV(INTEREST_BPS),
      ],
    })
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "open-credit-line",
      function_args: [
        contractPrincipalCV(LENDER, SNPL_B_NAME),
        principalCV(BORROWER_B),
        uintCV(PER_SNPL_CAP),
        uintCV(INTEREST_BPS),
      ],
    })

    // Both borrow + deposit
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })

    .withSender(BORROWER_B)
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })

    // Cycle has 100M sats from us + mainnet pre-existing
    .addEvalCode(
      SNPL_A_ID,
      `(contract-call? '${JING_MARKET} get-cycle-totals (contract-call? '${JING_MARKET} get-current-cycle))`
    )

    // *** REAL Jing settle ***
    .withSender(LENDER)
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

    // Per-snpl post-settle observations
    .addEvalCode(SNPL_A_ID, `(stx-get-balance '${SNPL_A_ID})`) // STX received by A
    .addEvalCode(SNPL_B_ID, `(stx-get-balance '${SNPL_B_ID})`) // STX received by B
    .addEvalCode(
      SNPL_A_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_A_ID}))`
    ) // 0 (rolled is in Jing, not on snpl)
    .addEvalCode(
      SNPL_B_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_B_ID}))`
    ) // 0
    // Each snpl's rolled sBTC in N+1 (key proof of independent accounting)
    .addEvalCode(
      SNPL_A_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_A_ID})`
    )
    .addEvalCode(
      SNPL_B_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_B_ID})`
    )

    // Each cancel-swap their own rolled portion (defensive — if no roll
    // because real-Jing fully cleared their portion, this reverts harmlessly)
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .withSender(BORROWER_B)
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })

    .addEvalCode(
      SNPL_A_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_A_ID}))`
    ) // recovered sBTC for A
    .addEvalCode(
      SNPL_B_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_B_ID}))`
    ) // recovered sBTC for B

    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    ) // pre-repay JING_TREASURY snapshot

    // Both repay (each with their own reserve trait reference — same reserve)
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "repay",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    .withSender(BORROWER_B)
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "repay",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    .addEvalCode(SNPL_A_ID, "(get-loan u1)") // status u1 REPAID, position-stx > 0
    .addEvalCode(SNPL_B_ID, "(get-loan u1)") // status u1 REPAID, position-stx > 0
    .addEvalCode(SNPL_A_ID, `(stx-get-balance '${SNPL_A_ID})`) // 0
    .addEvalCode(SNPL_B_ID, `(stx-get-balance '${SNPL_B_ID})`) // 0
    .addEvalCode(
      SNPL_A_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_A_ID}))`
    ) // 0
    .addEvalCode(
      SNPL_B_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_B_ID}))`
    ) // 0
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`) // outstanding 0
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`) // outstanding 0
    // Reserve sBTC: 100.9M (lender-payoff × 2)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    )
    // JING_TREASURY: pre + 100k (50k × 2)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(LENDER_PAYOFF * 2)],
    })
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 0
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
