// simul-jing-loan-reborrow-after-seize.js
// Stxer mainnet fork simulation: re-borrow after a SEIZE cleanup.
//
// Proves that after `seize` clears `active-loan` to `none`, a fresh `borrow`
// creates loan u2 and can run the full lifecycle. Complements simulation 8
// (serial loans after repay) by covering the SEIZE cleanup path.
//
// Flow:
//   1. LENDER.fund
//   2. BORROWER.borrow (loan u1)
//   3. BORROWER.swap-deposit
//   4. LENDER.cancel-swap                      (deadline=now via CLAWBACK-DELAY u0)
//   5. LENDER.seize(1)                         (loan u1 → SEIZED, active-loan → none)
//   6. LENDER re-funds the pool                 (contract is empty after seize)
//   7. BORROWER.borrow(LOAN2)                  (loan u2 created — THE key check)
//   8. BORROWER.swap-deposit(2)
//   9. BORROWER.cancel-swap(2)
//   10. BORROWER.repay(2)                      (requires whale topup for interest)
//
// Run: npx tsx simulations/simul-jing-loan-reborrow-after-seize.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

const WHALE_TO_LENDER = 100_000_000;
const WHALE_TO_BORROWER = 5_000_000;    // for loan 2 interest shortfall
const FUND_1 = 22_000_000;              // loan 1 principal
const LOAN1_PRINCIPAL = 22_000_000;
const FUND_2 = 15_000_000;              // new funding after seize
const LOAN2_PRINCIPAL = 15_000_000;

const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN RE-BORROW AFTER SEIZE STXER SIMULATION ===\n");
  console.log("Proves active-loan and next-loan-id reset correctly after seize.\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Seed
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TO_LENDER),
        principalCV(SBTC_WHALE),
        principalCV(LENDER),
        noneCV(),
      ],
    })
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_TO_BORROWER),
        principalCV(SBTC_WHALE),
        principalCV(BORROWER),
        noneCV(),
      ],
    })

    // -------- LOAN 1: seize path --------
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_1)],
    })

    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN1_PRINCIPAL)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })

    // LENDER cancel-swap (deadline=now with CLAWBACK-DELAY u0)
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })

    // Seize
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "seize",
      function_args: [uintCV(1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")     // status u3 (SEIZED)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // none ← THE key check after seize
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // u0 (nothing left)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // u0 — contract fully drained after seize

    // -------- LOAN 2: re-borrow after seize --------
    // LENDER funds again
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_2)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // u15M

    // The key test: BORROWER can borrow again
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN2_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // (some u2) ← next-loan-id incremented past the seized loan
    .addEvalCode(CONTRACT_ID, "(get-loan u2)")     // fresh loan, status u0
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")     // historical: still SEIZED, preserved

    // Complete loan 2 to prove full lifecycle works
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(2), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(2)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(2)],
    })

    // Final state
    .addEvalCode(CONTRACT_ID, "(get-loan u2)")     // status u2 (REPAID)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // none again
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // u0

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
