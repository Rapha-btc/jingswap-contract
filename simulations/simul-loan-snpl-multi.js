// simul-loan-snpl-multi.js
// Stxer mainnet fork simulation: TWO snpls on ONE reserve.
//
// Proves the canonical-bytecode value prop: the same source file
// (loan-sbtc-stx-0-jing-stxer.clar) deployed under two different
// contract names produces two contracts with byte-identical bytecode
// that behave identically. Both share one loan-reserve. Snpl A
// completes a happy-path repay; snpl B is defaulted and seized. The
// reserve's credit-lines map is keyed per-snpl-principal so the two
// flows are independent across the entire lifecycle.
//
// Bonus coverage: snpl B's pre-seize cancel-swap is called by LENDER
// (not the borrower), exercising the post-deadline OR branch in the
// snpl's cancel-swap assertion that no prior sim has hit.
//
// Flow:
//   1.  LENDER deploys reserve-trait, snpl-trait, loan-reserve, snpl-A, snpl-B
//   2.  LENDER initializes reserve, snpl-A (BORROWER_A), snpl-B (BORROWER_B)
//   3.  SBTC_WHALE -> LENDER 50M (covers both 22M loans + buffer)
//   4.  LENDER supply 44M, open credit-line for both snpls (22M each, 100bps)
//   5.  BORROWER_A.borrow (snpl-A) + BORROWER_B.borrow (snpl-B)
//        -> reserve credit-lines: A.outstanding=22M, B.outstanding=22M
//   6.  BORROWER_A.swap-deposit, BORROWER_B.swap-deposit (both into Jing cycle)
//   7.  BORROWER_A.cancel-swap (borrower branch)
//   8.  SBTC_WHALE -> BORROWER_A 1M (shortfall topup)
//   9.  BORROWER_A.repay(1, reserve) [happy path]
//        -> A.outstanding -> 0, reserve +22.198M sBTC, JING_TREASURY +22k
//        -> CRITICAL: B.outstanding STILL 22M (per-snpl isolation)
//  10.  LENDER.cancel-swap (snpl-B)   [LENDER branch — post-deadline OR]
//  11.  LENDER.seize(1, reserve) on snpl-B
//        -> B.outstanding -> 0, reserve +22M sBTC, no protocol fee
//  12.  LENDER.withdraw-sbtc(44.198M) — drains both repay payoff + seize
//        recovery in one call
//
// Run: npx tsx simulations/simul-loan-snpl-multi.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
  contractPrincipalCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER_A = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const BORROWER_B = "SP14TZ17WHN486XFHFKHD1KTT6Z721NT40HV59T3K"; // ~41k STX, has gas
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

// --- Contract names ---
const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_NAME = "loan-reserve";
const SNPL_A_NAME = "loan-sbtc-stx-0-jing-a";
const SNPL_B_NAME = "loan-sbtc-stx-0-jing-b";

const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_A_ID = `${LENDER}.${SNPL_A_NAME}`;
const SNPL_B_ID = `${LENDER}.${SNPL_B_NAME}`;

