// simul-priority-queue.js
// Stxer simulation: test priority queue bumping with MAX_DEPOSITORS=5
// Deploys a variant with MAX_DEPOSITORS u5 to test bumping with 5+1 depositors.
//
// Run: npx tsx simulations/simul-priority-queue.js
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

// 8 unique mainnet addresses (need 5 to fill + 3 for bumping tests)
const ADDR = [
  "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX", // 0
  "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH", // 1
  "SP0CM9M95MVJ375V6DAM0G63795VAYGPZ9T0CC1N", // 2
  "SP0DJ8T0VQRP06JP4NNK37RF9VC1FBVHK2JH1SA5", // 3
  "SP119GF8QD57784VCS9SGV7YXS18ZAKSHG5WR3JSC", // 4 (smallest depositor)
  "SP12G0X9066S6F10KVT8JDEMGPHTQEADKZN95QD1F", // 5 (bumper - too small)
  "SP12R1YBVRXPNY44RWHYWPG522GVSGXTV8WH803BM", // 6 (bumper - big enough)
  "SP12STXCGN1TR6XRA3BCWT15R8QMBY7NSKQFFH93F", // 7 (sbtc bumper - big)
];

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const STX_NORMAL = 2_000_000; // 2 STX
const STX_SMALLEST = 1_000_000; // 1 STX (min)
const STX_BUMPER_FAIL = 500_000; // 0.5 STX (below min, should fail)
const STX_BUMPER_OK = 3_000_000; // 3 STX (bigger, bumps smallest)

const SBTC_NORMAL = 2_000; // 2000 sats
const SBTC_SMALLEST = 1_000; // 1000 sats (min)
const SBTC_BUMPER_FAIL = 500; // below min
const SBTC_BUMPER_OK = 3_000; // bumps smallest

async function main() {
  // Read stxer variant and patch MAX_DEPOSITORS to u5
  let source = fs.readFileSync("./contracts/blind-auction-stxer.clar", "utf8");
  source = source.replace(
    "(define-constant MAX_DEPOSITORS u50)",
    "(define-constant MAX_DEPOSITORS u5)"
  );

  console.log("=== PRIORITY QUEUE BUMPING TEST (MAX_DEPOSITORS=5) ===\n");
  console.log("STX side: 4 x 2 STX + 1 x 1 STX (smallest) = queue full");
  console.log("  → 6th with 0.5 STX should FAIL (ERR_DEPOSIT_TOO_SMALL)");
  console.log("  → 6th with 3 STX should SUCCEED (bumps 1 STX depositor)");
  console.log("sBTC side: same pattern with sats");
  console.log("Then close → settle → verify cycle 1 rollover");
  console.log("");

  let sim = SimulationBuilder.new()
    // Deploy with MAX_DEPOSITORS=5
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    });

  // Fund all 8 addresses with STX
  for (const addr of ADDR) {
    sim = sim
      .withSender(STX_FUNDER)
      .addSTXTransfer({ recipient: addr, amount: 10_000_000 });
  }

  // Fund all 8 addresses with sBTC
  for (const addr of ADDR) {
    sim = sim.withSender(SBTC_WHALE).addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(10_000),
        principalCV(SBTC_WHALE),
        principalCV(addr),
        noneCV(),
      ],
    });
  }

  // ---- Fill STX queue (5 slots) ----
  // Depositors 0-3: 2 STX each
  for (let i = 0; i < 4; i++) {
    sim = sim.withSender(ADDR[i]).addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_NORMAL)],
    });
  }
  // Depositor 4: 1 STX (smallest)
  sim = sim.withSender(ADDR[4]).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-stx",
    function_args: [uintCV(STX_SMALLEST)],
  });

  // ---- Fill sBTC queue (5 slots) ----
  for (let i = 0; i < 4; i++) {
    sim = sim.withSender(ADDR[i]).addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_NORMAL)],
    });
  }
  sim = sim.withSender(ADDR[4]).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-sbtc",
    function_args: [uintCV(SBTC_SMALLEST)],
  });

  // Read: queue should be full (5 each)
  sim = sim
    .addEvalCode(CONTRACT_ID, "(len (get-stx-depositors u0))")
    .addEvalCode(CONTRACT_ID, "(len (get-sbtc-depositors u0))")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)");

  // ---- 6th STX: too small → should FAIL (ERR_DEPOSIT_TOO_SMALL since < min) ----
  sim = sim.withSender(ADDR[5]).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-stx",
    function_args: [uintCV(STX_BUMPER_FAIL)],
  });

  // ---- 6th STX: 3 STX → should SUCCEED, bumps ADDR[4] (1 STX) ----
  sim = sim.withSender(ADDR[6]).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-stx",
    function_args: [uintCV(STX_BUMPER_OK)],
  });

  // ---- 6th sBTC: too small → should FAIL ----
  sim = sim.withSender(ADDR[5]).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-sbtc",
    function_args: [uintCV(SBTC_BUMPER_FAIL)],
  });

  // ---- 6th sBTC: 3000 sats → should SUCCEED, bumps ADDR[4] ----
  sim = sim.withSender(ADDR[7]).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-sbtc",
    function_args: [uintCV(SBTC_BUMPER_OK)],
  });

  // Verify bumping results
  sim = sim
    .addEvalCode(CONTRACT_ID, "(len (get-stx-depositors u0))") // still 5
    .addEvalCode(CONTRACT_ID, "(len (get-sbtc-depositors u0))") // still 5
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u0 '${ADDR[4]})`
    ) // bumped → 0
    .addEvalCode(
      CONTRACT_ID,
      `(get-stx-deposit u0 '${ADDR[6]})`
    ) // new → 3 STX
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u0 '${ADDR[4]})`
    ) // bumped → 0
    .addEvalCode(
      CONTRACT_ID,
      `(get-sbtc-deposit u0 '${ADDR[7]})`
    ) // new → 3000 sats
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)"); // totals updated

  // Close + settle
  sim = sim
    .withSender(STX_FUNDER)
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

  // Read settlement + cycle 1 rollover
  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)");

  const sessionId = await sim.run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
