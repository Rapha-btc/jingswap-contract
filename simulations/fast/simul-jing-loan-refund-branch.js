// simul-jing-loan-refund-branch.js
// Stxer mainnet fork simulation: repay's refund branch.
//
// Proves that when `excess-sbtc > owed` (accidental sBTC sent to the contract
// while a loan is active), repay correctly refunds the surplus to BORROWER.
// This branch is untested by the earlier simulations because in normal flow
// excess-sbtc is at most the principal, and principal < owed for any
// interest-bps > 0.
//
// Flow:
//   1. LENDER.fund
//   2. BORROWER.borrow
//   3. BORROWER.swap-deposit
//   4. BORROWER.cancel-swap          (excess-sbtc now equals principal)
//   5. SBTC_WHALE → Contract airdrop  (pushes excess-sbtc above owed)
//   6. BORROWER.repay                 (fires refund branch)
//
// Run: npx tsx simulations/simul-jing-loan-refund-branch.js
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

const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

const WHALE_TO_LENDER = 100_000_000;
const FUND_AMOUNT = 22_000_000;
const LOAN_PRINCIPAL = 22_000_000;     // owed will be 22_220_000
const AIRDROP = 5_000_000;             // > interest (220k), so excess-sbtc > owed

const LIMIT_PRICE = 31_152_648_000_000;

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN REFUND BRANCH STXER SIMULATION ===\n");
  console.log("airdrop > interest → excess-sbtc > owed → refund branch fires\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-jing-loan-refund-branch"].block_height)
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Seed LENDER
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

    // Fund + borrow + swap-deposit + cancel-swap
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
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect 22M (just the recovered principal; available-sbtc=0)

    // -------- The airdrop — unsolicited transfer into the contract --------
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(AIRDROP),
        principalCV(SBTC_WHALE),
        principalCV(CONTRACT_ID),
        noneCV(),
      ],
    })
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect 27M

    // Capture BORROWER's pre-repay sBTC for delta math
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )

    // -------- Repay — should fire refund branch --------
    // owed = 22_220_000
    // excess-sbtc = 27M - 0 = 27M
    // 27M > 22_220_000 → shortfall = 0, refund = 27M - 22.22M = 4_780_000
    // Transfers: contract → BORROWER 4.78M (refund); contract → LENDER 22.22M (owed)
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "repay",
      function_args: [uintCV(1)],
    })

    // Post-repay state
    .addEvalCode(CONTRACT_ID, "(get-loan u1)") // status u2 (REPAID)
    .addEvalCode(CONTRACT_ID, "(get-active-loan)") // none
    .addEvalCode(CONTRACT_ID, `(stx-get-balance '${CONTRACT_ID})`) // u0
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // u0 (full payout)
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${BORROWER}))`
    ) // initial + 4.78M
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    ) // initial + 22.22M - funded 22M

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN REFUND BRANCH", expectations["simul-jing-loan-refund-branch"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
