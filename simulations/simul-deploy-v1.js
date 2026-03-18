import fs from "node:fs";
import { ClarityVersion } from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";

async function main() {
  const stxSource = fs.readFileSync("./contracts/deployed/sbtc-stx-jingswap.clar", "utf8");
  const usdcxSource = fs.readFileSync("./contracts/deployed/sbtc-usdcx-jingswap.clar", "utf8");

  console.log("=== DEPLOY V1 CONTRACTS - STXER SIMULATION ===\n");

  const sessionId = await SimulationBuilder.new()
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "sbtc-stx-jingswap-v1",
      source_code: stxSource,
      clarity_version: ClarityVersion.Clarity4,
    })
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "sbtc-usdcx-jingswap-v1",
      source_code: usdcxSource,
      clarity_version: ClarityVersion.Clarity4,
    })
    .run();

  console.log("\nSimulation submitted!");
  console.log(`View results: https://stxer.xyz/simulations/mainnet/${sessionId}`);
}

main().catch(console.error);
