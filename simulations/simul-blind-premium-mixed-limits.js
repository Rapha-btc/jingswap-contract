// simul-blind-premium-mixed-limits.js
// Stxer simulation: 5 depositors per side with varying limits
// Tests that pro-rata distribution only includes filled depositors,
// and rolled depositors' amounts are correctly excluded from settlement totals.
//
// STX side (5 depositors):
//   D0: 10 STX, tight limit (will be rolled)
//   D1: 20 STX, permissive limit (will fill)
//   D2: 30 STX, tight limit (will be rolled)
//   D3: 40 STX, permissive limit (will fill)
//   D4: 50 STX, permissive limit (will fill)
//   -> 3 fill (total 110 STX), 2 rolled (total 40 STX)
//
// sBTC side (5 depositors):
//   D0: 10k sats, permissive limit (will fill)
//   D1: 20k sats, tight limit (will be rolled)
//   D2: 30k sats, permissive limit (will fill)
//   D3: 40k sats, permissive limit (will fill)
//   D4: 50k sats, tight limit (will be rolled)
//   -> 3 fill (total 80k), 2 rolled (total 70k)
//
// Run: npx tsx simulations/simul-blind-premium-mixed-limits.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-premium`;

const STX_FUNDER = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

// 10 unique addresses (5 STX depositors, 5 sBTC depositors)
const STX_D = [
  "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX", // D0 tight
  "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH", // D1 permissive
  "SP0CM9M95MVJ375V6DAM0G63795VAYGPZ9T0CC1N", // D2 tight
  "SP0DJ8T0VQRP06JP4NNK37RF9VC1FBVHK2JH1SA5", // D3 permissive
  "SP119GF8QD57784VCS9SGV7YXS18ZAKSHG5WR3JSC", // D4 permissive
];
const SBTC_D = [
  "SP12G0X9066S6F10KVT8JDEMGPHTQEADKZN95QD1F", // D0 permissive
  "SP12R1YBVRXPNY44RWHYWPG522GVSGXTV8WH803BM", // D1 tight
  "SP12STXCGN1TR6XRA3BCWT15R8QMBY7NSKQFFH93F", // D2 permissive
  DEPLOYER,                                       // D3 permissive
  "SP1AE7DW1ZXBH983N89YY6VA5JKPFJWT89RFBPEAY", // D4 tight
];

const ALL_ADDRS = [...STX_D, ...SBTC_D];
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const STX_AMOUNTS = [10_000_000, 20_000_000, 30_000_000, 40_000_000, 50_000_000];
const SBTC_AMOUNTS = [10_000, 20_000, 30_000, 40_000, 50_000];

// Limits
const LIMIT_STX_TIGHT = 1_000_000_000;      // ~10 STX/BTC, way below clearing
const LIMIT_STX_PERMISSIVE = 99_999_999_999_999;
const LIMIT_SBTC_TIGHT = 99_999_999_999_999; // wants absurdly high min price
const LIMIT_SBTC_PERMISSIVE = 1;

// Which depositors get tight limits
const STX_TIGHT = [true, false, true, false, false];   // D0, D2 tight
const SBTC_TIGHT = [false, true, false, false, true];  // D1, D4 tight

async function main() {
  const source = fs.readFileSync("./contracts/blind-premium-stxer.clar", "utf8");

  console.log("=== BLIND PREMIUM - MIXED LIMITS (5 per side) ===\n");
  console.log("STX side: D0(10,tight) D1(20,ok) D2(30,tight) D3(40,ok) D4(50,ok)");
  console.log("  -> expect D0+D2 rolled (40 STX), D1+D3+D4 filled (110 STX)");
  console.log("sBTC side: D0(10k,ok) D1(20k,tight) D2(30k,ok) D3(40k,ok) D4(50k,tight)");
  console.log("  -> expect D1+D4 rolled (70k), D0+D2+D3 filled (80k)");
  console.log("Pro-rata distribution should only include filled depositors.\n");

  let sim = SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    });

  // Fund all addresses
  for (const addr of ALL_ADDRS) {
    sim = sim.withSender(STX_FUNDER).addSTXTransfer({ recipient: addr, amount: 200_000_000 });
  }
  for (const addr of ALL_ADDRS) {
    sim = sim.withSender(SBTC_WHALE).addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [uintCV(100_000), principalCV(SBTC_WHALE), principalCV(addr), noneCV()],
    });
  }

  // STX deposits with mixed limits
  for (let i = 0; i < 5; i++) {
    const limit = STX_TIGHT[i] ? LIMIT_STX_TIGHT : LIMIT_STX_PERMISSIVE;
    sim = sim.withSender(STX_D[i]).addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_AMOUNTS[i]), uintCV(limit)],
    });
  }

  // sBTC deposits with mixed limits
  for (let i = 0; i < 5; i++) {
    const limit = SBTC_TIGHT[i] ? LIMIT_SBTC_TIGHT : LIMIT_SBTC_PERMISSIVE;
    sim = sim.withSender(SBTC_D[i]).addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_AMOUNTS[i]), uintCV(limit)],
    });
  }

  // Read totals before settle
  sim = sim.addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)");

  // Close + settle
  sim = sim
    .withSender(STX_FUNDER)
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "close-deposits", function_args: [] })
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "settle", function_args: [] });

  // Settlement record
  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)");

  // Cycle 1: verify rolled vs filled
  sim = sim.addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)");

  // STX side: D0 rolled, D1 filled, D2 rolled, D3 filled, D4 filled
  for (let i = 0; i < 5; i++) {
    sim = sim.addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_D[i]})`);
  }

  // sBTC side: D0 filled (unfilled rolled), D1 rolled, D2 filled, D3 filled, D4 rolled
  for (let i = 0; i < 5; i++) {
    sim = sim.addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_D[i]})`);
  }

  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)");

  const sessionId = await sim.run();

  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
