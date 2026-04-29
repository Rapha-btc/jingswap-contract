// simul-v3-blind-auction.js
// Stxer mainnet fork simulation: full lifecycle of the v3 generic blind-auction
// template, initialized for the sBTC/USDCx pair against the Pyth BTC/USD feed.
// Mirrors simul-blind-auction-usdcx.js but adapted for v3's:
//  - generic function names (deposit-token-x / deposit-token-y / cancel-token-{x,y}-deposit)
//  - SIP-10 trait + asset-name args on every transferring call
//  - one-shot (initialize) before any deposit
//  - settle takes 4 trait/name args
//
// Run: npx tsx simulations/simul-v3-blind-auction.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  contractPrincipalCV,
  stringAsciiCV,
  bufferCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";

// --- Mainnet addresses ---
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
// USDCx whale: ~28.6k USDCx
const USDCX_DEPOSITOR_1 = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
// sBTC whale: ~40.5 BTC
const SBTC_DEPOSITOR_1 = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

// --- SIP-10 token contracts ---
// token-x = sBTC (8 decimals)
const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_NAME = "sbtc-token";
const SBTC_ASSET_NAME = "sbtc-token";
// token-y = USDCx (6 decimals)
const USDCX_ADDR = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_NAME = "usdcx";
const USDCX_ASSET_NAME = "usdcx-token";

// --- Pyth BTC/USD feed identifier ---
const BTC_USD_FEED_HEX =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const CONTRACT_NAME = "token-x-token-y-jing-v3";
const CONTRACT_ID = `${DEPLOYER}.${CONTRACT_NAME}`;

// --- Amounts ---
const SBTC_100K = 100_000;        // 0.001 BTC
const USDCX_100 = 100_000_000;    // 100 USDCx
const USDCX_50 = 50_000_000;      // 50 USDCx

// --- Min deposits at init ---
const MIN_SBTC = 1000;            // 1000 sats
const MIN_USDCX = 1_000_000;      // 1 USDC

// --- Limit prices (BTC/USD * 1e8 scale, Pyth) ---
// Set USDCx limit very high (depositor accepts any clearing) -- u1e15 is well
// above any plausible BTC/USD * 1e8.
const USDCX_LIMIT_HIGH = 1_000_000_000_000_000;
// Set sBTC limit at u1 (depositor accepts any clearing).
const SBTC_LIMIT_LOW = 1;

// --- ClarityValue helpers ---
const sbtcTrait = contractPrincipalCV(SBTC_ADDR, SBTC_NAME);
const usdcxTrait = contractPrincipalCV(USDCX_ADDR, USDCX_NAME);
const sbtcAsset = stringAsciiCV(SBTC_ASSET_NAME);
const usdcxAsset = stringAsciiCV(USDCX_ASSET_NAME);
const feedBuf = bufferCV(Buffer.from(BTC_USD_FEED_HEX, "hex"));

