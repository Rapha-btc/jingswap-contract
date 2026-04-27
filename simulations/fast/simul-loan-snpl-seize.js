// simul-loan-snpl-seize.js
// Stxer mainnet fork simulation: SEIZE path with real Jing v2 settlement.
//
// Two independent STX depositors join the snpl's Jing cycle. Whichever side
// is "binding" determines the outcome — at most fork blocks, mainnet has
// significant pre-existing STX in the cycle, so sBTC ends up binding and our
// 22M sats fully clears. Snpl receives STX from `distribute-sbtc-depositor`.
// Borrower defaults; lender invokes seize, sweeps STX via withdraw-stx.
//
// Observed at block 7,755,570 (cycle 8): clearing 337,990 STX/BTC ABOVE our
// 311,526 limit, so the snpl's sBTC fully cleared (binding side), and our
// 55k STX deposits got rolled forward (limit-roll-stx). Snpl received
// 74,283.56 STX. If a future fork block has the opposite binding side,
// uncomment the cancel-swap + withdraw-sbtc steps to handle rolled sBTC.
//
// Flow:
//   1.  LENDER deploys traits + loan-reserve + snpl
//   2.  SBTC_WHALE -> LENDER (seed 23M sBTC, mainnet balance is 0)
//   3.  LENDER initialize(s) reserve & snpl
//   4.  LENDER supply 22M sBTC
//   5.  LENDER open-credit-line(snpl, BORROWER, 22M, 100bps)
//   6.  BORROWER borrow(22M, 100, reserve)
//   7.  BORROWER swap-deposit(1, LIMIT_PRICE)        [22M sats -> Jing cycle N]
//   8.  STX_DEPOSITOR_1 -> Jing.deposit-stx(41k STX, LIMIT_PRICE)
//   9.  STX_DEPOSITOR_2 -> Jing.deposit-stx(14k STX, LIMIT_PRICE)
//  10.  LENDER -> Jing.close-and-settle-with-refresh(VAA)
//  11.  LENDER -> snpl.seize(1, reserve)  [past deadline; ships STX]
//  12.  LENDER -> reserve.withdraw-stx
//
// Run: npx tsx simulations/simul-loan-snpl-seize.js
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
import { expectations } from "./_expectations.js";
import { blockPins } from "./_block-pins.js";

// --- Principals ---
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const SBTC_WHALE = "SP24MM95FEZJY3XWSBGZ5CT8DV04J6NVM5QA4WDXZ";
const STX_DEPOSITOR_1 = "SP14TZ17WHN486XFHFKHD1KTT6Z721NT40HV59T3K"; // ~41,527 STX
const STX_DEPOSITOR_2 = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG"; // ~14,449 STX
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";

// Pyth mainnet contracts (same as simul-jing-loan-true-happy-path.js)
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
const SUPPLY_AMOUNT = 22_000_000;
const LENDER_SEED = 23_000_000;
const CREDIT_CAP = 22_000_000;
const INTEREST_BPS = 100;
const LOAN_PRINCIPAL = 22_000_000;

// 311,526.48 STX/BTC × 1e8
const LIMIT_PRICE = 31_152_648_000_000;

// STX deposits (microSTX). Round numbers leave gas headroom.
const STX_DEPOSIT_1 = 41_000_000_000; // 41k STX (depositor has ~41,527)
const STX_DEPOSIT_2 = 14_000_000_000; // 14k STX (depositor has ~14,449)

