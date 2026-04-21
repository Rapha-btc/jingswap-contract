import { describe, expect, it, beforeAll } from "vitest";
import { Cl, cvToJSON } from "@stacks/transactions";

const xykPool = cvToJSON(
  simnet.callReadOnlyFn(
    "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1",
    "get-total-supply",
    [],
    simnet.getAccounts().get("deployer")!
  ).result
);
const remoteDataEnabled = Number(xykPool.value?.value || 0) > 0;

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;

const LOAN = "jing-loan-sbtc-stx-single";
const LOAN_ID = `${deployer}.${LOAN}`;

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

// MUST match contract's BORROWER and LENDER constants
const BORROWER = "SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X";
const LENDER = "SP3TACXQF9X25NETDNQ710RMQ7A8AHNTF7XVG252M";

const SBTC_1M = 1_000_000;
const SBTC_4M = 4_000_000;

const DEFAULT_INTEREST_BPS = 100;
const BPS_PRECISION = 10_000;
const CLAWBACK_DELAY = 4200;

// Errors
const ERR_NOT_LENDER = 100;
const ERR_NOT_BORROWER = 101;
const ERR_AMOUNT_TOO_LOW = 102;
const ERR_INSUFFICIENT_FUNDS = 103;
const ERR_ACTIVE_LOAN_EXISTS = 104;
const ERR_LOAN_NOT_FOUND = 105;
const ERR_BAD_STATUS = 106;
const ERR_DEADLINE_NOT_REACHED = 108;

// Statuses
const STATUS_PRE_SWAP = 0;
const SWAP_DEPOSITED = 1;
const STATUS_REPAID = 2;
const STATUS_SEIZED = 3;

function pub(contract: string, fn: string, args: any[], sender: string) {
  return simnet.callPublicFn(contract, fn, args, sender);
}

function ro(contract: string, fn: string, args: any[]) {
  return simnet.callReadOnlyFn(contract, fn, args, deployer).result;
}

function fundSbtc(recipient: string, amount: number) {
  simnet.callPublicFn(
    SBTC_TOKEN,
    "transfer",
    [Cl.uint(amount), Cl.principal(SBTC_WHALE), Cl.principal(recipient), Cl.none()],
    SBTC_WHALE
  );
}

function getSbtcBalance(principal: string): number {
  const result = cvToJSON(
    simnet.callReadOnlyFn(SBTC_TOKEN, "get-balance", [Cl.principal(principal)], deployer).result
  );
  return Number(result.value.value);
}

function expectedOwed(principal: number, bps: number = DEFAULT_INTEREST_BPS): number {
  return principal + Math.floor((principal * bps) / BPS_PRECISION);
}

// Helper: fund the contract with `amount` sBTC from LENDER
function setupFunded(amount: number) {
  fundSbtc(LENDER, amount);
  expect(pub(LOAN, "fund", [Cl.uint(amount)], LENDER).result).toBeOk(Cl.bool(true));
}

// Helper: fund + borrow (returns loan-id 1)
function setupBorrowed(fundAmount: number, borrowAmount: number) {
  setupFunded(fundAmount);
  expect(pub(LOAN, "borrow", [Cl.uint(borrowAmount)], BORROWER).result).toBeOk(Cl.uint(1));
}

// Helper: fund + borrow + swap-deposit
function setupSwapped(fundAmount: number, borrowAmount: number, limitPrice: number) {
  setupBorrowed(fundAmount, borrowAmount);
  expect(pub(LOAN, "swap-deposit", [Cl.uint(1), Cl.uint(limitPrice)], BORROWER).result).toBeOk(Cl.bool(true));
}

// ============================================================================

