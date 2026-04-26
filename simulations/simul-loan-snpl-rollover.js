// simul-loan-snpl-rollover.js
// Stxer mainnet fork simulation: back-to-back loans on the same snpl + reserve.
//
// Borrower runs the full happy path twice in a row on a single snpl
// against a single reserve. No set-reserve in between. Tests the
// state-machine continuity post-repay: active-loan releases, next-loan-id
// increments, the credit line outstanding-sbtc cycles back to zero ready
// for the next draw, and the lender accumulates 198k sats per loan.
//
// Flow:
//   1.  LENDER deploys + initializes reserve & snpl
//   2.  SBTC_WHALE -> LENDER 23M (seed) + BORROWER 1M (shortfall buffer)
//   3.  LENDER supply 22M + open-credit-line(snpl, BORROWER, 22M, 100bps)
//   4.  Loan u1: borrow + swap-deposit + cancel-swap + repay
//   5.  Loan u2: borrow + swap-deposit + cancel-swap + repay (same reserve)
//   6.  LENDER withdraw-sbtc(22.396M)  [+396k net = 198k × 2]
//
// Run: npx tsx simulations/simul-loan-snpl-rollover.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
  contractPrincipalCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

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
// Topup borrower once with 1M sats; covers both 220k shortfalls (440k total)
const WHALE_BORROWER_TOPUP = 1_000_000;
// After two repays, reserve holds 22.198M × 2 (lender share) − 22M (already
// returned to snpl as loan-2 draw, then given back) = 22.396M
const FINAL_WITHDRAW = 22_396_000;
const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const reserveTraitSrc = fs.readFileSync("./contracts/loan/reserve-trait.clar", "utf8");
  const snplTraitSrc = fs.readFileSync("./contracts/loan/snpl-trait.clar", "utf8");
  const reserveSrc = fs.readFileSync("./contracts/loan/stxer/loan-reserve-stxer.clar", "utf8");
  const snplSrc = fs.readFileSync("./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar", "utf8");

  console.log("\n=== ROLLOVER STXER SIMULATION ===\n");
  console.log("Two consecutive happy-path loans on the same snpl + reserve\n");

  const sessionId = await SimulationBuilder.new()
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

    // Whale seeds LENDER + BORROWER (one topup covers both loans' shortfall)
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

    // Snapshot JING_TREASURY pre-loans
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`)

    // ------- LOAN 1 -------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    .addEvalCode(SNPL_ID, "(get-active-loan)") // (some u1)

    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({ contract_id: SNPL_ID, function_name: "cancel-swap", function_args: [uintCV(1)] })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    // Loan 1 closed: active-loan released, outstanding back to 0, reserve holds 22.198M
    .addEvalCode(SNPL_ID, "(get-active-loan)") // none
    .addEvalCode(SNPL_ID, "(get-loan u1)") // status u1 REPAID
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 0
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`) // 22.198M

    // ------- LOAN 2 (same reserve, no set-reserve in between) -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    .addEvalCode(SNPL_ID, "(get-active-loan)") // (some u2) ← next-loan-id incremented
    .addEvalCode(SNPL_ID, "(get-loan u2)") // status u0 OPEN
    .addEvalCode(SNPL_ID, "(get-loan u1)") // STILL status u1 REPAID
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 22M again
    // Reserve sBTC after loan 2 borrow: 22.198M (post-repay) − 22M (drawn) = 198k
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`)

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
    // Reserve sBTC after loan 2 repay: 198k + 22.198M = 22.396M
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`)
    // JING_TREASURY: pre + 44k (22k per repay)
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`)

    // ------- LENDER drains both repays in one withdraw -------
    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(FINAL_WITHDRAW)],
    })
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`) // 0
    // LENDER end: 23M seed − 22M supply + 22.396M withdraw = 23.396M (+396k net)
    .addEvalCode(RESERVE_ID, `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
