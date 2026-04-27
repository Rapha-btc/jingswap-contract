// simul-loan-snpl-happy.js
// Stxer mainnet fork simulation: loan-reserve + snpl two-contract architecture,
// happy path via cancel-swap.
//
// Flow:
//   1. LENDER deploys reserve-trait, snpl-trait, loan-reserve, snpl
//   2. LENDER calls loan-reserve.initialize(LENDER)
//   3. LENDER calls snpl.initialize(BORROWER, loan-reserve)
//   4. LENDER calls loan-reserve.supply(22M)
//   5. LENDER calls loan-reserve.open-credit-line(snpl, BORROWER, 22M, 100)
//   6. BORROWER calls snpl.borrow(22M, 100, loan-reserve)
//   7. BORROWER calls snpl.swap-deposit(1, LIMIT_PRICE)   [real Jing v2 deposit]
//   8. BORROWER calls snpl.cancel-swap(1)                 [stxer-only: zeroes
//                                                          our-sbtc-in-jing so
//                                                          repay's assertion passes]
//   9. SBTC_WHALE → BORROWER topup (covers 220k interest shortfall)
//  10. BORROWER calls snpl.repay(1, loan-reserve)
//      → 22k sBTC (10% of interest) routed to JING_TREASURY (protocol fee)
//      → 22.198M sBTC (payoff − fee) routed to loan-reserve
//  11. LENDER calls loan-reserve.withdraw-sbtc(22.198M) — full pull of lender share
//
// Run: npx tsx simulations/simul-loan-snpl-happy.js
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

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
// Hardcoded protocol-fee destination in the snpl bytecode. 10% of interest
// accrued lands here at repay (no fee on seize).
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

// --- Contract names (canonical bytecode → arbitrary deploy names) ---
const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_NAME = "loan-reserve";
const SNPL_NAME = "loan-sbtc-stx-0-jing";

const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_ID = `${LENDER}.${SNPL_NAME}`;

// --- Amounts ---
const SUPPLY_AMOUNT = 22_000_000;     // 0.22 sBTC
const LENDER_SEED = 23_000_000;       // whale → LENDER (LENDER mainnet balance is 0)
const CREDIT_CAP = 22_000_000;
const INTEREST_BPS = 100;             // 1% flat
const LOAN_PRINCIPAL = 22_000_000;
const INTEREST = (LOAN_PRINCIPAL * INTEREST_BPS) / 10_000;                // 220,000
const PAYOFF = LOAN_PRINCIPAL + INTEREST;                                  // 22,220,000
const FEE_BPS_OF_INTEREST = 1_000;                                         // 10% of interest
const PROTOCOL_FEE = (INTEREST * FEE_BPS_OF_INTEREST) / 10_000;            // 22,000
const LENDER_PAYOFF = PAYOFF - PROTOCOL_FEE;                               // 22,198,000
const WHALE_TOPUP = 1_000_000;        // 0.01 sBTC — covers 220k shortfall + buffer

// Jing v2 limit-price: 1e8 precision for STX/BTC.
// 311,526.48 STX/BTC × 1e8 = 31_152_648_000_000
const LIMIT_PRICE = 31_152_648_000_000;

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

  console.log("=== LOAN-RESERVE + SNPL HAPPY PATH STXER SIMULATION ===\n");
  console.log("deploy → init → supply → open-line → borrow");
  console.log("  → swap-deposit → cancel-swap → topup → repay → withdraw\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-loan-snpl-happy"].block_height)
    // ------- Deploy traits + contracts (LENDER as deployer) -------
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

    // ------- 1. LENDER initializes reserve -------
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "initialize",
      function_args: [principalCV(LENDER)],
    })
    .addEvalCode(RESERVE_ID, "(get-lender)")

    // ------- 2. LENDER initializes snpl with (BORROWER, reserve) -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "initialize",
      function_args: [
        principalCV(BORROWER),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    .addEvalCode(SNPL_ID, "(get-borrower)")
    .addEvalCode(SNPL_ID, "(get-reserve)")

    // ------- 2.5. SBTC_WHALE seeds LENDER (mainnet balance is 0 at this block) -------
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

    // ------- 3. LENDER supplies sBTC into reserve -------
    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "supply",
      function_args: [uintCV(SUPPLY_AMOUNT)],
    })
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // expect 22M

    // ------- 4. LENDER opens credit line for snpl -------
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
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`)

    // ------- 5. BORROWER draws via snpl.borrow -------
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
    .addEvalCode(SNPL_ID, "(get-active-loan)")    // expect (some u1)
    .addEvalCode(SNPL_ID, "(get-loan u1)")        // status u0 (OPEN)
    .addEvalCode(SNPL_ID, "(payoff-on-loan u1)")  // expect 22_220_000
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // expect 22M (drawn principal landed on snpl)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 22M

    // ------- 6. BORROWER deposits into Jing v2 -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addEvalCode(SNPL_ID, "(get-loan u1)")        // jing-cycle + limit-price set
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // expect 22M

    // ------- 7. cancel-swap (stxer accommodation: stand-in for Jing settlement) -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // expect u0 (Jing position zeroed)
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // expect 22M back on snpl

    // ------- 8. Whale tops up BORROWER for shortfall -------
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TOPUP),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER),
        noneCV(),
      ],
    })
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    )

    // Snapshot Jing treasury before repay so we can verify the +22k fee delta.
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    // ------- 9. BORROWER repays -------
    //   payoff = 22M × 1.01 = 22.22M
    //   sbtc-balance on snpl = 22M (recovered via cancel-swap)
    //   shortfall = 220k → BORROWER tops up
    //   snpl outflow split:
    //     - 22k sBTC (10% of 220k interest) → JING_TREASURY (protocol fee)
    //     - 22.198M sBTC (payoff − fee) → reserve
    //   reserve.notify-return(22M) → outstanding back to 0
    //   no STX to release (Jing didn't settle)
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [
        uintCV(1),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    .addEvalCode(SNPL_ID, "(get-loan u1)")        // status u1 (REPAID)
    .addEvalCode(SNPL_ID, "(get-active-loan)")    // expect none
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // expect u0 — snpl drained
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // expect 22,198,000 (principal + 90% of interest)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    ) // expect previous + 22,000 (10% of 220k interest)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding-sbtc u0

    // ------- 10. LENDER withdraws lender share -------
    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(LENDER_PAYOFF)],
    })
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // expect u0
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    ) // LENDER end: 23M (whale seed) − 22M (supply) + 22.198M (withdraw) = 23.198M

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "LOAN SNPL HAPPY", expectations["simul-loan-snpl-happy"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
