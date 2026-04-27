// simul-loan-snpl-seize-rolled.js
// Stxer mainnet fork simulation: SEIZE path with REAL sBTC rollover.
//
// Companion to simul-loan-snpl-seize.js. Where that sim covers the
// sBTC-binding / full-clear case (snpl ends up holding STX), this one
// covers the inverse: the snpl is the rolling side. We borrow ~1 BTC
// (100M sats) and deposit it into Jing without adding any STX-side
// depositors. The pre-existing mainnet STX in the cycle (~191k STX at
// last check) can only absorb ~0.567 BTC at the clearing price, leaving
// the rest of the snpl's sBTC to roll forward to cycle N+1.
//
// Flow:
//   1.  LENDER deploys traits + reserve + snpl
//   2.  SBTC_WHALE -> LENDER (110M seed; LENDER mainnet balance is 0)
//   3.  LENDER initialize(s)
//   4.  LENDER supply 100M sBTC, open-credit-line(100M, 100bps)
//   5.  BORROWER borrow(100M, 100, reserve)
//   6.  BORROWER swap-deposit(1, LIMIT_PRICE)        [100M sats -> Jing cycle N]
//   7.  LENDER -> Jing.close-and-settle-with-refresh(VAA)
//        -> ~56.7M sats clears (binds against pre-existing STX)
//        -> snpl receives ~191k STX (clearing × cleared sBTC)
//        -> ~43.3M sats sBTC rolls into cycle N+1
//   8.  BORROWER -> snpl.cancel-swap(1)   [REAL Jing.cancel-sbtc-deposit
//                                          on cycle N+1; refunds rolled]
//   9.  LENDER -> snpl.seize(1, reserve)  [past deadline; ships STX + sBTC]
//  10.  LENDER -> reserve.withdraw-stx (safe lower bound)
//  11.  LENDER -> reserve.withdraw-sbtc (safe lower bound)
//
// Run: npx tsx simulations/simul-loan-snpl-seize-rolled.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  principalCV,
  noneCV,
  bufferCV,
  contractPrincipalCV,
} from "@stacks/transactions";
import { SimulationBuilder } from "stxer";
import { verifyAndReport } from "./_verify.js";

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ"; // 276 sBTC on mainnet
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

// Pyth mainnet contracts
const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v4`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v3`;
const WORMHOLE_CORE = `${PYTH_DEPLOYER}.wormhole-core-v4`;

const BTC_USD_FEED =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_USD_FEED =
  "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

// --- Contract names ---
const RESERVE_TRAIT_NAME = "reserve-trait";
const SNPL_TRAIT_NAME = "snpl-trait";
const RESERVE_NAME = "loan-reserve";
const SNPL_NAME = "loan-sbtc-stx-0-jing";

const RESERVE_ID = `${LENDER}.${RESERVE_NAME}`;
const SNPL_ID = `${LENDER}.${SNPL_NAME}`;

// --- Amounts ---
// 1 BTC loan: large enough that mainnet's ~191k STX in the cycle can't
// absorb it all at clearing -> the snpl rolls a meaningful chunk.
const SUPPLY_AMOUNT = 100_000_000;
const LENDER_SEED = 110_000_000;
const CREDIT_CAP = 100_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 100_000_000;

const LIMIT_PRICE = 31_152_648_000_000; // 311,526.48 STX/BTC floor

// Withdraw lower bounds. Actual amounts depend on the live clearing
// price and on how much STX is in cycle N at fork time. These floors
// are conservative (well below the expected ~191k STX and ~43M sats
// rolled) so the withdraw txs always succeed; any leftover stays in
// the reserve and is visible in post-evals.
const STX_WITHDRAW_LOWER_BOUND = 100_000_000_000; // 100k STX
const SBTC_WITHDRAW_LOWER_BOUND = 10_000_000;     // 10M sats (~0.1 sBTC)

async function fetchPythVAA(timestamp) {
  const url = `https://hermes.pyth.network/v2/updates/price/${timestamp}?ids[]=${BTC_USD_FEED}&ids[]=${STX_USD_FEED}`;
  console.log(`Fetching Pyth VAA at timestamp ${timestamp}...`);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const data = await response.json();
  if (!data.binary?.data?.[0]) {
    throw new Error(`No price data found for timestamp ${timestamp}`);
  }
  console.log(
    `Got VAA (${data.binary.data[0].length} hex chars), ${data.parsed.length} feeds`
  );
  for (const p of data.parsed) {
    const price = Number(p.price.price) / 1e8;
    console.log(`  ${p.id.slice(0, 8)}... = $${price.toFixed(4)}`);
  }
  return data.binary.data[0];
}

