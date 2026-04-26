// simul-loan-snpl-true-happy.js
// Stxer mainnet fork simulation: TRUE happy path — no cancel-swap stand-in.
//
// Companion to simul-loan-snpl-happy.js. Where that sim uses cancel-swap
// to zero our-sbtc-in-jing before repay, this one lets Jing actually
// settle. Snpl ends up holding STX (the swap proceeds) plus possibly
// some rolled sBTC dust. Borrower repays — testing the STX-release
// branch in repay that ships stx-out -> borrower (currently dead in
// the cancel-swap variant where stx-released is always u0).
//
// Settlement outcome depends on which side binds at the live clearing
// price. Most fork blocks bind sBTC (snpl fully clears, gets STX, no
// rolled sBTC). The repay path handles either: any rolled sBTC is
// pulled back via cancel-swap before repay; the recovered + topped-up
// sBTC pays out 22k sats (fee) + 22.198M sats (lender) and the STX
// position releases to the borrower.
//
// Flow:
//   1.  LENDER deploys + initializes reserve & snpl
//   2.  SBTC_WHALE -> LENDER 23M (lender seed)
//   3.  LENDER supply 22M, open-credit-line(22M, 100bps)
//   4.  BORROWER borrow(22M, 100, reserve)
//   5.  BORROWER swap-deposit(1, LIMIT_PRICE)
//   6.  STX_DEPOSITOR_1 + STX_DEPOSITOR_2 fund STX side of cycle 8
//   7.  LENDER -> Jing.close-and-settle-with-refresh(VAA)
//        [snpl receives STX; sBTC may roll or fully clear]
//   8.  IF rolled sBTC > 0: BORROWER.cancel-swap(1) [pulls dust back]
//   9.  SBTC_WHALE -> BORROWER 25M sats (covers full payoff shortfall)
//  10.  BORROWER.repay(1, reserve)
//        - 22k sBTC -> JING_TREASURY (10% protocol fee)
//        - 22.198M sBTC -> reserve (lender payoff)
//        - all STX position -> BORROWER  *** NEW BRANCH TESTED ***
//        - notify-return(22M) -> outstanding back to 0
//  11.  LENDER.withdraw-sbtc(22.198M)
//
// Run: npx tsx simulations/simul-loan-snpl-true-happy.js
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

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
const STX_DEPOSITOR_1 = "SP14TZ17WHN486XFHFKHD1KTT6Z721NT40HV59T3K";
const STX_DEPOSITOR_2 = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG";
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v4`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v3`;
const WORMHOLE_CORE = `${PYTH_DEPLOYER}.wormhole-core-v4`;

const BTC_USD_FEED =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_USD_FEED =
  "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_NAME = "loan-reserve";
const SNPL_NAME = "loan-sbtc-stx-0-jing";
const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_ID = `${LENDER}.${SNPL_NAME}`;

// --- Amounts ---
const SUPPLY_AMOUNT = 22_000_000;
const LENDER_SEED = 23_000_000;
const CREDIT_CAP = 22_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 22_000_000;
const PAYOFF = 22_220_000;
const LENDER_PAYOFF = 22_198_000; // payoff - 22k fee
const LIMIT_PRICE = 31_152_648_000_000;

// Whale tops up borrower with the FULL payoff plus buffer. With sBTC-binding
// the snpl has 0 sBTC after settle (all cleared) and the entire 22.22M
// shortfall must come from the borrower's wallet. With STX-binding some
// sBTC rolls and the topup needed is smaller — extra is refunded to
// borrower via the (else) branch in repay.
const WHALE_BORROWER_TOPUP = 25_000_000; // 0.25 sBTC

// STX depositors funding cycle 8 STX-side
const STX_DEPOSIT_1 = 41_000_000_000;
const STX_DEPOSIT_2 = 14_000_000_000;

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
  const reserveTraitSrc = fs.readFileSync(
    "./contracts/loan/reserve-trait.clar",
    "utf8"
  );
  const snplTraitSrc = fs.readFileSync(
    "./contracts/loan/snpl-trait.clar",
    "utf8"
  );
  const reserveSrc = fs.readFileSync(
    "./contracts/loan/stxer/loan-reserve-stxer.clar",
    "utf8"
  );
  const snplSrc = fs.readFileSync(
    "./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar",
    "utf8"
  );

  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  const [pythStorageAddr, pythStorageName] = PYTH_STORAGE.split(".");
  const [pythDecoderAddr, pythDecoderName] = PYTH_DECODER.split(".");
  const [wormholeAddr, wormholeName] = WORMHOLE_CORE.split(".");

  console.log("\n=== LOAN-RESERVE + SNPL TRUE HAPPY PATH STXER SIMULATION ===\n");
  console.log("real Jing settle -> snpl gets STX -> borrower repays");
  console.log("  -> tests STX-release branch in repay (stx-out -> borrower)\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: RESERVE_TRAIT_NAME,
      source_code: reserveTraitSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: SNPL_TRAIT_NAME,
      source_code: snplTraitSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: RESERVE_NAME,
      source_code: reserveSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: SNPL_NAME,
      source_code: snplSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "initialize",
      function_args: [principalCV(LENDER)],
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "initialize",
      function_args: [
        principalCV(BORROWER),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })

    // Whale seeds LENDER
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(LENDER_SEED),
        principalCV(SBTC_WHALE),
        principalCV(LENDER),
        noneCV(),
      ],
    })

    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "supply",
      function_args: [uintCV(SUPPLY_AMOUNT)],
    })
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

    // STX-side depositors
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: JING_MARKET,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_DEPOSIT_1), uintCV(LIMIT_PRICE)],
    })
    .withSender(STX_DEPOSITOR_2)
    .addContractCall({
      contract_id: JING_MARKET,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_DEPOSIT_2), uintCV(LIMIT_PRICE)],
    })

    // Real Jing settle
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

    // Post-settle observation
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // STX received
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // sBTC on snpl
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // rolled sBTC in N+1, if any

    // Defensive cancel-swap. Reverts harmlessly if Jing has no deposit.
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })

    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // 0 (gate ready for repay)
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // recovered sBTC (+ rolled if any)

    // Whale tops up borrower for full payoff shortfall
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_BORROWER_TOPUP),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER),
        noneCV(),
      ],
    })

    // Snapshot pre-repay balances
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    ) // borrower sBTC pre-repay
    .addEvalCode(SNPL_ID, `(stx-get-balance '${BORROWER})`) // borrower STX pre-repay
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    ) // JING_TREASURY sBTC pre-repay

    // REPAY — tests STX-release branch
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [
        uintCV(1),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })

    .addEvalCode(SNPL_ID, "(get-loan u1)") // status u1, position-stx > 0
    .addEvalCode(SNPL_ID, "(get-active-loan)") // none
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // 0 — STX released
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // 0 — drained
    .addEvalCode(SNPL_ID, `(stx-get-balance '${BORROWER})`) // borrower STX post-repay
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    ) // borrower sBTC post-repay
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 22.198M (lender payoff)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    ) // pre + 22k (protocol fee)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding-sbtc 0

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

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
