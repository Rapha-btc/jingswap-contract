// simul-loan-snpl-reborrow-after-seize.js
// Stxer mainnet fork simulation: borrow + seize (default) + borrow again.
//
// Borrower defaults on loan u1 (lender seizes). The credit line stays
// open (no close-credit-line call) and the reserve's outstanding-sbtc
// drops back to zero via notify-return at seize time. Borrower then
// opens loan u2 against the SAME snpl + SAME reserve and runs a happy
// path repay. Tests:
//   - active-loan releases on seize (just like repay does)
//   - next-loan-id increments past the seized loan
//   - credit line is still drawable post-default (no automatic close)
//   - lender's outstanding tracking handles seize → reborrow cleanly
//   - lender net = +198k from loan 2 only (loan 1 seize recovers exactly
//     principal, no interest)
//
// Flow:
//   1.  LENDER deploys + initializes reserve & snpl
//   2.  SBTC_WHALE -> LENDER 23M + BORROWER 1M
//   3.  LENDER supply 22M + open-credit-line(snpl, BORROWER, 22M, 100bps)
//   4.  Loan u1: borrow + swap-deposit + cancel-swap (synthetic settle)
//        → snpl holds 22M sats sBTC, no STX
//   5.  LENDER.seize(1, reserve)
//        → 22M sats sBTC ships snpl→reserve, notify-return(22M),
//          status u2 (SEIZED)
//   6.  Loan u2: borrow + swap-deposit + cancel-swap + topup + repay
//        → reserve receives 22.198M lender-payoff, JING_TREASURY +22k
//   7.  LENDER.withdraw-sbtc(22.198M)  [+198k net, only loan 2 had interest]
//
// Run: npx tsx simulations/simul-loan-snpl-reborrow-after-seize.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
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

const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_NAME = "loan-reserve";
const SNPL_NAME = "loan-sbtc-stx-0-jing";
const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_ID = `${LENDER}.${SNPL_NAME}`;

const LENDER_SEED = 23_000_000;
const SUPPLY_AMOUNT = 22_000_000;
const CREDIT_CAP = 22_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 22_000_000;
const WHALE_BORROWER_TOPUP = 1_000_000; // covers loan 2's 220k shortfall
const LENDER_PAYOFF = 22_198_000; // loan 2 lender share
const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const reserveTraitSrc = fs.readFileSync("./contracts/loan/reserve-trait.clar", "utf8");
  const snplTraitSrc = fs.readFileSync("./contracts/loan/snpl-trait.clar", "utf8");
  const reserveSrc = fs.readFileSync("./contracts/loan/stxer/loan-reserve-stxer.clar", "utf8");
  const snplSrc = fs.readFileSync("./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar", "utf8");

  console.log("\n=== REBORROW-AFTER-SEIZE STXER SIMULATION ===\n");
  console.log("Loan 1 -> seize, then loan 2 happy path on the same snpl/reserve\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-loan-snpl-reborrow-after-seize"].block_height)
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
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(WHALE_BORROWER_TOPUP), principalCV(SBTC_WHALE), principalCV(BORROWER), noneCV()],
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

    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`)

    // ------- LOAN 1: borrow → swap-deposit → cancel-swap → DEFAULT -------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({ contract_id: SNPL_ID, function_name: "cancel-swap", function_args: [uintCV(1)] })

    // LENDER seizes (CLAWBACK-DELAY u0 -> deadline already reached)
    .withSender(LENDER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "seize",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    // Post-seize observations
    .addEvalCode(SNPL_ID, "(get-active-loan)") // none ← active-loan released by seize
    .addEvalCode(SNPL_ID, "(get-loan u1)") // status u2 SEIZED
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 0 (notify-return fired)
    .addEvalCode(SNPL_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`) // 0
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`) // 22M (recovered)
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`) // unchanged ← no fee on seize

    // ------- LOAN 2: same snpl, same reserve, fresh draw -------
    // Credit line is STILL OPEN (no close-credit-line call).
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    // Loan u2 created, not u1 (next-loan-id incremented past the seized loan)
    .addEvalCode(SNPL_ID, "(get-active-loan)") // (some u2)
    .addEvalCode(SNPL_ID, "(get-loan u2)") // status u0 OPEN
    .addEvalCode(SNPL_ID, "(get-loan u1)") // STILL status u2 SEIZED ← prior loan record preserved
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 22M again

    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(2), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({ contract_id: SNPL_ID, function_name: "cancel-swap", function_args: [uintCV(2)] })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [uintCV(2), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    .addEvalCode(SNPL_ID, "(get-active-loan)") // none
    .addEvalCode(SNPL_ID, "(get-loan u2)") // status u1 REPAID
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 0
    // Reserve sBTC after seize+repay: 22M (seized) − 22M (loan 2 draw) + 22.198M (loan 2 repay) = 22.198M
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`)
    // JING_TREASURY: +22k (only the loan 2 repay paid the protocol fee)
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`)

    // ------- LENDER withdraws -------
    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(LENDER_PAYOFF)],
    })
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`) // 0
    // LENDER end: 23M seed − 22M supply + 22.198M withdraw = 23.198M (+198k net, loan 2 only)
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`)

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "LOAN SNPL REBORROW AFTER SEIZE", expectations["simul-loan-snpl-reborrow-after-seize"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
