// simul-dust-sweep-usdcx-both.js
// Stxer simulation: verify dust sweep on USDCx side (sBTC is binding)
// Deposits heavy USDCx vs light sBTC so sBTC is binding side.
// 3 depositors per side with odd amounts → truncation dust on USDCx payout + USDCx roll.
//
// Run: npx tsx simulations/simul-dust-sweep-usdcx-both.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_ID = `${DEPLOYER}.blind-auction-usdcx`;

const STX_FUNDER = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const USDCX_WHALE = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const USDCX_TOKEN = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// 3 USDCx depositors, 3 sBTC depositors
const USDCX_D1 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const USDCX_D2 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";
const USDCX_D3 = "SP0CM9M95MVJ375V6DAM0G63795VAYGPZ9T0CC1N";
const SBTC_D1 = "SP0DJ8T0VQRP06JP4NNK37RF9VC1FBVHK2JH1SA5";
const SBTC_D2 = "SP119GF8QD57784VCS9SGV7YXS18ZAKSHG5WR3JSC";
const SBTC_D3 = "SP12G0X9066S6F10KVT8JDEMGPHTQEADKZN95QD1F";

const ALL_ADDRS = [USDCX_D1, USDCX_D2, USDCX_D3, SBTC_D1, SBTC_D2, SBTC_D3];

// Heavy USDCx side (~10,000 USDCx) vs light sBTC (4,000 sats = ~$3 at ~$75k/BTC)
// This forces sBTC to be binding, leaving large USDCx unfilled → USDCx roll dust.
const USDCX_D1_AMOUNT = 3_333_333_333; // 3,333.333333 USDCx
const USDCX_D2_AMOUNT = 4_444_444_444; // 4,444.444444 USDCx
const USDCX_D3_AMOUNT = 2_222_222_223; // 2,222.222223 USDCx
// Total USDCx: 10,000,000,000 (10,000 USDCx)

const SBTC_D1_AMOUNT = 1_333; // sats
const SBTC_D2_AMOUNT = 1_444; // sats
const SBTC_D3_AMOUNT = 1_223; // sats
// Total sBTC: 4,000 sats

async function main() {
  const source = fs.readFileSync(
    "./contracts/blind-auction-stxer-usdcx.clar",
    "utf8"
  );

  console.log("=== DUST SWEEP VERIFICATION — USDCx SIDE (sBTC BINDING) ===\n");
  console.log("3 USDCx depositors: 3,333.33 / 4,444.44 / 2,222.22 USDCx (total ~10,000 USDCx)");
  console.log("3 sBTC depositors: 1,333 / 1,444 / 1,223 sats (total 4,000 sats)");
  console.log("sBTC is binding → large USDCx unfilled → USDCx roll dust expected.\n");

  let sim = SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "blind-auction-usdcx",
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    });

  // Fund all addresses with STX (for gas)
  for (const addr of ALL_ADDRS) {
    sim = sim
      .withSender(STX_FUNDER)
      .addSTXTransfer({ recipient: addr, amount: 10_000_000 });
  }

  // Fund all addresses with USDCx
  for (const addr of ALL_ADDRS) {
    sim = sim.withSender(USDCX_WHALE).addContractCall({
      contract_id: USDCX_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(5_000_000_000), // 5,000 USDCx each
        principalCV(USDCX_WHALE),
        principalCV(addr),
        noneCV(),
      ],
    });
  }

  // Fund all addresses with sBTC
  for (const addr of ALL_ADDRS) {
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

  // ---- Deposits: 3 USDCx depositors (heavy) ----
  sim = sim
    .withSender(USDCX_D1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_D1_AMOUNT)],
    })
    .withSender(USDCX_D2)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_D2_AMOUNT)],
    })
    .withSender(USDCX_D3)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-usdcx",
      function_args: [uintCV(USDCX_D3_AMOUNT)],
    });

  // ---- Deposits: 3 sBTC depositors (light) ----
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
    .withSender(USDCX_D1)
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
    .addEvalCode(CONTRACT_ID, `(get-usdcx-deposit u1 '${USDCX_D1})`)
    .addEvalCode(CONTRACT_ID, `(get-usdcx-deposit u1 '${USDCX_D2})`)
    .addEvalCode(CONTRACT_ID, `(get-usdcx-deposit u1 '${USDCX_D3})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_D1})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_D2})`)
    .addEvalCode(CONTRACT_ID, `(get-sbtc-deposit u1 '${SBTC_D3})`)
    .addEvalCode(CONTRACT_ID, "(get-usdcx-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-sbtc-depositors u1)");

  const sessionId = await sim.run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
  console.log("\nWhat to verify in results:");
  console.log("1. sweep-dust event should show usdcx-dust > 0 (payout + roll)");
  console.log("2. cycle 1 total-usdcx = sum of individual rolled USDCx deposits (exact)");
  console.log("3. sBTC side fully cleared (sbtc-unfilled = 0)");
}

main().catch(console.error);
