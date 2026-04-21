// simul-jing-loan-set-swap-limit.js
// Stxer mainnet fork simulation: set-swap-limit relay path.
//
// Proves that a borrower can update their active Jing deposit's limit-price
// through the contract's as-contract? wrapper. Mirrors Jing v2's
// `set-sbtc-limit` so the borrower can react to price moves without
// cancel-swap-ing.
//
// Flow:
//   1. LENDER.fund
//   2. BORROWER.borrow
//   3. BORROWER.swap-deposit(1, initial-limit)
//   4. BORROWER.set-swap-limit(1, new-limit)
//   5. Verify loan.limit-price + Jing's stored limit both reflect the new value
//   6. cancel-swap + repay to leave the contract clean
//
// Run: npx tsx simulations/simul-jing-loan-set-swap-limit.js
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
const WHALE_TO_BORROWER = 2_000_000;     // covers interest
const FUND_AMOUNT = 22_000_000;
const LOAN_PRINCIPAL = 22_000_000;

// Limit prices — 1e8 precision for STX/BTC
const INITIAL_LIMIT = 31_152_648_000_000;   // 311,526.48 STX/BTC
const NEW_LIMIT = 28_000_000_000_000;       // 280,000.00 STX/BTC — lower floor

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN SET-SWAP-LIMIT STXER SIMULATION ===\n");
  console.log("initial limit 311,526.48 STX/BTC → new limit 280,000.00 STX/BTC\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

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

    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_AMOUNT)],
    })

    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(LOAN_PRINCIPAL)],
    })

    // Swap-deposit with initial limit
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(INITIAL_LIMIT)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // limit-price = INITIAL_LIMIT

    // -------- set-swap-limit happy path --------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-swap-limit",
      function_args: [uintCV(1), uintCV(NEW_LIMIT)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // limit-price = NEW_LIMIT

    // -------- Guard 1: non-borrower set-swap-limit --------
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-swap-limit",
      function_args: [uintCV(1), uintCV(INITIAL_LIMIT)],
    })
    // expected: (err u101) ERR-NOT-BORROWER

    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // limit-price still NEW_LIMIT

    // -------- Guard 2: set-swap-limit on non-existent loan --------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-swap-limit",
      function_args: [uintCV(999), uintCV(NEW_LIMIT)],
    })
    // expected: (err u105) ERR-LOAN-NOT-FOUND

    // Clean up: cancel-swap + repay
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // status u2 (REPAID), limit-price preserved

    // -------- Guard 3: set-swap-limit on REPAID loan (wrong status) --------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "set-swap-limit",
      function_args: [uintCV(1), uintCV(INITIAL_LIMIT)],
    })
    // expected: (err u106) ERR-BAD-STATUS

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
