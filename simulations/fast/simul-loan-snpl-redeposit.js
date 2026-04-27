// simul-loan-snpl-redeposit.js
// Stxer mainnet fork simulation: cancel-swap then re-deposit (same loan).
//
// Borrower opens a loan, deposits at LIMIT_INITIAL into cycle N, then
// cancel-swaps to recover the deposit, then RE-DEPOSITS the same
// notional into a fresh cycle (likely still N since stxer is single-
// block, or N+1 if cycle advanced) at LIMIT_BUMPED. The snpl tracks
// only ONE jing-cycle field per loan record — this sim verifies that
// the second swap-deposit cleanly overwrites the first via map-set,
// and that Jing accepts a fresh deposit from the same depositor after
// they've cancelled.
//
// After the re-deposit, borrower cancel-swaps again, tops up, repays.
// Final loan record should reflect the LAST swap-deposit's cycle and
// limit-price, plus status u1 REPAID.
//
// Verifies:
//   - swap-deposit can be called multiple times on the same loan
//   - The snpl's loan map-set correctly overwrites jing-cycle and
//     limit-price on each call
//   - Jing accepts the second deposit (no stale-depositor error)
//   - cancel-swap → repay still works after the re-deposit
//
// Flow:
//   1. LENDER deploys + initializes
//   2. SBTC_WHALE -> LENDER 23M + BORROWER 1M
//   3. LENDER supply 22M + open-credit-line(snpl, BORROWER, 22M, 100bps)
//   4. BORROWER borrow 22M
//   5. BORROWER swap-deposit(1, LIMIT_INITIAL)        [first deposit]
//   6. BORROWER cancel-swap(1)                        [recover to snpl]
//   7. BORROWER swap-deposit(1, LIMIT_BUMPED)         [RE-DEPOSIT ⭐]
//   8. BORROWER cancel-swap(1)                        [recover again]
//   9. BORROWER repay(1, reserve)
//  10. LENDER withdraw-sbtc(22.198M)
//
// Run: npx tsx simulations/simul-loan-snpl-redeposit.js
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

// First deposit at 311,526.48 STX/BTC
const LIMIT_INITIAL = 31_152_648_000_000;
// Second deposit at 320,000 STX/BTC (more aggressive floor)
const LIMIT_BUMPED = 32_000_000_000_000;

async function main() {
  const reserveTraitSrc = fs.readFileSync("./contracts/loan/reserve-trait.clar", "utf8");
  const snplTraitSrc = fs.readFileSync("./contracts/loan/snpl-trait.clar", "utf8");
  const reserveSrc = fs.readFileSync("./contracts/loan/stxer/loan-reserve-stxer.clar", "utf8");
  const snplSrc = fs.readFileSync("./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar", "utf8");

  console.log("\n=== RE-DEPOSIT STXER SIMULATION ===\n");
  console.log("deposit -> cancel -> RE-deposit (new limit) -> cancel -> repay\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-loan-snpl-redeposit"].block_height)
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

    // ------- FIRST swap-deposit at LIMIT_INITIAL -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_INITIAL)],
    })
    .addEvalCode(SNPL_ID, "(get-loan u1)") // limit-price LIMIT_INITIAL, jing-cycle = current

    // ------- cancel-swap to recover -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // 22M recovered to snpl

    // ------- *** RE-DEPOSIT at LIMIT_BUMPED *** -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_BUMPED)],
    })
    .addEvalCode(SNPL_ID, "(get-loan u1)") // limit-price now LIMIT_BUMPED, jing-cycle overwritten ← KEY proof
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // 0 — sBTC re-deposited into Jing
    // Verify Jing has our deposit again with the NEW limit
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // 22M

    // ------- cancel-swap again -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // 22M back

    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    // Final loan record retains LIMIT_BUMPED (last set value)
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

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "LOAN SNPL REDEPOSIT", expectations["simul-loan-snpl-redeposit"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
