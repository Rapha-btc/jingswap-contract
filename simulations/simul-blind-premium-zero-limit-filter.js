// simul-blind-premium-zero-limit-filter.js
// Stxer simulation: test per-depositor limit-price filtering
//
// Tests:
// 1. Depositor A: STX with tight limit (below expected clearing) -> should be ROLLED
// 2. Depositor B: STX with permissive limit -> should FILL
// 3. Depositor C: sBTC with tight limit (above expected clearing) -> should be ROLLED
// 4. Depositor D: sBTC with permissive limit -> should FILL
// 5. Verify rolled depositors appear in cycle 1 with deposits + limits intact
// 6. Test set-stx-limit / set-sbtc-limit to adjust limits mid-cycle
// 7. Test u0 limit rejection (ERR_LIMIT_REQUIRED)
//
// Expected clearing: oracle_price * (10000 - 20) / 10000
// With BTC ~$84k, STX ~$0.27: oracle ~311,111 STX/BTC (8 decimals = 31111100000000)
// Clearing = ~31048800000000 (20 bps below oracle)
//
// Run: npx tsx simulations/simul-blind-premium-zero-limit-filter.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-premium-zero`;

const STX_FUNDER = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const ADDR_A = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX"; // STX tight limit
const ADDR_B = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH"; // STX permissive
const ADDR_C = "SP0CM9M95MVJ375V6DAM0G63795VAYGPZ9T0CC1N"; // sBTC tight limit
const ADDR_D = "SP0DJ8T0VQRP06JP4NNK37RF9VC1FBVHK2JH1SA5"; // sBTC permissive

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const STX_10 = 10_000_000; // 10 STX
const SBTC_10K = 10_000; // 10k sats

// STX side limit: max STX-per-sBTC they'll pay (8 decimals)
// Tight: way below any real clearing -> will be rolled
const LIMIT_STX_TIGHT = 1_000_000_000; // ~10 STX/BTC (way too low)
// Permissive: way above any clearing -> will fill
const LIMIT_STX_PERMISSIVE = 99_999_999_999_999;

// sBTC side limit: min STX-per-sBTC they'll accept (8 decimals)
// Tight: way above any real clearing -> will be rolled
const LIMIT_SBTC_TIGHT = 99_999_999_999_999; // wants absurdly high price
// Permissive: way below any clearing -> will fill
const LIMIT_SBTC_PERMISSIVE = 1;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-premium-zero-stxer.clar",
    "utf8"
  );

  console.log("=== BLIND PREMIUM - LIMIT-PRICE FILTER TEST ===\n");
  console.log("ADDR_A: STX deposit, tight limit (too low) -> expect ROLL");
  console.log("ADDR_B: STX deposit, permissive limit -> expect FILL");
  console.log("ADDR_C: sBTC deposit, tight limit (too high) -> expect ROLL");
  console.log("ADDR_D: sBTC deposit, permissive limit -> expect FILL");
  console.log("Then: test set-*-limit, test u0 rejection");
  console.log("");

  let sim = SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium-zero",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    });

  // Fund addresses
  for (const addr of [ADDR_A, ADDR_B, ADDR_C, ADDR_D]) {
    sim = sim
      .withSender(STX_FUNDER)
      .addSTXTransfer({ recipient: addr, amount: 50_000_000 });
    sim = sim.withSender(SBTC_WHALE).addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(50_000),
        principalCV(SBTC_WHALE),
        principalCV(addr),
        noneCV(),
      ],
    });
  }

  // ---- Deposits with different limits ----

  // ADDR_A: STX with tight limit (will be rolled)
  sim = sim.withSender(ADDR_A).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-stx",
    function_args: [uintCV(STX_10), uintCV(LIMIT_STX_TIGHT)],
  });

  // ADDR_B: STX with permissive limit (will fill)
  sim = sim.withSender(ADDR_B).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-stx",
    function_args: [uintCV(STX_10), uintCV(LIMIT_STX_PERMISSIVE)],
  });

  // ADDR_C: sBTC with tight limit (will be rolled)
  sim = sim.withSender(ADDR_C).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-sbtc",
    function_args: [uintCV(SBTC_10K), uintCV(LIMIT_SBTC_TIGHT)],
  });

  // ADDR_D: sBTC with permissive limit (will fill)
  sim = sim.withSender(ADDR_D).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-sbtc",
    function_args: [uintCV(SBTC_10K), uintCV(LIMIT_SBTC_PERMISSIVE)],
  });

  // Read state
  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(CONTRACT_ID, `(get-stx-limit '${ADDR_A})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-limit '${ADDR_B})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-limit '${ADDR_C})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-limit '${ADDR_D})`);

  // ---- Test set-stx-limit: ADDR_B updates their limit ----
  sim = sim.withSender(ADDR_B).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "set-stx-limit",
    function_args: [uintCV(50_000_000_000_000)], // ~500k STX/BTC
  });

  // Verify updated
  sim = sim.addEvalCode(CONTRACT_ID, `(get-stx-limit '${ADDR_B})`);

  // ---- Test u0 limit rejection ----
  sim = sim.withSender(ADDR_B).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "set-stx-limit",
    function_args: [uintCV(0)], // should fail ERR_LIMIT_REQUIRED (u1017)
  });

  // ---- Test deposit with u0 limit ----
  sim = sim.withSender(ADDR_A).addContractCall({
    contract_id: CONTRACT_ID,
    function_name: "deposit-stx",
    function_args: [uintCV(STX_10), uintCV(0)], // should fail ERR_LIMIT_REQUIRED
  });

  // ---- Close + settle ----
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

  // Read settlement
  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)");

  // ---- Verify rolled depositors in cycle 1 ----
  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${ADDR_A})`) // rolled
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${ADDR_B})`) // filled -> 0
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${ADDR_C})`) // rolled
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${ADDR_D})`) // filled -> 0
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)")
    // Limits should persist for rolled depositors
    .addEvalCode(CONTRACT_ID, `(get-stx-limit '${ADDR_A})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-limit '${ADDR_C})`);

  const sessionId = await sim.run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
