// simul-jing-loan-sbtc-stx-single.js
// Stxer mainnet fork simulation: jing-loan happy path.
//
// Flow:
//   1. LENDER fund
//   2. BORROWER borrow
//   3. BORROWER swap-deposit         (real Jing v2 deposit)
//   4. BORROWER cancel-swap          (stxer-only accommodation: single-block
//                                      forks can't wait for Jing settlement,
//                                      so we pull sBTC back to zero out
//                                      `our-sbtc-in-jing`, which repay asserts)
//   5. Whale tops up BORROWER sBTC   (SP24MM9... — covers interest shortfall)
//   6. BORROWER repay
//
// Run: npx tsx simulations/simul-jing-loan-sbtc-stx-single.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";
import { verifyAndReport } from "./_verify.js";
import { expectations } from "./_expectations.js";
import { blockPins } from "./_block-pins.js";

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

// --- Amounts ---
const FUND_AMOUNT = 22_000_000;      // 0.22 sBTC — fits LENDER mainnet balance
const LOAN_PRINCIPAL = 22_000_000;   // whole stash
const WHALE_TOPUP = 20_000_000;      // 0.2 sBTC to borrower — covers interest shortfall

// Jing v2 limit-price: 1e8 precision for STX/BTC.
// 311,526.48 STX/BTC × 1e8 = 31_152_648_000_000
const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN SBTC-STX-SINGLE - HAPPY PATH STXER SIMULATION ===\n");
  console.log("fund → borrow → swap-deposit → cancel-swap → topup → repay\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-jing-loan-sbtc-stx-single"].block_height)
    // 1. Deploy as LENDER (so deployed contract ID matches the LENDER constant)
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // 2. LENDER funds the contract
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect 30_000_000

    // 3. BORROWER borrows
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL)],
    })
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // expect (some u1)
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")
    .addEvalCode(CONTRACT_ID, "(owed-on-loan u1)") // expect 33_750_000 (0.3 * 1.125)
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect u0

    // 4. BORROWER deposits into Jing v2
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // status = SWAP-DEPOSITED (u1)
    // Jing position check would be nice here but `our-sbtc-in-jing` is now
    // private. Infer via Jing's own read-only + contract sBTC balance.
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${CONTRACT_ID})`
    ) // expect 30_000_000

    // 5. Cancel-swap — stxer-only step to zero out the Jing position so repay
    //    can pass its assertion. In mainnet, Jing settles during cycle close
    //    and the equivalent zeroing happens naturally.
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      CONTRACT_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${CONTRACT_ID})`
    ) // expect u0
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect 30_000_000

    // 6. Whale tops up BORROWER with sBTC (covers interest + buffer)
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
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    )

    // 7. BORROWER repays
    //    owed = 30M + 12.5% = 33.75M sats
    //    excess-sbtc = contract-sbtc (30M) - available (0) = 30M
    //    shortfall = 33.75M - 30M = 3.75M (interest only)
    //    BORROWER tops up 3.75M, contract sends 33.75M to LENDER
    //    No STX to release (Jing didn't settle; contract STX balance = 0)
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)")      // status = STATUS-REPAID (u2)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)")  // expect none
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect u0 (untouched)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect u0 — everything paid out
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    ) // LENDER's sBTC should have increased by 33_750_000 net of fund

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN SBTC STX SINGLE", expectations["simul-jing-loan-sbtc-stx-single"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
