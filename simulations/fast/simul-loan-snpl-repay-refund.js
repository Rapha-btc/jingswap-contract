// simul-loan-snpl-repay-refund.js
// Stxer mainnet fork simulation: real Jing settle + repay with REFUND branch.
//
// Combines Sim 4's rolling-sBTC outcome (real Jing settle, partial fill,
// snpl rolls remainder forward) with Sim 2's repay path (real STX
// release at repay), but with an over-staged sBTC top-up so the snpl
// holds MORE than payoff at repay time. This fires the refund branch
// in repay's reconciliation block — `(is-shortfall false)` + delta > 0
// → snpl ships the excess sBTC back to the borrower, alongside the
// usual fee + lender-payoff transfers and the STX position release.
//
// The refund branch is dead in every prior sim (all 8 of them took the
// shortfall path). This is the only stxer-feasible way to exercise it,
// because the over-stage scenario depends on whoever-funds-the-snpl
// pre-repay — typically a borrower frontend computing topup against
// stale data, an out-of-band airdrop, or Jing-side dust.
//
// Flow:
//   1. LENDER deploys + initializes
//   2. SBTC_WHALE -> LENDER 110M (seed for 100M supply)
//   3. LENDER supply 100M + open-credit-line(snpl, BORROWER, 100M, 100bps)
//   4. BORROWER borrow 100M -> swap-deposit cycle N
//   5. Real Jing close-and-settle-with-refresh
//        -> mainnet STX absorbs ~40M sats; ~60M sats roll into N+1;
//           snpl receives ~135k STX from distribute-sbtc-depositor
//   6. BORROWER cancel-swap -> recovers rolled sBTC from N+1
//   7. SBTC_WHALE -> snpl 105M sats (over-stage / airdrop)
//        -> snpl now holds (recovered + 105M) sBTC, AT LEAST 105M >
//           payoff 101M, guaranteeing the excess branch fires
//   8. BORROWER.repay -> 4 transfers:
//        - 100k snpl -> JING_TREASURY (10% of 1M interest)
//        - 100.9M snpl -> reserve (lender-payoff)
//        - excess sBTC snpl -> BORROWER  *** REFUND BRANCH ***
//        - STX position snpl -> BORROWER (swap proceeds)
//   9. LENDER.withdraw-sbtc(100.9M)
//
// Run: npx tsx simulations/simul-loan-snpl-repay-refund.js
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
const SNPL_NAME = "loan-sbtc-stx-0-jing";
const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_ID = `${LENDER}.${SNPL_NAME}`;

const LENDER_SEED = 110_000_000; // 1.1 sBTC
const SUPPLY_AMOUNT = 100_000_000; // 1 sBTC
const CREDIT_CAP = 100_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 100_000_000;
const PAYOFF = 101_000_000;
const PROTOCOL_FEE = 100_000;
const LENDER_PAYOFF = 100_900_000;
// Large enough to guarantee snpl sBTC > payoff regardless of how much
// rolled (since clearing depends on live mainnet STX-side liquidity).
// Even if recovery = 0, 105M > 101M payoff -> excess branch fires.
const WHALE_AIRDROP_TO_SNPL = 105_000_000;
const LIMIT_PRICE = 31_152_648_000_000;

async function fetchPythVAA(timestamp) {
  const url = `https://hermes.pyth.network/v2/updates/price/${timestamp}?ids[]=${BTC_USD_FEED}&ids[]=${STX_USD_FEED}`;
  console.log(`Fetching Pyth VAA at timestamp ${timestamp}...`);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json();
  if (!data.binary?.data?.[0]) throw new Error(`No price data found for timestamp ${timestamp}`);
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

  console.log("\n=== REPAY REFUND-BRANCH STXER SIMULATION ===\n");
  console.log("real Jing settle (rolling sBTC) + over-staged airdrop -> refund branch fires\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-loan-snpl-repay-refund"].block_height)
    .withSender(LENDER)
    .addContractDeploy({ contract_name: RESERVE_TRAIT_NAME, source_code: reserveTraitSrc, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: SNPL_TRAIT_NAME, source_code: snplTraitSrc, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: RESERVE_NAME, source_code: reserveSrc, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: SNPL_NAME, source_code: snplSrc, clarity_version: ClarityVersion.Clarity4 })

    .addContractCall({ contract_id: RESERVE_ID, function_name: "initialize", function_args: [principalCV(LENDER)] })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "initialize",
      function_args: [principalCV(BORROWER), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(LENDER_SEED), principalCV(SBTC_WHALE), principalCV(LENDER), noneCV()],
    })

    .withSender(LENDER)
    .addContractCall({ contract_id: RESERVE_ID, function_name: "supply", function_args: [uintCV(SUPPLY_AMOUNT)] })
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "open-credit-line",
      function_args: [
        contractPrincipalCV(LENDER, SNPL_NAME),
        principalCV(BORROWER),
        uintCV(CREDIT_CAP),
        uintCV(INTEREST_BPS),
      ],
    })

    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [
        uintCV(LOAN_PRINCIPAL),
        uintCV(INTEREST_BPS),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })

    // Real Jing settle, no STX-side depositors from us
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

    // Post-settle observations
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // STX received from clearing
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // sBTC on snpl (0 — rolled portion is in Jing N+1, not here)
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // rolled sBTC in cycle N+1

    // Pull rolled sBTC back to snpl
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // recovered sBTC

    // *** OVER-STAGE: whale airdrops 105M sats to snpl, pushing it over payoff ***
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(WHALE_AIRDROP_TO_SNPL), principalCV(SBTC_WHALE), principalCV(SNPL_ID), noneCV()],
    })
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // recovered + 105M (>= 105M, definitely > 101M payoff)

    // Snapshots pre-repay
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    ) // borrower sBTC pre-repay
    .addEvalCode(SNPL_ID, `(stx-get-balance '${BORROWER})`) // borrower STX pre-repay
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    ) // JING_TREASURY pre-repay

    // ------- REPAY: refund + STX-release branches both fire -------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    .addEvalCode(SNPL_ID, "(get-loan u1)") // status u1, position-stx > 0
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // 0 — STX released
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // 0 — drained
    .addEvalCode(SNPL_ID, `(stx-get-balance '${BORROWER})`) // borrower STX post-repay
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    ) // borrower sBTC post-repay (received refund + did NOT pay shortfall)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 100.9M (lender-payoff)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    ) // pre + 100k (10% of 1M interest)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 0

    // Lender drains
    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(LENDER_PAYOFF)],
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

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "LOAN SNPL REPAY REFUND", expectations["simul-loan-snpl-repay-refund"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
