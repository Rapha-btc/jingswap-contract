// simul-dust-rollover.js
// Stxer mainnet fork simulation: dust deposit rollover protection
//
// Tests that depositors with tiny amounts (dust) don't lose their funds
// when pro-rata shares round to 0 during settlement.
//
// Scenario: sBTC side has a dust depositor (43 sats) alongside a whale (5M sats).
// STX side has a small deposit. After settlement, the dust depositor's shares
// round to 0 — the fix rolls their entire deposit to the next cycle.
//
// Run: npx tsx simulations/simul-dust-rollover.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Mainnet addresses ---
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
// STX depositor (small deposit to make sBTC side binding)
const STX_DEPOSITOR = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
// sBTC whale: big deposit
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
// sBTC dust depositor: tiny deposit (simulated via a different mainnet address)
const SBTC_DUST = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";

const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

// Amounts
const STX_1 = 1_000_000;       // 1 STX — tiny to make sBTC binding side small
const SBTC_5M = 5_000_000;     // 5M sats (0.05 BTC) — whale
const SBTC_DUST_AMT = 43;      // 43 sats — dust

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer.clar",
    "utf8"
  );

  console.log("=== DUST ROLLOVER PROTECTION SIMULATION ===\n");
  console.log("Tests that dust depositors don't lose funds to rounding.\n");
  console.log("Setup:");
  console.log(`  STX side:  ${STX_DEPOSITOR} deposits ${STX_1 / 1e6} STX`);
  console.log(`  sBTC whale: ${SBTC_WHALE} deposits ${SBTC_5M} sats`);
  console.log(`  sBTC dust:  ${SBTC_DUST} deposits ${SBTC_DUST_AMT} sats`);
  console.log("");
  console.log("Expected after settlement:");
  console.log("  - Whale gets pro-rata STX share (non-zero)");
  console.log("  - Dust depositor's shares round to 0");
  console.log("  - WITH fix: dust depositor's 43 sats roll to cycle 1");
  console.log("  - WITHOUT fix: dust depositor's 43 sats would vanish");
  console.log("");

  // First, fund the dust depositor with sBTC from the whale
  // Then proceed with deposits
  const sessionId = await SimulationBuilder.new()
    // ============================================================
    // STEP 1: Deploy blind-auction (stxer variant)
    // ============================================================
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ============================================================
    // STEP 2: Fund dust depositor with sBTC from whale
    // ============================================================
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
      function_name: "transfer",
      function_args: [
        uintCV(SBTC_DUST_AMT),
        principalCV(SBTC_WHALE),
        principalCV(SBTC_DUST),
        noneCV(),
      ],
    })

    // ============================================================
    // STEP 3: Deposits
    // ============================================================
    // STX depositor: 1 STX
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_1)],
    })

    // sBTC whale: 5M sats
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_5M)],
    })

    // sBTC dust: 43 sats
    .withSender(SBTC_DUST)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_DUST_AMT)],
    })

    // ============================================================
    // STEP 4: Verify deposits
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u0 '${SBTC_WHALE})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u0 '${SBTC_DUST})`)
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u0)")

    // ============================================================
    // STEP 5: Close deposits + settle
    // ============================================================
    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    .withSender(STX_DEPOSITOR)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    })

    // ============================================================
    // STEP 6: Read settlement record
    // ============================================================
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")

    // ============================================================
    // STEP 7: Check dust depositor's state after settlement
    // Key check: did 43 sats roll to cycle 1 or vanish?
    // ============================================================
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u0 '${SBTC_DUST})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_DUST})`)
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")

    // ============================================================
    // STEP 8: Check whale's state (should have received STX)
    // ============================================================
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u0 '${SBTC_WHALE})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_WHALE})`)

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
  console.log("");
  console.log("What to verify in the results:");
  console.log("  1. Settlement succeeds (ok true)");
  console.log(`  2. Dust depositor (${SBTC_DUST}):`);
  console.log("     - Cycle 0 deposit = 0 (cleared)");
  console.log(`     - Cycle 1 deposit = ${SBTC_DUST_AMT} (rolled, not lost!)`);
  console.log("     - Appears in cycle 1 depositor list");
  console.log(`  3. Whale (${SBTC_WHALE}):`);
  console.log("     - Cycle 0 deposit = 0 (cleared)");
  console.log("     - Received STX (check events)");
  console.log("     - Unfilled sBTC rolled to cycle 1");
}

main().catch(console.error);