async function main() {
  const reserveTraitSrc = fs.readFileSync(
    "./contracts/loan/reserve-trait.clar",
    "utf8"
  );
  const snplTraitSrc = fs.readFileSync(
    "./contracts/loan/snpl-trait.clar",
    "utf8"
  );
  const reserveSrc = fs.readFileSync(
    "./contracts/loan/stxer/loan-reserve-stxer.clar",
    "utf8"
  );
  const snplSrc = fs.readFileSync(
    "./contracts/loan/stxer/loan-sbtc-stx-0-jing-stxer.clar",
    "utf8"
  );

  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  const [pythStorageAddr, pythStorageName] = PYTH_STORAGE.split(".");
  const [pythDecoderAddr, pythDecoderName] = PYTH_DECODER.split(".");
  const [wormholeAddr, wormholeName] = WORMHOLE_CORE.split(".");

  console.log(
    "\n=== LOAN-RESERVE + SNPL SEIZE (ROLLED sBTC) STXER SIMULATION ===\n"
  );
  console.log("100M sats deposit -> mainnet STX absorbs ~57M, ~43M rolls");
  console.log(
    "  -> cancel-swap pulls rolled back -> seize ships STX + sBTC -> withdraw\n"
  );

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    // ------- Deploy -------
    .withSender(LENDER)
    .addContractDeploy({
      contract_name: RESERVE_TRAIT_NAME,
      source_code: reserveTraitSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: SNPL_TRAIT_NAME,
      source_code: snplTraitSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: RESERVE_NAME,
      source_code: reserveSrc,
      clarity_version: ClarityVersion.Clarity4,
    })
    .addContractDeploy({
      contract_name: SNPL_NAME,
      source_code: snplSrc,
      clarity_version: ClarityVersion.Clarity4,
    })

    // ------- 1. Initialize -------
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "initialize",
      function_args: [principalCV(LENDER)],
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "initialize",
      function_args: [
        principalCV(BORROWER),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })

    // ------- 2. Whale seeds LENDER -------
    .withSender(SBTC_WHALE)
    .addContractCall({
      contract_id: SBTC_TOKEN,
      function_name: "transfer",
      function_args: [
        uintCV(LENDER_SEED),
        principalCV(SBTC_WHALE),
        principalCV(LENDER),
        noneCV(),
      ],
    })

    // ------- 3. Supply + open credit line -------
    .withSender(LENDER)
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "supply",
      function_args: [uintCV(SUPPLY_AMOUNT)],
    })
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "open-credit-line",
      function_args: [
        contractPrincipalCV(LENDER, SNPL_NAME),
        principalCV(BORROWER),
        uintCV(CREDIT_CAP),
        uintCV(INTEREST_BPS),
      ],
    })

    // ------- 4. BORROWER draws + deposits sBTC into Jing -------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "borrow",
      function_args: [
        uintCV(LOAN_PRINCIPAL),
        uintCV(INTEREST_BPS),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "swap-deposit",
      function_args: [uintCV(1), uintCV(LIMIT_PRICE)],
    })
    .addEvalCode(SNPL_ID, "(get-loan u1)")
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-current-cycle)`
    )
    // Cycle totals before settle: see how much STX is on mainnet side
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-cycle-totals (contract-call? '${JING_MARKET} get-current-cycle))`
    )

    // ------- 5. close-and-settle-with-refresh (no STX depositors from us) -------
    .addContractCall({
      contract_id: JING_MARKET,
      function_name: "close-and-settle-with-refresh",
      function_args: [
        vaaBuffer,
        vaaBuffer,
        contractPrincipalCV(pythStorageAddr, pythStorageName),
        contractPrincipalCV(pythDecoderAddr, pythDecoderName),
        contractPrincipalCV(wormholeAddr, wormholeName),
      ],
    })
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-current-cycle)`
    ) // expect N+1
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // ~191k STX received
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // 0 (rolled portion is in Jing, not on snpl)
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // ~43M sats rolled in cycle N+1

    // ------- 6. cancel-swap pulls the rolled sBTC back to snpl -------
    .withSender(BORROWER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "cancel-swap",
      function_args: [uintCV(1)],
    })
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // 0 - Jing position cleared, gate will pass
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // ~43M sats sBTC back on snpl

    // ------- 7. SEIZE -------
    .withSender(LENDER)
    .addContractCall({
      contract_id: SNPL_ID,
      function_name: "seize",
      function_args: [
        uintCV(1),
        contractPrincipalCV(LENDER, RESERVE_NAME),
      ],
    })
    .addEvalCode(SNPL_ID, "(get-loan u1)") // status u2 (SEIZED)
    .addEvalCode(SNPL_ID, "(get-active-loan)") // none
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // 0 - drained
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // 0 - drained
    .addEvalCode(RESERVE_ID, `(stx-get-balance '${RESERVE_ID})`) // STX received
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // ~43M sats received
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding-sbtc 0
    // No protocol fee on seize: JING_TREASURY balance reflects only Jing's
    // own settlement fees (sbtc-fee + stx-fee), not our 10% carve-out.
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    // ------- 8. LENDER sweeps both legs -------
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-stx",
      function_args: [uintCV(STX_WITHDRAW_LOWER_BOUND)],
    })
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-sbtc",
      function_args: [uintCV(SBTC_WITHDRAW_LOWER_BOUND)],
    })
    .addEvalCode(RESERVE_ID, `(stx-get-balance '${RESERVE_ID})`) // residual STX
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // residual sBTC
    .addEvalCode(RESERVE_ID, `(stx-get-balance '${LENDER})`)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "LOAN SNPL SEIZE ROLLED");
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