// --- Amounts ---
const LENDER_SEED = 50_000_000;
const SUPPLY_AMOUNT = 44_000_000;     // covers both 22M loans
const PER_SNPL_CAP = 22_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 22_000_000;
const LENDER_PAYOFF = 22_198_000;     // Snpl A repay (22.22M - 22k fee)
const SEIZE_RECOVERY = 22_000_000;    // Snpl B's drawn principal recovered via cancel-swap
const TOTAL_RESERVE_END = LENDER_PAYOFF + SEIZE_RECOVERY; // 44,198,000
const WHALE_TOPUP_A = 1_000_000;
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

  console.log("\n=== TWO SNPLs ON ONE RESERVE — STXER SIMULATION ===\n");
  console.log("Same snpl source -> two contract names");
  console.log("Snpl A repays, Snpl B is seized — credit lines independent\n");

  const sessionId = await SimulationBuilder.new()
    // ------- Deploy -------
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
    // SAME source deployed twice -> identical bytecode hash
    .addContractDeploy({
      contract_name: SNPL_A_NAME,
      source_code: snplSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: SNPL_B_NAME,
      source_code: snplSrc,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ------- Initialize -------
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "initialize",
      function_args: [principalCV(LENDER)],
    })
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "initialize",
      function_args: [
        principalCV(BORROWER_A),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "initialize",
      function_args: [
        principalCV(BORROWER_B),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    // Sanity: each snpl reports its own borrower
    .addEvalCode(SNPL_A_ID, "(get-borrower)")
    .addEvalCode(SNPL_B_ID, "(get-borrower)")

    // ------- Whale seeds LENDER -------
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

    // ------- Supply + open both credit lines -------
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
    // Both lines should appear, each with outstanding 0
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`)

    // ------- Both borrowers draw -------
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "borrow",
      function_args: [
        uintCV(LOAN_PRINCIPAL),
        uintCV(INTEREST_BPS),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    .withSender(BORROWER_B)
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "borrow",
      function_args: [
        uintCV(LOAN_PRINCIPAL),
        uintCV(INTEREST_BPS),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    // CRITICAL: both lines now show outstanding 22M, independently keyed
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`)
    // Same loan-id u1 on each snpl, identical loan record structure
    .addEvalCode(SNPL_A_ID, "(get-loan u1)")
    .addEvalCode(SNPL_B_ID, "(get-loan u1)")
    // Reserve drained
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // expect 0

    // ------- Both swap-deposit into Jing -------
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .withSender(BORROWER_B)
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })

    // ------- Snpl A: borrower-branch cancel-swap (synthetic settlement) -------
    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })

    // ------- Whale tops up BORROWER_A for shortfall, A repays -------
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TOPUP_A),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER_A),
        noneCV(),
      ],
    })

    // Snapshot JING_TREASURY pre-repay
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    .withSender(BORROWER_A)
    .addContractCall({
      contract_id: SNPL_A_ID,
      function_name: "repay",
      function_args: [
        uintCV(1),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })

    // CRITICAL: A's line outstanding -> 0, B's line UNCHANGED at 22M
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`) // outstanding 0
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`) // outstanding STILL 22M ← isolation proof
    .addEvalCode(SNPL_A_ID, "(get-loan u1)") // status u1 (REPAID)
    .addEvalCode(SNPL_B_ID, "(get-loan u1)") // status u0 (still OPEN)
    // Reserve sBTC now holds A's lender-payoff
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // expect 22.198M
    // JING_TREASURY +22k (only A's repay paid the protocol fee)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    // ------- Snpl B: LENDER cancels (post-deadline OR branch) + seizes -------
    .withSender(LENDER)
    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    // Snpl B sBTC balance after cancel: should be 22M (recovered principal)
    .addEvalCode(
      SNPL_B_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_B_ID}))`
    )

    .addContractCall({
      contract_id: SNPL_B_ID,
      function_name: "seize",
      function_args: [
        uintCV(1),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })

    // CRITICAL: B's line now 0; A's line remains 0; both closed
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_A_ID})`)
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_B_ID})`)
    .addEvalCode(SNPL_B_ID, "(get-loan u1)") // status u2 (SEIZED)
    .addEvalCode(SNPL_A_ID, "(get-active-loan)") // none
    .addEvalCode(SNPL_B_ID, "(get-active-loan)") // none
    // Reserve sBTC = 22.198M (A repay) + 22M (B seize) = 44.198M
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    )
    // JING_TREASURY unchanged from post-A-repay (no fee on B's seize)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    // ------- LENDER drains the reserve in one call -------
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(TOTAL_RESERVE_END)],
    })
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 0
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )
    // LENDER end: 50M seed - 44M supply + 44.198M withdraw = 50.198M (+198k net)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
