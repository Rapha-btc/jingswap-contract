// simul-loan-snpl-set-reserve.js
// Stxer mainnet fork simulation: borrower switches reserves between loans.
//
// Two loan-reserves deployed from the same source under different names.
// Both deployed by LENDER_A so that the relative trait references
// (.reserve-trait, .snpl-trait) resolve consistently — the snpl's
// <reserve-trait> parameter is typed against LENDER_A's reserve-trait,
// so any reserve passed in must impl that exact trait identity. After
// deployment, reserve-A is initialized with lender=LENDER_A and
// reserve-B with lender=LENDER_B; from that point on, LENDER_B owns
// reserve-B's operational state (supply/withdraw/credit-lines/pause).
//
// One snpl, one borrower. Borrower opens loan u1 against reserve-A,
// repays, calls set-reserve(reserve-B), opens loan u2 against reserve-B,
// repays. Each lender pockets +198k sats independently.
//
// Coverage adds:
//   - Canonical bytecode for RESERVES: two reserve deploys from the same
//     source under different names produce byte-identical contracts
//     (identical execution costs at deploy)
//   - set-reserve happy path: snpl's current-reserve var swaps from
//     reserve-A to reserve-B between loans
//   - Per-reserve credit-line isolation: A.outstanding and B.outstanding
//     track independently; A's repay never touches reserve-B's state
//   - ERR-ACTIVE-LOAN-EXISTS (u104): set-reserve called mid-loan reverts
//   - ERR-WRONG-RESERVE (u113): borrow with reserve-A trait after the
//     switch to reserve-B reverts
//
// Run: npx tsx simulations/simul-loan-snpl-set-reserve.js
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
const LENDER_A = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const LENDER_B = "SP14TZ17WHN486XFHFKHD1KTT6Z721NT40HV59T3K"; // ~41k STX, has gas
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

// --- Contract names ---
const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_A_NAME = "loan-reserve-a";
const RESERVE_B_NAME = "loan-reserve-b";
const SNPL_NAME = "loan-sbtc-stx-0-jing";

const RESERVE_A_ID = `${LENDER_A}.${RESERVE_A_NAME}`;
const RESERVE_B_ID = `${LENDER_A}.${RESERVE_B_NAME}`; // deployed by LENDER_A; lender var set to LENDER_B at init
const SNPL_ID = `${LENDER_A}.${SNPL_NAME}`;