async function main() {
  const source = fs.readFileSync(
    "./contracts/v3/token-x-token-y-jing-v3-stxer.clar",
    "utf8"
  );
  const jingCoreSource = fs.readFileSync(
    "./contracts/jing-core.clar",
    "utf8"
  );

  console.log("=== V3 GENERIC AUCTION - SBTC/USDCX FULL LIFECYCLE STXER SIM ===\n");
  console.log("Scenario:");
  console.log("0.  Deploy jing-core (registry dep -- not yet on mainnet)");
  console.log("1.  Deploy v3 (zeroed CANCEL_THRESHOLD)");
  console.log("2.  Initialize: token-x=sBTC, token-y=USDCx, feed=BTC/USD");
  console.log("3.  USDCx depositor deposits 100 USDCx (limit-price = 1e15)");
  console.log("4.  sBTC depositor deposits 100k sats (limit-price = 1)");
  console.log("5.  Read cycle state");
  console.log("6.  USDCx depositor top-up +50 USDCx");
  console.log("7.  Close deposits");
  console.log("8.  Settle using stored Pyth prices");
  console.log("9.  Read settlement results");
  console.log("10. Verify cycle advanced to 1");
  console.log("11. Read rollover state");
  console.log("");

  const sessionId = await SimulationBuilder.new()
    // STEP 0: Deploy jing-core (registry the v3 contract calls into)
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: "jing-core",
      source_code: jingCoreSource,
      clarity_version: ClarityVersion.Clarity4,
    })

    // STEP 1: Deploy v3 stxer variant
    .withSender(DEPLOYER)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: source,
      clarity_version: ClarityVersion.Clarity4,
    })

    // STEP 1.5: Approve v3 in jing-core's market allowlist (else log-* calls
    // fail with ERR_NOT_APPROVED_MARKET (err u5004))
    .withSender(DEPLOYER)
    .addContractCall({
      contract_id: `${DEPLOYER}.jing-core`,
      function_name: "approve-market",
      function_args: [contractPrincipalCV(DEPLOYER, CONTRACT_NAME)],
    })

    // STEP 2: Initialize -- operator (deployer) sets token pair + min deposits + feed
    .withSender(DEPLOYER)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "initialize",
      function_args: [
        sbtcTrait,                  // x = sBTC
        usdcxTrait,                 // y = USDCx
        uintCV(MIN_SBTC),           // min-x = 1000 sats
        uintCV(MIN_USDCX),          // min-y = 1 USDC
        feedBuf,                    // BTC/USD Pyth feed id
      ],
    })

    // STEP 3: USDCx depositor deposits 100 USDCx
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-token-y",
      function_args: [
        uintCV(USDCX_100),
        uintCV(USDCX_LIMIT_HIGH),
        usdcxTrait,
        usdcxAsset,
      ],
    })

    // STEP 4: sBTC depositor deposits 100k sats
    .withSender(SBTC_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-token-x",
      function_args: [
        uintCV(SBTC_100K),
        uintCV(SBTC_LIMIT_LOW),
        sbtcTrait,
        sbtcAsset,
      ],
    })

    // STEP 5: Read cycle state after deposits
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-token-y-deposit u0 '${USDCX_DEPOSITOR_1})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-token-x-deposit u0 '${SBTC_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u0)")
    .addEvalCode(CONTRACT_ID, "(get-token-x-depositors u0)")

    // STEP 6: USDCx depositor top-up +50 USDCx
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "deposit-token-y",
      function_args: [
        uintCV(USDCX_50),
        uintCV(USDCX_LIMIT_HIGH),
        usdcxTrait,
        usdcxAsset,
      ],
    })

    // Read updated deposit
    .addEvalCode(
      CONTRACT_ID,
      `(get-token-y-deposit u0 '${USDCX_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u0)")

    // STEP 7: Close deposits
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "close-deposits",
      function_args: [],
    })

    // Read phase (should be SETTLE)
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // STEP 8: Settle using stored Pyth prices
    .withSender(USDCX_DEPOSITOR_1)
    .addContractCall({
      contract_id: CONTRACT_ID,
      function_name: "settle",
      function_args: [
        sbtcTrait,                  // tx-trait
        sbtcAsset,                  // tx-name
        usdcxTrait,                 // ty-trait
        usdcxAsset,                 // ty-name
      ],
    })

    // STEP 9: Read settlement results
    .addEvalCode(CONTRACT_ID, "(get-settlement u0)")
    .addEvalCode(CONTRACT_ID, "(get-current-cycle)")
    .addEvalCode(CONTRACT_ID, "(get-cycle-phase)")

    // STEP 10: Verify cycle 1 rollover state
    .addEvalCode(CONTRACT_ID, "(get-cycle-totals u1)")
    .addEvalCode(
      CONTRACT_ID,
      `(get-token-x-deposit u1 '${SBTC_DEPOSITOR_1})`
    )
    .addEvalCode(
      CONTRACT_ID,
      `(get-token-y-deposit u1 '${USDCX_DEPOSITOR_1})`
    )
    .addEvalCode(CONTRACT_ID, "(get-token-y-depositors u1)")
    .addEvalCode(CONTRACT_ID, "(get-token-x-depositors u1)")

    .run();

  console.log(`\nSimulation submitted!`);
  console.log(
    `View results: https://stxer.xyz/simulations/mainnet/${sessionId}`
  );
}

main().catch(console.error);
