// simul-loan-snpl-set-swap-limit.js
// Stxer mainnet fork simulation: set-swap-limit relay to Jing.
//
// Borrower opens a loan, deposits into Jing at limit-price X, then
// bumps to limit-price Y mid-deposit via snpl.set-swap-limit. The
// snpl's set-swap-limit forwards via as-contract to Jing's
// set-sbtc-limit. This sim is the only coverage of that relay path —
// the snpl's set-swap-limit is otherwise dead in every other sim.
//
// Then borrower runs cancel-swap + repay to close the loan cleanly,
// proving the relay didn't desync the snpl's loan record vs Jing's
// stored deposit limit.
//
// Verifies:
//   - snpl.set-swap-limit returns (ok true)
//   - The snpl's loan record gets updated with the new limit-price
//     (loan.limit-price changes)
//   - Jing emits its own event reflecting the new limit (via the
//     forwarded set-sbtc-limit call)
//   - Subsequent cancel-swap still works correctly post-limit-change
//   - Repay closes cleanly with the loan record showing the FINAL
//     limit-price (proving snpl.set-swap-limit's map-set was clean)
//
// Flow:
//   1. LENDER deploys + initializes
//   2. SBTC_WHALE -> LENDER 23M + BORROWER 1M
//   3. LENDER supply 22M + open-credit-line(snpl, BORROWER, 22M, 100bps)
//   4. BORROWER borrow 22M
//   5. BORROWER swap-deposit(1, LIMIT_INITIAL)        [limit X]
//   6. BORROWER set-swap-limit(1, LIMIT_BUMPED)       [limit X -> Y]
//   7. BORROWER cancel-swap(1)
//   8. BORROWER repay(1, reserve)
//   9. LENDER withdraw-sbtc(22.198M)
//
// Run: npx tsx simulations/simul-loan-snpl-set-swap-limit.js
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
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

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
const LENDER_PAYOFF = 22_198_000;
const WHALE_BORROWER_TOPUP = 1_000_000;

// 311,526.48 STX/BTC initial floor
const LIMIT_INITIAL = 31_152_648_000_000;
// 320,000 STX/BTC bumped floor (more aggressive — borrower wants better fill)
const LIMIT_BUMPED = 32_000_000_000_000;

async function main() {
  const reserveTraitSrc = fs.readFileSync("./contracts/loan/reserve-trait.clar", "utf8");
  const snplTraitSrc = fs.readFileSync("./contracts/loan/snpl-trait.clar", "utf8");
  const reserveSrc = fs.readFileSync("./contracts/loan/stxer/loan-reserve-stxer.clar", "utf8");
  const snplSrc = fs.readFileSync("./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar", "utf8");

  console.log("\n=== SET-SWAP-LIMIT STXER SIMULATION ===\n");
  console.log(`borrower deposits at ${LIMIT_INITIAL}, bumps to ${LIMIT_BUMPED}, cancels, repays\n`);

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

    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    // Initial deposit at LIMIT_INITIAL
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_INITIAL)],
    })
    // Loan record + Jing's stored deposit both reflect LIMIT_INITIAL
    .addEvalCode(SNPL_ID, "(get-loan u1)") // limit-price = LIMIT_INITIAL
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // depositor's amount visible (but not the limit — Jing tracks limit per-deposit internally)

    // *** SET-SWAP-LIMIT: bump to LIMIT_BUMPED ***
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "set-swap-limit",
      function_args: [uintCV(1), uintCV(LIMIT_BUMPED)],
    })
    // Loan record now shows the new limit
    .addEvalCode(SNPL_ID, "(get-loan u1)") // limit-price = LIMIT_BUMPED ← KEY proof

    // Cancel + repay continues normally (proves no state desync)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })

    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    // Final loan record retains LIMIT_BUMPED, status u1 REPAID
    .addEvalCode(SNPL_ID, "(get-loan u1)")
    .addEvalCode(SNPL_ID, "(get-active-loan)") // none

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