// --- Amounts ---
const LENDER_SEED = 23_000_000;
const SUPPLY_AMOUNT = 22_000_000;
const CREDIT_CAP = 22_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 22_000_000;
const LENDER_PAYOFF = 22_198_000; // payoff - 22k fee
const WHALE_BORROWER_TOPUP = 1_000_000; // covers 220k shortfall on each repay (need ~440k total)
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

  console.log("\n=== SET-RESERVE STXER SIMULATION ===\n");
  console.log("Two reserves (same source) + one snpl");
  console.log("Borrower repays loan 1 on reserve-A, switches, repays loan 2 on reserve-B\n");

  const sessionId = await SimulationBuilder.new()
    // ------- Deploy traits + snpl + reserve-A (LENDER_A) -------
    .withSender(LENDER_A)
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
      contract_name: RESERVE_A_NAME,
      source_code: reserveSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: SNPL_NAME,
      source_code: snplSrc,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Deploy reserve-B from SAME source, also under LENDER_A so the
    // relative trait references (.reserve-trait / .snpl-trait) resolve
    // to the same trait identities the snpl expects. Operational
    // control of reserve-B passes to LENDER_B via the initialize call
    // below.
    .addContractDeploy({
      contract_name: RESERVE_B_NAME,
      source_code: reserveSrc,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ------- Initialize (LENDER_A is deployer for all three contracts) -------
    .addContractCall({
      contract_id: RESERVE_A_ID,
      function_name: "initialize",
      function_args: [principalCV(LENDER_A)], // reserve-A.lender = LENDER_A
    })
    .addContractCall({
      contract_id: RESERVE_B_ID,
      function_name: "initialize",
      function_args: [principalCV(LENDER_B)], // reserve-B.lender = LENDER_B (cross-principal)
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "initialize",
      function_args: [
        principalCV(BORROWER),
        contractPrincipalCV(LENDER_A, RESERVE_A_NAME),
      ],
    })
    .addEvalCode(SNPL_ID, "(get-reserve)")     // reserve-A initially
    .addEvalCode(RESERVE_A_ID, "(get-lender)") // LENDER_A
    .addEvalCode(RESERVE_B_ID, "(get-lender)") // LENDER_B (different operational owner)

    // ------- Whale seeds both LENDERs -------
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(LENDER_SEED),
        principalCV(SBTC_WHALE),
        principalCV(LENDER_A),
        noneCV(),
      ],
    })
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(LENDER_SEED),
        principalCV(SBTC_WHALE),
        principalCV(LENDER_B),
        noneCV(),
      ],
    })

    // ------- Reserve-A: supply + open credit line -------
    .withSender(LENDER_A)
    .addContractCall({
      contract_id: RESERVE_A_ID,
      function_name: "supply",
      function_args: [uintCV(SUPPLY_AMOUNT)],
    })
    .addContractCall({
      contract_id: RESERVE_A_ID,
      function_name: "open-credit-line",
      function_args: [
        contractPrincipalCV(LENDER_A, SNPL_NAME),
        principalCV(BORROWER),
        uintCV(CREDIT_CAP),
        uintCV(INTEREST_BPS),
      ],
    })

    // ------- Reserve-B: supply + open credit line (parallel setup) -------
    .withSender(LENDER_B)
    .addContractCall({
      contract_id: RESERVE_B_ID,
      function_name: "supply",
      function_args: [uintCV(SUPPLY_AMOUNT)],
    })
    .addContractCall({
      contract_id: RESERVE_B_ID,
      function_name: "open-credit-line",
      function_args: [
        contractPrincipalCV(LENDER_A, SNPL_NAME),
        principalCV(BORROWER),
        uintCV(CREDIT_CAP),
        uintCV(INTEREST_BPS),
      ],
    })
    // Both reserves now hold a credit-line for the same snpl, both at outstanding 0
    .addEvalCode(RESERVE_A_ID, `(get-credit-line '${SNPL_ID})`)
    .addEvalCode(RESERVE_B_ID, `(get-credit-line '${SNPL_ID})`)

    // ------- Loan 1: borrow from reserve-A -------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [
        uintCV(LOAN_PRINCIPAL),
        uintCV(INTEREST_BPS),
        contractPrincipalCV(LENDER_A, RESERVE_A_NAME),
      ],
    })
    .addEvalCode(RESERVE_A_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 22M
    .addEvalCode(RESERVE_B_ID, `(get-credit-line '${SNPL_ID})`) // outstanding STILL 0

    // ------- NEGATIVE TEST: set-reserve mid-loan reverts u104 -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "set-reserve",
      function_args: [contractPrincipalCV(LENDER_A, RESERVE_B_NAME)],
    })
    // ^^^ expect (err u104) ERR-ACTIVE-LOAN-EXISTS

    // ------- Loan 1 lifecycle: deposit, cancel, topup, repay -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })

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

    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [
        uintCV(1),
        contractPrincipalCV(LENDER_A, RESERVE_A_NAME),
      ],
    })

    .addEvalCode(RESERVE_A_ID, `(get-credit-line '${SNPL_ID})`) // outstanding 0 again
    .addEvalCode(RESERVE_B_ID, `(get-credit-line '${SNPL_ID})`) // STILL 0 — unchanged

    // ------- set-reserve happy path: now allowed (active-loan = none) -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "set-reserve",
      function_args: [contractPrincipalCV(LENDER_A, RESERVE_B_NAME)],
    })
    .addEvalCode(SNPL_ID, "(get-reserve)") // reserve-B now

    // ------- NEGATIVE TEST: borrow with reserve-A trait after switch reverts u113 -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [
        uintCV(LOAN_PRINCIPAL),
        uintCV(INTEREST_BPS),
        contractPrincipalCV(LENDER_A, RESERVE_A_NAME),
      ],
    })
    // ^^^ expect (err u113) ERR-WRONG-RESERVE

    // ------- Loan 2: borrow with reserve-B trait (correct) -------
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [
        uintCV(LOAN_PRINCIPAL),
        uintCV(INTEREST_BPS),
        contractPrincipalCV(LENDER_A, RESERVE_B_NAME),
      ],
    })
    .addEvalCode(RESERVE_A_ID, `(get-credit-line '${SNPL_ID})`) // STILL 0
    .addEvalCode(RESERVE_B_ID, `(get-credit-line '${SNPL_ID})`) // 22M now
    .addEvalCode(SNPL_ID, "(get-loan u2)") // loan u2 created
    .addEvalCode(SNPL_ID, "(get-loan u1)") // loan u1 still REPAID (status u1)

    // Loan 2 lifecycle
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(2), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(2)],
    })

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

    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "repay",
      function_args: [
        uintCV(2),
        contractPrincipalCV(LENDER_A, RESERVE_B_NAME),
      ],
    })

    .addEvalCode(RESERVE_A_ID, `(get-credit-line '${SNPL_ID})`) // 0
    .addEvalCode(RESERVE_B_ID, `(get-credit-line '${SNPL_ID})`) // 0 again
    .addEvalCode(SNPL_ID, "(get-loan u2)") // status u1 (REPAID)

    // ------- Each LENDER withdraws independently -------
    .withSender(LENDER_A)
    .addContractCall({
      contract_id: RESERVE_A_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(LENDER_PAYOFF)],
    })
    .withSender(LENDER_B)
    .addContractCall({
      contract_id: RESERVE_B_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(LENDER_PAYOFF)],
    })

    // Final balances
    .addEvalCode(
      RESERVE_A_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_A_ID}))`
    ) // 0
    .addEvalCode(
      RESERVE_B_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_B_ID}))`
    ) // 0
    .addEvalCode(
      RESERVE_A_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER_A}))`
    )
    .addEvalCode(
      RESERVE_B_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER_B}))`
    )
    // JING_TREASURY: pre-sim balance + 22k (loan 1) + 22k (loan 2) = +44k total from this sim
    .addEvalCode(
      RESERVE_A_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
