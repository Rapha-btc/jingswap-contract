// simul-loan-snpl-lender-withdraw-mid-loan.js
// Stxer mainnet fork simulation: lender withdraws mid-loan / reserve
// liquidity vs outstanding decoupling.
//
// Tests the documented property: `withdraw-sbtc` on the reserve has no
// outstanding-check, so the lender can drain reserve funds at any
// time, even while one snpl has an active loan and another has a
// credit line still open. The consequence is that a borrower with an
// approved credit line can FAIL to draw if the lender has withdrawn
// the underlying liquidity.
//
// Setup:
//   - LENDER supplies 50M sats
//   - Two snpls, two borrowers
//   - Snpl A draws 22M (reserve now has 28M)
//   - LENDER.withdraw-sbtc(28M) — drains the remaining liquidity
//   - Snpl A's outstanding is STILL 22M (lender's withdraw didn't
//     touch it — different accounting)
//   - Snpl B tries to draw 22M (cap allows it) — FAILS with sBTC
//     transfer error because the reserve is empty
//   - Snpl A repays normally — reserve receives 22.198M lender-payoff
//   - LENDER withdraws the rest
//   - Net: LENDER pulled liquidity early (28M+22.198M = 50.198M) for
//     +198k net on the loan that completed; snpl B's open credit-line
//     becomes drawable again only after A's repay refills the reserve
//
// Verifies:
//   - withdraw-sbtc has no outstanding-check (proves the lender can
//     extract liquidity even with active loans)
//   - The reserve's outstanding map is independent of its sBTC balance
//   - A draw against an empty reserve fails at the SBTC transfer (the
//     reserve's outstanding goes to 22M before the transfer reverts —
//     wait, actually no, it goes through draw checks first then the
//     transfer fails inside as-contract?, propagating the err)
//
// Run: npx tsx simulations/simul-loan-snpl-lender-withdraw-mid-loan.js
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
const BORROWER_A = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const BORROWER_B = "SP14TZ17WHN486XFHFKHD1KTT6Z721NT40HV59T3K";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_NAME = "loan-reserve";
const SNPL_A_NAME = "loan-sbtc-stx-0-jing-a";
const SNPL_B_NAME = "loan-sbtc-stx-0-jing-b";
const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_A_ID = `${LENDER}.${SNPL_A_NAME}`;
const SNPL_B_ID = `${LENDER}.${SNPL_B_NAME}`;

const LENDER_SEED = 55_000_000;
const SUPPLY_AMOUNT = 50_000_000;
const PER_SNPL_CAP = 22_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 22_000_000;
const LENDER_PAYOFF = 22_198_000;
const WHALE_BORROWER_TOPUP_A = 1_000_000;

// Mid-loan withdraw amount (drains everything in reserve after A's draw)
const MID_LOAN_WITHDRAW = 28_000_000; // 50M supply − 22M drawn = 28M leftover

const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const reserveTraitSrc = fs.readFileSync("./contracts/loan/reserve-trait.clar", "utf8");
  const snplTraitSrc = fs.readFileSync("./contracts/loan/snpl-trait.clar", "utf8");
  const reserveSrc = fs.readFileSync("./contracts/loan/stxer/loan-reserve-stxer.clar", "utf8");
  const snplSrc = fs.readFileSync("./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar", "utf8");

  console.log("\n=== LENDER WITHDRAW MID-LOAN STXER SIMULATION ===\n");
  console.log("LENDER drains 28M mid-loan; snpl B draw then fails (empty reserve)\n");

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

    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(LENDER_SEED), principalCV(SBTC_WHALE), principalCV(LENDER), noneCV()],
    })
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(WHALE_BORROWER_TOPUP_A), principalCV(SBTC_WHALE), principalCV(BORROWER_A), noneCV()],
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

    // Reserve has 50M sBTC, both lines have outstanding 0
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 50M

    // Snpl A borrows 22M
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    // Reserve now: 50M - 22M = 28M sBTC. A's outstanding = 22M.
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 28M
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`) // outstanding 22M
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`) // outstanding 0

    // *** LENDER drains the 28M leftover MID-LOAN ***
    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(MID_LOAN_WITHDRAW)],
    })
    // Reserve now empty BUT outstanding still 22M for A
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 0
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`) // outstanding STILL 22M ← KEY
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`) // outstanding 0

    // *** Snpl B tries to borrow 22M — credit line allows (cap=22M, outstanding=0)
    // but reserve has 0 sBTC — should fail with sBTC transfer error ***
    .withSender(BORROWER_B)
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL), uintCV(INTEREST_BPS), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })
    // Snpl B remains uninitialized (active-loan still none, no loan u1 record)
    .addEvalCode(SNPL_B_ID, "(get-active-loan)") // none
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`) // outstanding STILL 0 (draw reverted)

    // Snpl A continues normally: swap-deposit, cancel-swap, repay
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "repay",
      function_args: [uintCV(1), contractPrincipalCV(LENDER, RESERVE_NAME)],
    })

    // After A's repay, reserve has 22.198M (lender-payoff)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 22.198M
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`) // outstanding 0 (closed)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`) // outstanding 0 (still never drew)

    // LENDER drains the rest (22.198M)
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
    // LENDER total: 55M seed - 50M supply + 28M (mid-withdraw) + 22.198M (final) = 55.198M (+198k net)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
