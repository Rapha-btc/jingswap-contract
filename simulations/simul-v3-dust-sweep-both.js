// simul-v3-dust-sweep-both.js
// Stxer simulation: dust sweep on USDCx side (sBTC binding) for v3.
// Heavy USDCx vs light sBTC → large USDCx unfilled → USDCx roll dust expected.
//
// Run: npx tsx simulations/simul-v3-dust-sweep-both.js
import fs from "node:fs";
import {
  ClarityVersion, uintCV, contractPrincipalCV, stringAsciiCV, bufferCV,
  principalCV, noneCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const CONTRACT_NAME = "token-x-token-y-jing-v3";
const CONTRACT_ID = `${DEPLOYER}.${CONTRACT_NAME}`;

const STX_FUNDER = "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3";
const USDCX_WHALE = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_NAME = "sbtc-token";
const USDCX_ADDR = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_NAME = "usdcx";
const USDCX_TOKEN = `${USDCX_ADDR}.${USDCX_NAME}`;
const SBTC_TOKEN = `${SBTC_ADDR}.${SBTC_NAME}`;
const BTC_USD_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const USDCX_D1 = "SP06ARSREC0N9AKZABRP23SXS62TWJ6KWPVDQHVX";
const USDCX_D2 = "SP08YG111N936KQXZDR6A63857NN3PFSTWS9HFHH";
const USDCX_D3 = "SP0CM9M95MVJ375V6DAM0G63795VAYGPZ9T0CC1N";
const SBTC_D1 = "SP0DJ8T0VQRP06JP4NNK37RF9VC1FBVHK2JH1SA5";
const SBTC_D2 = "SP119GF8QD57784VCS9SGV7YXS18ZAKSHG5WR3JSC";
const SBTC_D3 = "SP12G0X9066S6F10KVT8JDEMGPHTQEADKZN95QD1F";
const ALL_ADDRS = [USDCX_D1, USDCX_D2, USDCX_D3, SBTC_D1, SBTC_D2, SBTC_D3];

// Heavy USDCx (~100 USDCx, scaled down 100x to fit current whale balance ~832 USDCx)
// vs light sBTC (4k sats) — sBTC binding
const USDCX_AMOUNTS = [33_333_333, 44_444_444, 22_222_223];
const SBTC_AMOUNTS = [1_333, 1_444, 1_223];

const MIN_SBTC = 1000;
const MIN_USDCX = 1_000_000;
const USDCX_LIMIT_HIGH = 1_000_000_000_000_000;
const SBTC_LIMIT_LOW = 1;

const sbtcTrait = contractPrincipalCV(SBTC_ADDR, SBTC_NAME);
const usdcxTrait = contractPrincipalCV(USDCX_ADDR, USDCX_NAME);
const sbtcAsset = stringAsciiCV("sbtc-token");
const usdcxAsset = stringAsciiCV("usdcx-token");
const feedBuf = bufferCV(Buffer.from(BTC_USD_FEED_HEX, "hex"));

async function main() {
  const source = fs.readFileSync("./contracts/v3/token-x-token-y-jing-v3-stxer.clar", "utf8");
  const jingCoreSource = fs.readFileSync("./contracts/jing-core.clar", "utf8");

  console.log("=== V3 DUST SWEEP - USDCx SIDE BINDING ===\n");

  let sim = SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({ contract_name: "jing-core", source_code: jingCoreSource, clarity_version: ClarityVersion.Clarity4 })
    .addContractDeploy({ contract_name: CONTRACT_NAME, source_code: source, clarity_version: ClarityVersion.Clarity4 })
    .addContractCall({
      contract_id: `${DEPLOYER}.jing-core`, function_name: "approve-market",
      function_args: [contractPrincipalCV(DEPLOYER, CONTRACT_NAME)],
    })
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "initialize",
      function_args: [sbtcTrait, usdcxTrait, uintCV(MIN_SBTC), uintCV(MIN_USDCX), feedBuf],
    });

  // STX gas for everyone
  for (const addr of ALL_ADDRS) {
    sim = sim.withSender(STX_FUNDER).addSTXTransfer({ recipient: addr, amount: 10_000_000 });
  }
  // Only fund USDCx fish with USDCx (50 USDCx each = 150 USDCx total, fits in whale)
  for (const addr of [USDCX_D1, USDCX_D2, USDCX_D3]) {
    sim = sim.withSender(USDCX_WHALE).addContractCall({
      contract_id: USDCX_TOKEN, function_name: "transfer",
      function_args: [uintCV(50_000_000), principalCV(USDCX_WHALE), principalCV(addr), noneCV()],
    });
  }
  // Only fund sBTC fish with sBTC
  for (const addr of [SBTC_D1, SBTC_D2, SBTC_D3]) {
    sim = sim.withSender(SBTC_WHALE).addContractCall({
      contract_id: SBTC_TOKEN, function_name: "transfer",
      function_args: [uintCV(10_000), principalCV(SBTC_WHALE), principalCV(addr), noneCV()],
    });
  }

  for (const [i, addr] of [USDCX_D1, USDCX_D2, USDCX_D3].entries()) {
    sim = sim.withSender(addr).addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-y",
      function_args: [uintCV(USDCX_AMOUNTS[i]), uintCV(USDCX_LIMIT_HIGH), usdcxTrait, usdcxAsset],
    });
  }
  for (const [i, addr] of [SBTC_D1, SBTC_D2, SBTC_D3].entries()) {
    sim = sim.withSender(addr).addContractCall({
      contract_id: CONTRACT_ID, function_name: "deposit-token-x",
      function_args: [uintCV(SBTC_AMOUNTS[i]), uintCV(SBTC_LIMIT_LOW), sbtcTrait, sbtcAsset],
    });
  }

  sim = sim
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .withSender(USDCX_D1)
    .addContractCall({ contract_id: CONTRACT_ID, function_name: "close-deposits", function_args: [] })
    .addContractCall({
      contract_id: CONTRACT_ID, function_name: "settle",
      function_args: [sbtcTrait, sbtcAsset, usdcxTrait, usdcxAsset],
    })
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${USDCX_D1})`)
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${USDCX_D2})`)
    .addEvalCode(CONTRACT_ID, `(get-token-y-deposit u1 '${USDCX_D3})`)
    .addEvalCode(CONTRACT_ID, `(get-token-x-deposit u1 '${SBTC_D1})`)
    .addEvalCode(CONTRACT_ID, `(get-token-x-deposit u1 '${SBTC_D2})`)
    .addEvalCode(CONTRACT_ID, `(get-token-x-deposit u1 '${SBTC_D3})`)
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-token-x-depositors u1)");

  const sessionId = await sim.run();
  console.log(`\nSimulation submitted!`);
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
