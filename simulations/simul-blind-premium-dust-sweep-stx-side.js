// simul-blind-premium-dust-sweep-stx-side.js
// Stxer simulation: verify dust sweep on STX side (sBTC is binding)
// Heavy STX vs light sBTC so sBTC is binding side → large STX unfilled → STX roll dust.
// Ported from simul-dust-sweep-stx-side.js with limit-price args added.
//
// Run: npx tsx simulations/simul-blind-premium-dust-sweep-stx-side.js
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

const STX_D1 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const STX_D2 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";
const STX_D3 = "SP0CM9M95MVJ375V6DAM0G63795VAYGPZ9T0CC1N";
const SBTC_D1 = "SP0DJ8T0VQRP06JP4NNK37RF9VC1FBVHK2JH1SA5";
const SBTC_D2 = "SP119GF8QD57784VCS9SGV7YXS18ZAKSHG5WR3JSC";
const SBTC_D3 = "SP12G0X9066S6F10KVT8JDEMGPHTQEADKZN95QD1F";

const ALL_ADDRS = [STX_D1, STX_D2, STX_D3, SBTC_D1, SBTC_D2, SBTC_D3];
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Heavy STX side (~10,000 STX) vs light sBTC (4,000 sats)
// Forces sBTC to be binding side → large STX unfilled → STX roll dust
const STX_D1_AMOUNT = 3_333_333_333; // 3,333.333333 STX
const STX_D2_AMOUNT = 4_444_444_444; // 4,444.444444 STX
const STX_D3_AMOUNT = 2_222_222_223; // 2,222.222223 STX
// Total STX: 10,000,000,000 (10,000 STX)

const SBTC_D1_AMOUNT = 1_333; // sats
const SBTC_D2_AMOUNT = 1_444; // sats
const SBTC_D3_AMOUNT = 1_223; // sats
// Total sBTC: 4,000 sats

const LIMIT_STX = 99_999_999_999_999;
const LIMIT_SBTC = 1;

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-premium-stxer.clar",
    "utf8"
  );

  console.log("=== BLIND PREMIUM - DUST SWEEP (STX SIDE / sBTC BINDING) ===\n");
  console.log("3 STX depositors: ~3,333 / ~4,444 / ~2,222 STX (total ~10k STX)");
  console.log("3 sBTC depositors: 1,333 / 1,444 / 1,223 sats (total 4,000 sats)");
  console.log("sBTC is binding → most STX unfilled → STX roll dust expected.");
  console.log("Premium clearing (20 bps) shifts the STX-cleared amount.\n");

  let sim = SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-premium",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    });

  // Fund all addresses
  for (const addr of ALL_ADDRS) {
    sim = sim
      .withSender(STX_FUNDER)
      .addSTXTransfer({ recipient: addr, amount: 5_000_000_000 });
  }
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

  // Deposits: 3 STX depositors
  sim = sim
    .withSender(STX_D1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_D1_AMOUNT), uintCV(LIMIT_STX)],
    })
    .withSender(STX_D2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_D2_AMOUNT), uintCV(LIMIT_STX)],
    })
    .withSender(STX_D3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_D3_AMOUNT), uintCV(LIMIT_STX)],
    });

  // Deposits: 3 sBTC depositors
  sim = sim
    .withSender(SBTC_D1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_D1_AMOUNT), uintCV(LIMIT_SBTC)],
    })
    .withSender(SBTC_D2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_D2_AMOUNT), uintCV(LIMIT_SBTC)],
    })
    .withSender(SBTC_D3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-sbtc",
      function_args: [uintCV(SBTC_D3_AMOUNT), uintCV(LIMIT_SBTC)],
    });

  sim = sim.addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)");

  // Close + settle
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

  // Read settlement + cycle 1
  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_D1})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_D2})`)
    .addEvalCode(CONTRACT_ID, `(get-stx-deposit u1 '${STX_D3})`)
    .addEvalCode(CONTRACT_ID, "(get-stx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)");

  const sessionId = await sim.run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
  console.log("\nWhat to verify:");
  console.log("1. sweep-dust event should show stx-dust > 0 (STX side truncation)");
  console.log("2. cycle 1 STX totals = sum of individual rolled STX deposits");
  console.log("3. sBTC depositors fully filled (sBTC is binding)");
}

main().catch(console.error);
