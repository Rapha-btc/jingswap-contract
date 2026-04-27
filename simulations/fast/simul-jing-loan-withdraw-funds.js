// simul-jing-loan-withdraw-funds.js
// Stxer mainnet fork simulation: withdraw-funds paths and guards.
//
// Proves:
//   - LENDER can fund then withdraw freely from `available-sbtc`
//   - Over-withdraw (> available-sbtc) errors with ERR-INSUFFICIENT-FUNDS (u103)
//   - Non-LENDER callers error with ERR-NOT-LENDER (u100)
//   - When a loan is active, the borrowed principal is NOT in `available-sbtc`
//     → LENDER cannot claw back borrowed funds by calling withdraw
//
// Run: npx tsx simulations/simul-jing-loan-withdraw-funds.js
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
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2"; // ~40.5 BTC

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const CONTRACT_NAME = "jing-loan-sbtc-stx-single";
const CONTRACT_ID = `${LENDER}.${CONTRACT_NAME}`;

// --- Amounts ---
const WHALE_SEED = 100_000_000;     // 1 sBTC to LENDER
const FUND_1 = 50_000_000;          // 0.5 sBTC first fund
const WITHDRAW_1 = 20_000_000;      // 0.2 sBTC pull-back
const FUND_2 = 10_000_000;          // 0.1 sBTC refund after draining
const BORROW_AMOUNT = 30_000_000;   // borrower takes 0.3 sBTC
const OVER_WITHDRAW = 25_000_000;   // larger than remaining available — must fail

async function main() {
  const source = fs.readFileSync(
    "./contracts/jing-loan-sbtc-stx-single-Stxer.clar",
    "utf8"
  );

  console.log("=== JING-LOAN WITHDRAW-FUNDS STXER SIMULATION ===\n");
  console.log("fund cycles, over-withdraw guard, non-lender guard,");
  console.log("active-loan protection (borrowed principal not withdrawable)\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-jing-loan-withdraw-funds"].block_height)
    // Deploy
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // Seed LENDER with sBTC
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(WHALE_SEED),
        principalCV(SBTC_WHALE),
        principalCV(LENDER),
        noneCV(),
      ],
    })

    // -------- Phase 1: fund + withdraw cycle --------
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_NAME
        ? CONTRACT_ID
        : CONTRACT_ID, // no-op ternary to keep line clean
      function_name: "fund",
      function_args: [uintCV(FUND_1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect 50_000_000

    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "withdraw-funds",
      function_args: [uintCV(WITHDRAW_1)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect 30_000_000

    // Drain fully
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "withdraw-funds",
      function_args: [uintCV(30_000_000)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect u0

    // -------- Phase 2: refund + borrow reduces available --------
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "fund",
      function_args: [uintCV(FUND_2 + BORROW_AMOUNT)], // 40M total so borrow + some leftover
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect 40_000_000

    // Borrower takes 30M — available drops to 10M
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "borrow",
      function_args: [uintCV(BORROW_AMOUNT)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // expect 10_000_000
    .addEvalCode(CONTRACT_ID, "(get-active-loan)")    // (some u1)

    // -------- Phase 3: over-withdraw guard during active loan --------
    // LENDER tries to withdraw MORE than available (25M > 10M).
    // Would succeed if the guard were bypassable — proves borrowed principal
    // is untouchable.
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "withdraw-funds",
      function_args: [uintCV(OVER_WITHDRAW)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // still 10_000_000

    // -------- Phase 4: non-lender guard --------
    // BORROWER tries to withdraw the remaining 10M — should fail u100.
    .withSender(BORROWER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "withdraw-funds",
      function_args: [uintCV(FUND_2)],
    })

    // Sanity check: available still intact, loan still active
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // 10_000_000
    .addEvalCode(CONTRACT_ID, "(get-active-loan)")    // (some u1)

    // -------- Phase 5: LENDER withdraws the legitimately-available portion --------
    .withSender(LENDER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "withdraw-funds",
      function_args: [uintCV(FUND_2)],
    })
    .addEvalCode(CONTRACT_ID, "(get-available-sbtc)") // u0

    // Contract now holds only the borrowed 30M — check sBTC balance matches
    .addEvalCode(
      CONTRACT_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${CONTRACT_ID}))`
    ) // expect 30_000_000 — the active loan's principal

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "JING LOAN WITHDRAW FUNDS", expectations["simul-jing-loan-withdraw-funds"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