// LENDER withdrawal lower bound. Observed at block 7,755,570 was
// ~74,283 STX from Jing's distribute-sbtc-depositor. 70k is a safe
// floor that survives small price drifts in the live Pyth VAA.
const STX_WITHDRAW_LOWER_BOUND = 70_000_000_000;

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

  // Fetch a fresh Pyth VAA (30s old to ensure availability)
  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const vaaHex = await fetchPythVAA(timestamp);
  const vaaBuffer = bufferCV(Buffer.from(vaaHex, "hex"));

  const [pythStorageAddr, pythStorageName] = PYTH_STORAGE.split(".");
  const [pythDecoderAddr, pythDecoderName] = PYTH_DECODER.split(".");
  const [wormholeAddr, wormholeName] = WORMHOLE_CORE.split(".");

  console.log("\n=== LOAN-RESERVE + SNPL SEIZE STXER SIMULATION ===\n");
  console.log("deploy -> init -> supply -> open-line -> borrow");
  console.log("  -> swap-deposit (22M sBTC) + STX-side deposits (55k STX)");
  console.log("  -> close-and-settle-with-refresh (partial fill)");
  console.log("  -> cancel-swap (pull rolled dust)");
  console.log("  -> seize -> lender withdraws STX + sBTC\n");

  const sessionId = await SimulationBuilder.new({ skipTracing: true })
    .useBlockHeight(blockPins["simul-loan-snpl-seize"].block_height)
    // ------- Deploy traits + contracts -------
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

    // ------- 1. Initialize reserve + snpl -------
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
    .addEvalCode(SNPL_ID, "(get-loan u1)") // jing-cycle stamped
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-current-cycle)`
    )

    // ------- 5. Independent STX-side depositors -------
    .withSender(STX_DEPOSITOR_1)
    .addContractCall({
      contract_id: JING_MARKET,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_DEPOSIT_1), uintCV(LIMIT_PRICE)],
    })
    .withSender(STX_DEPOSITOR_2)
    .addContractCall({
      contract_id: JING_MARKET,
      function_name: "deposit-stx",
      function_args: [uintCV(STX_DEPOSIT_2), uintCV(LIMIT_PRICE)],
    })
    // Cycle totals before settle: sBTC side 22M, STX side 55k STX
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-cycle-totals (contract-call? '${JING_MARKET} get-current-cycle))`
    )

    // ------- 6. close-and-settle-with-refresh (partial fill) -------
    .withSender(LENDER)
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
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // expect ~55k STX (filled)
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // expect 0 (filled portion held by Jing then redistributed; rolled in N+1)
    .addEvalCode(
      SNPL_ID,
      `(contract-call? '${JING_MARKET} get-sbtc-deposit (contract-call? '${JING_MARKET} get-current-cycle) '${SNPL_ID})`
    ) // expect ~4.35M sats rolled in cycle N+1

    // ------- 7. (skip) cancel-swap — only needed if STX was binding side
    // and our sBTC rolled. At this fork block, sBTC is binding so
    // our-sbtc-in-jing(N+1) is already 0 and the seize gate passes
    // directly. Re-introduce this call if a future fork flips binding.

    // ------- 8. SEIZE (deadline reached, Jing fully resolved) -------
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
    .addEvalCode(SNPL_ID, `(stx-get-balance '${SNPL_ID})`) // expect 0 — drained
    .addEvalCode(
      SNPL_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${SNPL_ID}))`
    ) // expect 0 — drained
    .addEvalCode(RESERVE_ID, `(stx-get-balance '${RESERVE_ID})`) // expect ~55k STX
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // expect ~4.35M sats
    .addEvalCode(RESERVE_ID, `(get-credit-line '${SNPL_ID})`) // outstanding-sbtc 0
    // No protocol fee on seize: JING_TREASURY balance unchanged across the flow
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${JING_TREASURY}))`
    )

    // ------- 9. LENDER sweeps STX position -------
    // Snpl was on binding sBTC side, so reserve sBTC balance is 0 here.
    // The STX amount distributed by Jing depends on the live clearing
    // price (Pyth VAA fetched at script run time). At block 7,755,570
    // we observed 74,283,562,076 microSTX. Use a safe lower bound so
    // the withdraw remains robust across small price drifts; any
    // residual stays in the reserve and is visible in the post-eval.
    .addContractCall({
      contract_id: RESERVE_ID,
      function_name: "withdraw-stx",
      function_args: [uintCV(STX_WITHDRAW_LOWER_BOUND)],
    })
    .addEvalCode(RESERVE_ID, `(stx-get-balance '${RESERVE_ID})`) // residual STX
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${RESERVE_ID}))`
    ) // 0 — no rolled sBTC at this fork
    .addEvalCode(RESERVE_ID, `(stx-get-balance '${LENDER})`)
    .addEvalCode(
      RESERVE_ID,
      `(unwrap-panic (contract-call? '${SBTC_TOKEN} get-balance '${LENDER}))`
    )

    .run();

  console.log(`\nSession: ${sessionId}`);
  const _verify = await verifyAndReport(sessionId, "LOAN SNPL SEIZE", expectations["simul-loan-snpl-seize"] || {});
  if (!_verify.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