describe.skipIf(!remoteDataEnabled)("jing-loan-sbtc-stx-single", function () {

  // --- Initial state ---

  it("initial state: no loan, zero available, defaults correct", function () {
    expect(ro(LOAN, "get-lender", [])).toBePrincipal(LENDER);
    expect(ro(LOAN, "get-borrower", [])).toBePrincipal(BORROWER);
    expect(ro(LOAN, "get-interest-bps", [])).toBeUint(DEFAULT_INTEREST_BPS);
    expect(ro(LOAN, "get-min-sbtc-borrow", [])).toBeUint(SBTC_1M);
    expect(ro(LOAN, "get-available-sbtc", [])).toBeUint(0);
    expect(ro(LOAN, "get-active-loan", [])).toBeNone();
  });

  // --- Admin ---

  it("set-interest-bps: rejects non-lender", function () {
    expect(pub(LOAN, "set-interest-bps", [Cl.uint(100)], wallet1).result).toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("set-interest-bps: lender updates rate", function () {
    expect(pub(LOAN, "set-interest-bps", [Cl.uint(100)], LENDER).result).toBeOk(Cl.bool(true));
    expect(ro(LOAN, "get-interest-bps", [])).toBeUint(100);
  });

  // --- Fund / withdraw ---

  it("fund: rejects non-lender", function () {
    fundSbtc(wallet1, SBTC_1M);
    expect(pub(LOAN, "fund", [Cl.uint(SBTC_1M)], wallet1).result).toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("fund: lender deposits sBTC, available-sbtc increases", function () {
    setupFunded(SBTC_1M);
    expect(ro(LOAN, "get-available-sbtc", [])).toBeUint(SBTC_1M);
    expect(getSbtcBalance(LOAN_ID)).toBe(SBTC_1M);
  });

  it("withdraw-funds: lender-only, decrements available-sbtc", function () {
    setupFunded(SBTC_1M);
    expect(pub(LOAN, "withdraw-funds", [Cl.uint(100_000)], wallet1).result).toBeErr(Cl.uint(ERR_NOT_LENDER));
    expect(pub(LOAN, "withdraw-funds", [Cl.uint(100_000)], LENDER).result).toBeOk(Cl.bool(true));
    expect(ro(LOAN, "get-available-sbtc", [])).toBeUint(SBTC_1M - 100_000);
  });

  it("withdraw-funds: rejects if amount exceeds available", function () {
    setupFunded(SBTC_1M);
    expect(pub(LOAN, "withdraw-funds", [Cl.uint(SBTC_1M + 1)], LENDER).result).toBeErr(Cl.uint(ERR_INSUFFICIENT_FUNDS));
  });

  // --- Borrow ---

  it("borrow: rejects non-borrower", function () {
    setupFunded(SBTC_1M);
    expect(pub(LOAN, "borrow", [Cl.uint(SBTC_1M)], wallet1).result).toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("borrow: rejects below minimum", function () {
    setupFunded(SBTC_1M);
    expect(pub(LOAN, "borrow", [Cl.uint(500_000)], BORROWER).result).toBeErr(Cl.uint(ERR_AMOUNT_TOO_LOW));
  });

  it("borrow: rejects exceeding available-sbtc", function () {
    setupFunded(SBTC_1M);
    expect(pub(LOAN, "borrow", [Cl.uint(SBTC_1M + 1)], BORROWER).result).toBeErr(Cl.uint(ERR_INSUFFICIENT_FUNDS));
  });

  it("borrow: creates loan, decrements available, sets active-loan", function () {
    setupFunded(SBTC_1M);
    expect(pub(LOAN, "borrow", [Cl.uint(SBTC_1M)], BORROWER).result).toBeOk(Cl.uint(1));
    expect(ro(LOAN, "get-available-sbtc", [])).toBeUint(0);
    expect(ro(LOAN, "get-active-loan", [])).toBeSome(Cl.uint(1));

    const loan = cvToJSON(ro(LOAN, "get-loan", [Cl.uint(1)]));
    expect(loan.value.value["sbtc-principal"].value).toBe(String(SBTC_1M));
    expect(loan.value.value["status"].value).toBe(String(STATUS_PRE_SWAP));
  });

  it("borrow: rejects if active loan exists", function () {
    setupBorrowed(SBTC_4M, SBTC_1M);
    expect(pub(LOAN, "borrow", [Cl.uint(SBTC_1M)], BORROWER).result).toBeErr(Cl.uint(ERR_ACTIVE_LOAN_EXISTS));
  });

  // --- Swap-deposit ---

  it("swap-deposit: rejects non-borrower", function () {
    setupBorrowed(SBTC_1M, SBTC_1M);
    expect(pub(LOAN, "swap-deposit", [Cl.uint(1), Cl.uint(300_000)], wallet1).result).toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("swap-deposit: rejects unknown loan-id", function () {
    setupBorrowed(SBTC_1M, SBTC_1M);
    expect(pub(LOAN, "swap-deposit", [Cl.uint(999), Cl.uint(300_000)], BORROWER).result).toBeErr(Cl.uint(ERR_LOAN_NOT_FOUND));
  });

  it("swap-deposit: moves sBTC to Jing, flips status", function () {
    setupBorrowed(SBTC_1M, SBTC_1M);
    const balBefore = getSbtcBalance(LOAN_ID);
    expect(pub(LOAN, "swap-deposit", [Cl.uint(1), Cl.uint(300_000)], BORROWER).result).toBeOk(Cl.bool(true));
    const balAfter = getSbtcBalance(LOAN_ID);
    expect(balBefore - balAfter).toBe(SBTC_1M);

    const loan = cvToJSON(ro(LOAN, "get-loan", [Cl.uint(1)]));
    expect(loan.value.value["status"].value).toBe(String(SWAP_DEPOSITED));
    expect(loan.value.value["limit-price"].value).toBe("300000");
  });

  it("swap-deposit: rejects if already swapped", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    expect(pub(LOAN, "swap-deposit", [Cl.uint(1), Cl.uint(300_000)], BORROWER).result).toBeErr(Cl.uint(ERR_BAD_STATUS));
  });

  // --- Cancel-swap ---

  it("cancel-swap: rejects non-borrower before deadline", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    expect(pub(LOAN, "cancel-swap", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(ERR_NOT_BORROWER));
    expect(pub(LOAN, "cancel-swap", [Cl.uint(1)], LENDER).result).toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("cancel-swap: borrower pulls sBTC back from Jing", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    const balBefore = getSbtcBalance(LOAN_ID);
    expect(pub(LOAN, "cancel-swap", [Cl.uint(1)], BORROWER).result).toBeOk(Cl.bool(true));
    const balAfter = getSbtcBalance(LOAN_ID);
    expect(balAfter - balBefore).toBe(SBTC_1M);

    // Status unchanged
    const loan = cvToJSON(ro(LOAN, "get-loan", [Cl.uint(1)]));
    expect(loan.value.value["status"].value).toBe(String(SWAP_DEPOSITED));
  });

  it("cancel-swap: lender can cancel after deadline", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(LOAN, "cancel-swap", [Cl.uint(1)], LENDER).result).toBeOk(Cl.bool(true));
  });

  // --- Repay after full cancel (happy edge case) ---

  it("repay: after full cancel, borrower pays only interest", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    pub(LOAN, "cancel-swap", [Cl.uint(1)], BORROWER);

    const owed = expectedOwed(SBTC_1M);
    const interest = owed - SBTC_1M;
    fundSbtc(BORROWER, interest);
    const lenderBefore = getSbtcBalance(LENDER);
    expect(pub(LOAN, "repay", [Cl.uint(1)], BORROWER).result).toBeOk(Cl.bool(true));
    const lenderAfter = getSbtcBalance(LENDER);
    expect(lenderAfter - lenderBefore).toBe(owed);

    const loan = cvToJSON(ro(LOAN, "get-loan", [Cl.uint(1)]));
    expect(loan.value.value["status"].value).toBe(String(STATUS_REPAID));
    expect(ro(LOAN, "get-active-loan", [])).toBeNone();
  });

  // --- Seize ---

  it("seize: rejects non-lender", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    expect(pub(LOAN, "seize", [Cl.uint(1)], wallet1).result).toBeErr(Cl.uint(ERR_NOT_LENDER));
    expect(pub(LOAN, "seize", [Cl.uint(1)], BORROWER).result).toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("seize: rejects before deadline", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    expect(pub(LOAN, "seize", [Cl.uint(1)], LENDER).result).toBeErr(Cl.uint(ERR_DEADLINE_NOT_REACHED));
  });

  it("seize: lender seizes after deadline + cancel, recovers sBTC", function () {
    setupSwapped(SBTC_1M, SBTC_1M, 300_000);
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    pub(LOAN, "cancel-swap", [Cl.uint(1)], LENDER);

    const lenderBefore = getSbtcBalance(LENDER);
    expect(pub(LOAN, "seize", [Cl.uint(1)], LENDER).result).toBeOk(Cl.bool(true));
    const lenderAfter = getSbtcBalance(LENDER);
    expect(lenderAfter - lenderBefore).toBe(SBTC_1M);

    const loan = cvToJSON(ro(LOAN, "get-loan", [Cl.uint(1)]));
    expect(loan.value.value["status"].value).toBe(String(STATUS_SEIZED));
    expect(ro(LOAN, "get-active-loan", [])).toBeNone();
  });
});

// ============================================================================
// Full happy path: borrow → swap-deposit → Jing close+settle-with-refresh → repay
// Mirrors simulations/simul-jing-loan-true-happy-path.js but in Clarinet.
// ============================================================================

const JING_MARKET_ADDR = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const JING_MARKET_NAME = "sbtc-stx-0-jing-v2";
const PYTH_DEPLOYER = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y";
const PYTH_STORAGE = "pyth-storage-v4";
const PYTH_DECODER = "pyth-pnau-decoder-v3";
const WORMHOLE_CORE = "wormhole-core-v4";

const BTC_USD_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_USD_FEED = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

const DEPOSIT_MIN_BLOCKS = 10;
const STX_100 = 100_000_000;

async function fetchPythVAA(): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000) - 30;
  const url = `https://hermes.pyth.network/v2/updates/price/${timestamp}?ids[]=${BTC_USD_FEED}&ids[]=${STX_USD_FEED}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json();
  if (!data.binary?.data?.[0]) {
    throw new Error(`No Pyth VAA at timestamp ${timestamp}`);
  }
  return data.binary.data[0];
}

// NOTE: This describe block is SKIPPED by default because Clarinet's VM has a
// non-deterministic "failed to track token supply" bug during Jing's settlement
// that is triggered on cross-contract sBTC distribute. Same issue flagged in
// sbtc-stx-0-v2.test.ts. Fetch + close-and-settle-with-refresh orchestration
// is correct — this test succeeds manually via the stxer simulation at
// simulations/simul-jing-loan-true-happy-path.js. Remove the `.skip` to retry.
describe.skip("jing-loan-sbtc-stx-single > happy path e2e (VM-gated)", function () {

  it("fund → borrow → swap → settle → repay releases STX to borrower", async function () {
    const vaaHex = await fetchPythVAA();
    console.log(`[happy-path] Got Pyth VAA: ${vaaHex.length} hex chars`);
    const loanAmount = SBTC_1M;
    const fundAmount = SBTC_1M;
    // High limit so our sBTC clears easily (very permissive)
    const swapLimit = 99_999_999_999_999;

    // 1. Fund
    setupFunded(fundAmount);

    // 2. Borrow
    expect(pub(LOAN, "borrow", [Cl.uint(loanAmount)], BORROWER).result).toBeOk(Cl.uint(1));

    // 3. Swap-deposit (loan contract deposits sBTC into Jing)
    expect(pub(LOAN, "swap-deposit", [Cl.uint(1), Cl.uint(swapLimit)], BORROWER).result).toBeOk(Cl.bool(true));

    // 4. Add an STX-side depositor on Jing so clearing can happen.
    //    wallet_1 deposits STX at a low limit (willing to sell cheap).
    const stxDepositResult = simnet.callPublicFn(
      `${JING_MARKET_ADDR}.${JING_MARKET_NAME}`,
      "deposit-stx",
      [Cl.uint(STX_100), Cl.uint(1)], // STX amount, very low sats/STX limit
      wallet1
    );
    expect(stxDepositResult.result).toBeOk(Cl.uint(STX_100));

    // 5. Mine blocks to satisfy DEPOSIT_MIN_BLOCKS
    simnet.mineEmptyBlocks(DEPOSIT_MIN_BLOCKS + 1);

    // 6. Jing close-and-settle-with-refresh with fetched Pyth VAA
    const vaaBuf = Cl.bufferFromHex(vaaHex);
    const settleResult = simnet.callPublicFn(
      `${JING_MARKET_ADDR}.${JING_MARKET_NAME}`,
      "close-and-settle-with-refresh",
      [
        vaaBuf,
        vaaBuf,
        Cl.contractPrincipal(PYTH_DEPLOYER, PYTH_STORAGE),
        Cl.contractPrincipal(PYTH_DEPLOYER, PYTH_DECODER),
        Cl.contractPrincipal(PYTH_DEPLOYER, WORMHOLE_CORE),
      ],
      wallet1
    );
    expect(settleResult.result).toBeOk(Cl.bool(true));

    // 7. Verify loan contract has STX from settlement
    const contractStx = cvToJSON(
      simnet.callReadOnlyFn(LOAN, "get-lender", [], deployer).result
    );
    const stxBalance = Number(
      simnet.runSnippet(`(stx-get-balance '${LOAN_ID})`).value
    );
    console.log(`[happy-path] Contract STX after settle: ${stxBalance}`);
    expect(stxBalance).toBeGreaterThan(0);

    // 8. Repay — borrower tops up shortfall, contract pays LENDER, STX to BORROWER
    const owed = expectedOwed(loanAmount);
    fundSbtc(BORROWER, owed); // generous topup
    const borrowerStxBefore = Number(
      simnet.runSnippet(`(stx-get-balance '${BORROWER})`).value
    );
    expect(pub(LOAN, "repay", [Cl.uint(1)], BORROWER).result).toBeOk(Cl.bool(true));
    const borrowerStxAfter = Number(
      simnet.runSnippet(`(stx-get-balance '${BORROWER})`).value
    );

    console.log(`[happy-path] Borrower STX gained: ${borrowerStxAfter - borrowerStxBefore}`);
    expect(borrowerStxAfter - borrowerStxBefore).toBeGreaterThan(0);

    const loan = cvToJSON(ro(LOAN, "get-loan", [Cl.uint(1)]));
    expect(loan.value.value["status"].value).toBe(String(STATUS_REPAID));
    expect(ro(LOAN, "get-active-loan", [])).toBeNone();
  });
});
