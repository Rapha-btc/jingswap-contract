// simul-dust-sweep.js
// Stxer simulation: verify dust sweep after settlement
// Uses 3 depositors per side with amounts designed to produce truncation dust.
// Checks that roll-and-sweep-dust event fires and cycle 1 totals are exact.
//
// Run: npx tsx simulations/simul-dust-sweep.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-auction`;

const STX_FUNDER = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

// 3 STX depositors, 3 sBTC depositors (6 unique addresses)
const STX_D1 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const STX_D2 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";
const STX_D3 = "SP0CM9M95MVJ375V6DAM0G63795VAYGPZ9T0CC1N";
const SBTC_D1 = "SP0DJ8T0VQRP06JP4NNK37RF9VC1FBVHK2JH1SA5";
const SBTC_D2 = "SP119GF8QD57784VCS9SGV7YXS18ZAKSHG5WR3JSC";
const SBTC_D3 = "SP12G0X9066S6F10KVT8JDEMGPHTQEADKZN95QD1F";

const ALL_ADDRS = [STX_D1, STX_D2, STX_D3, SBTC_D1, SBTC_D2, SBTC_D3];

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Amounts chosen to maximize truncation: primes and odd numbers
// so pro-rata divisions don't come out even
const STX_D1_AMOUNT = 33_333_333; // 33.333333 STX
const STX_D2_AMOUNT = 44_444_444; // 44.444444 STX
const STX_D3_AMOUNT = 22_222_223; // 22.222223 STX
// Total STX: 100,000,000 (100 STX)

const SBTC_D1_AMOUNT = 33_333; // sats
const SBTC_D2_AMOUNT = 44_444; // sats
const SBTC_D3_AMOUNT = 22_223; // sats
// Total sBTC: 100,000 sats

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer.clar",
    "utf8"
  );

  console.log("=== DUST SWEEP VERIFICATION ===\n");
  console.log("3 STX depositors: 33.333333 / 44.444444 / 22.222223 STX");
  console.log("3 sBTC depositors: 33,333 / 44,444 / 22,223 sats");
  console.log("Amounts chosen to maximize integer truncation dust.");
  console.log("After settlement, check sweep-dust event and cycle 1 totals.\n");

  let sim = SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    });

  // Fund all addresses with STX
  for (const addr of ALL_ADDRS) {
    sim = sim
      .withSender(STX_FUNDER)
      .addSTXTransfer({ recipient: addr, amount: 200_000_000 });
  }

  // Fund all addresses with sBTC
  for (const addr of ALL_ADDRS) {
    sim = sim.withSender(SBTC_WHALE).addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(100_000),
        principalCV(SBTC_WHALE),
        principalCV(addr),
        noneCV(),
      ],
    });
  }

  // ---- Deposits: 3 STX depositors ----
  sim = sim
    .withSender(STX_D1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_D1_AMOUNT)],
    })
    .withSender(STX_D2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_D2_AMOUNT)],
    })
    .withSender(STX_D3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_D3_AMOUNT)],
    });

  // ---- Deposits: 3 sBTC depositors ----
  sim = sim
    .withSender(SBTC_D1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_D1_AMOUNT)],
    })
    .withSender(SBTC_D2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_D2_AMOUNT)],
    })
    .withSender(SBTC_D3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_D3_AMOUNT)],
    });

  // ---- Verify totals ----
  sim = sim.addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)");

  // ---- Close + Settle (use depositor, not funder — avoids nonce mismatch) ----
  sim = sim
    .withSender(STX_D1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [],
    });

  // ---- Read settlement + verify cycle 1 state ----
  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    // Individual rolled deposits in cycle 1
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_D1})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_D2})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_D3})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_D1})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_D2})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_D3})`)
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)");

  const sessionId = await sim.run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
  console.log("\nWhat to verify in results:");
  console.log("1. settle event should include sweep-dust with stx-dust and sbtc-dust > 0");
  console.log("2. cycle 1 totals should equal sum of individual rolled deposits (no inflation)");
  console.log("3. No orphaned dust left in contract");
}

main().catch(console.error);
