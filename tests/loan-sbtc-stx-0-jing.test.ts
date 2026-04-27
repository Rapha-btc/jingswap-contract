import { describe, expect, it } from "vitest";
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
const wallet1 = accounts.get("wallet_1")!; // LENDER
const wallet2 = accounts.get("wallet_2")!; // BORROWER
const wallet3 = accounts.get("wallet_3")!; // outsider

const RESERVE = "loan-reserve";
const RESERVE_ID = `${deployer}.${RESERVE}`;
const SNPL = "loan-sbtc-stx-0-jing";
const SNPL_ID = `${deployer}.${SNPL}`;

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const JING_MARKET = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2";
const JING_TREASURY = "SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE";

const SAINT = "SP000000000000000000002Q6VF78";

// Constants matching loan-sbtc-stx-0-jing.clar
const CLAWBACK_DELAY = 4200;
const BPS_PRECISION = 10_000;
const FEE_BPS_OF_INTEREST = 1_000;

const STATUS_OPEN = 0;
const STATUS_REPAID = 1;
const STATUS_SEIZED = 2;

// Snpl errors
const ERR_NOT_BORROWER = 101;
const ERR_ACTIVE_LOAN_EXISTS = 104;
const ERR_LOAN_NOT_FOUND = 105;
const ERR_BAD_STATUS = 106;
const ERR_NOT_FULLY_RESOLVED = 107;
const ERR_DEADLINE_NOT_REACHED = 108;
const ERR_INTEREST_MISMATCH = 109;
const ERR_PAST_DEADLINE = 110;
const ERR_NOT_DEPLOYER = 111;
const ERR_ALREADY_INIT = 112;
const ERR_WRONG_RESERVE = 113;

// Reserve errors that may bubble up via borrow's call to draw
const ERR_NO_CREDIT_LINE = 201;

// Minimal Clarity-4 stub that impls reserve-trait. Used to assert
// ERR-WRONG-RESERVE (the snpl checks the trait reference's principal
// matches its `current-reserve` var before calling draw / notify-return).
// The stub doesn't have to do anything real — the assertion fires before
// the reserve methods are invoked. Deployed under the simnet `deployer` so
// the relative trait ref `.reserve-trait.reserve-trait` resolves correctly.
const WRONG_RESERVE_NAME = "wrong-reserve";
const WRONG_RESERVE_SRC = `
(impl-trait .reserve-trait.reserve-trait)

(define-public (draw (amount uint))
  (ok u0))

(define-public (notify-return (notional uint))
  (ok true))
`;

const SBTC_22M = 22_000_000;
const SBTC_1M = 1_000_000;
const SBTC_5M = 5_000_000;
const INTEREST_BPS = 100; // 1% flat

// A limit price that is intentionally far above any realistic clearing,
// ensuring our deposit rolls if Jing settles (we don't expect Jing to
// settle here — we exercise the snpl in isolation). Same value used in
// the stxer sims.
const LIMIT_PRICE = 31_152_648_000_000;

// ============================================================================
// Helpers
// ============================================================================

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

function getStxBalance(principal: string): number {
  const assets = simnet.getAssetsMap();
  const stxMap = assets.get("STX");
  if (!stxMap) return 0;
  return Number(stxMap.get(principal) ?? 0n);
}

// payoff = notional + (notional * bps / 10000)
function expectedPayoff(notional: number, bps: number = INTEREST_BPS): number {
  return notional + Math.floor((notional * bps) / BPS_PRECISION);
}

// (response (optional {tuple}) uint) → tuple fields
function getLoanFields(loanId: number): Record<string, string> {
  const json = cvToJSON(ro(SNPL, "get-loan", [Cl.uint(loanId)]));
  // (ok (some {tuple})) → json.value.value.value
  const tuple = json.value.value.value;
  const out: Record<string, string> = {};
  for (const k of Object.keys(tuple)) {
    out[k] = tuple[k].value;
  }
  return out;
}

function getOurSbtcInJing(): number {
  // (get-sbtc-deposit cycle principal) on the snpl
  const cycleCV = simnet.callReadOnlyFn(JING_MARKET, "get-current-cycle", [], deployer).result;
  const dep = simnet.callReadOnlyFn(
    JING_MARKET,
    "get-sbtc-deposit",
    [cycleCV, Cl.contractPrincipal(deployer, SNPL)],
    deployer
  ).result;
  return Number(cvToJSON(dep).value);
}

const RESERVE_TRAIT = Cl.contractPrincipal(deployer, RESERVE);
const SNPL_TRAIT = Cl.contractPrincipal(deployer, SNPL);
const WRONG_RESERVE_ID = `${deployer}.${WRONG_RESERVE_NAME}`;
const WRONG_RESERVE_TRAIT = Cl.contractPrincipal(deployer, WRONG_RESERVE_NAME);

function deployWrongReserve() {
  simnet.deployContract(WRONG_RESERVE_NAME, WRONG_RESERVE_SRC, { clarityVersion: 4 }, deployer);
}

function initReserve(lender: string = wallet1) {
  expect(pub(RESERVE, "initialize", [Cl.principal(lender)], deployer).result)
    .toBeOk(Cl.bool(true));
}

function initSnpl(borrower: string = wallet2) {
  expect(
    pub(SNPL, "initialize", [Cl.principal(borrower), RESERVE_TRAIT], deployer).result
  ).toBeOk(Cl.bool(true));
}

function supplyReserve(amount: number, lender: string = wallet1) {
  fundSbtc(lender, amount);
  expect(pub(RESERVE, "supply", [Cl.uint(amount)], lender).result).toBeOk(Cl.bool(true));
}

function openLine(
  borrower: string = wallet2,
  cap: number = SBTC_22M,
  bps: number = INTEREST_BPS,
  lender: string = wallet1
) {
  expect(
    pub(
      RESERVE,
      "open-credit-line",
      [SNPL_TRAIT, Cl.principal(borrower), Cl.uint(cap), Cl.uint(bps)],
      lender
    ).result
  ).toBeOk(Cl.bool(true));
}

function setupOpenLine(opts: {
  supply?: number;
  cap?: number;
  bps?: number;
} = {}) {
  initReserve(wallet1);
  initSnpl(wallet2);
  supplyReserve(opts.supply ?? SBTC_22M, wallet1);
  openLine(wallet2, opts.cap ?? SBTC_22M, opts.bps ?? INTEREST_BPS, wallet1);
}

function setupBorrowed(opts: {
  amount?: number;
  bps?: number;
  supply?: number;
  cap?: number;
} = {}) {
  setupOpenLine({ supply: opts.supply, cap: opts.cap, bps: opts.bps });
  const amount = opts.amount ?? SBTC_22M;
  const bps = opts.bps ?? INTEREST_BPS;
  expect(
    pub(SNPL, "borrow", [Cl.uint(amount), Cl.uint(bps), RESERVE_TRAIT], wallet2).result
  ).toBeOk(Cl.uint(1));
}

function setupSwapped(opts: { limit?: number } = {}) {
  setupBorrowed();
  expect(
    pub(SNPL, "swap-deposit", [Cl.uint(1), Cl.uint(opts.limit ?? LIMIT_PRICE)], wallet2).result
  ).toBeOk(Cl.bool(true));
}

// ============================================================================

describe.skipIf(!remoteDataEnabled)("loan-sbtc-stx-0-jing (snpl)", function () {

  // ------------------------------------------------------------------
  // Pre-init
  // ------------------------------------------------------------------

  it("pre-init: borrower + reserve are SAINT", function () {
    expect(ro(SNPL, "get-borrower", [])).toBeOk(Cl.principal(SAINT));
    expect(ro(SNPL, "get-reserve", [])).toBeOk(Cl.principal(SAINT));
    expect(ro(SNPL, "get-active-loan", [])).toBeOk(Cl.none());
  });

  it("pre-init: borrow blocked (reserve is SAINT — wrong-reserve)", function () {
    // tx-sender check fails first since borrower is SAINT.
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  // ------------------------------------------------------------------
  // initialize
  // ------------------------------------------------------------------

  it("initialize: only deployer (ERR-NOT-DEPLOYER)", function () {
    expect(
      pub(SNPL, "initialize", [Cl.principal(wallet2), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_NOT_DEPLOYER));
  });

  it("initialize: deployer sets borrower + reserve", function () {
    initSnpl(wallet2);
    expect(ro(SNPL, "get-borrower", [])).toBeOk(Cl.principal(wallet2));
    expect(ro(SNPL, "get-reserve", [])).toBeOk(Cl.principal(RESERVE_ID));
  });

  it("initialize: cannot re-init (ERR-ALREADY-INIT)", function () {
    initSnpl(wallet2);
    expect(
      pub(SNPL, "initialize", [Cl.principal(wallet3), RESERVE_TRAIT], deployer).result
    ).toBeErr(Cl.uint(ERR_ALREADY_INIT));
  });

  // ------------------------------------------------------------------
  // set-reserve
  // ------------------------------------------------------------------

  it("set-reserve: rejects non-borrower", function () {
    initSnpl(wallet2);
    expect(pub(SNPL, "set-reserve", [RESERVE_TRAIT], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("set-reserve: rejects when loan active (ERR-ACTIVE-LOAN-EXISTS)", function () {
    setupBorrowed();
    expect(pub(SNPL, "set-reserve", [RESERVE_TRAIT], wallet2).result)
      .toBeErr(Cl.uint(ERR_ACTIVE_LOAN_EXISTS));
  });

  it("set-reserve: borrower switches to a different reserve principal", function () {
    initSnpl(wallet2);
    deployWrongReserve();
    expect(pub(SNPL, "set-reserve", [WRONG_RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));
    expect(ro(SNPL, "get-reserve", [])).toBeOk(Cl.principal(WRONG_RESERVE_ID));
  });

  // ------------------------------------------------------------------
  // borrow
  // ------------------------------------------------------------------

  it("borrow: rejects non-borrower", function () {
    setupOpenLine();
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet3).result
    ).toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("borrow: rejects when no credit line opened (ERR-NO-CREDIT-LINE bubbles from reserve)", function () {
    initReserve(wallet1);
    initSnpl(wallet2);
    supplyReserve(SBTC_22M, wallet1);
    // no open-credit-line — reserve.draw fails with NO-CREDIT-LINE
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_NO_CREDIT_LINE));
  });

  it("borrow: rejects interest mismatch (ERR-INTEREST-MISMATCH)", function () {
    setupOpenLine({ bps: INTEREST_BPS });
    // Pass a bps that does not match the line's
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(250), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_INTEREST_MISMATCH));
  });

  it("borrow: rejects wrong reserve trait reference (ERR-WRONG-RESERVE)", function () {
    setupOpenLine();
    deployWrongReserve();
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), WRONG_RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_WRONG_RESERVE));
  });

  it("borrow: creates loan with correct payoff, sets active-loan, increments next-loan-id", function () {
    setupOpenLine();
    const startBurn = simnet.burnBlockHeight;
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeOk(Cl.uint(1));

    const fields = getLoanFields(1);
    expect(fields["notional-sbtc"]).toBe(String(SBTC_22M));
    expect(fields["payoff-sbtc"]).toBe(String(expectedPayoff(SBTC_22M)));
    expect(fields["interest-bps"]).toBe(String(INTEREST_BPS));
    expect(fields["status"]).toBe(String(STATUS_OPEN));
    expect(Number(fields["deadline"])).toBe(startBurn + CLAWBACK_DELAY);
    expect(fields["jing-cycle"]).toBe("0");
    expect(fields["limit-price"]).toBe("0");
    expect(fields["position-stx"]).toBe("0");

    expect(ro(SNPL, "get-active-loan", [])).toBeOk(Cl.some(Cl.uint(1)));
    expect(ro(SNPL, "payoff-on-loan", [Cl.uint(1)])).toBeOk(Cl.uint(expectedPayoff(SBTC_22M)));
    // sBTC moved from reserve to snpl
    expect(getSbtcBalance(SNPL_ID)).toBe(SBTC_22M);
  });

  it("borrow: rejects when loan already active (ERR-ACTIVE-LOAN-EXISTS)", function () {
    setupBorrowed();
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_1M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_ACTIVE_LOAN_EXISTS));
  });

  it("payoff-on-loan: unknown loan-id (ERR-LOAN-NOT-FOUND)", function () {
    initSnpl(wallet2);
    expect(ro(SNPL, "payoff-on-loan", [Cl.uint(999)])).toBeErr(Cl.uint(ERR_LOAN_NOT_FOUND));
  });

  // ------------------------------------------------------------------
  // swap-deposit
  // ------------------------------------------------------------------

  it("swap-deposit: rejects non-borrower", function () {
    setupBorrowed();
    expect(pub(SNPL, "swap-deposit", [Cl.uint(1), Cl.uint(LIMIT_PRICE)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("swap-deposit: rejects unknown loan-id", function () {
    setupBorrowed();
    expect(pub(SNPL, "swap-deposit", [Cl.uint(999), Cl.uint(LIMIT_PRICE)], wallet2).result)
      .toBeErr(Cl.uint(ERR_LOAN_NOT_FOUND));
  });

  it("swap-deposit: rejects past deadline (ERR-PAST-DEADLINE)", function () {
    setupBorrowed();
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(SNPL, "swap-deposit", [Cl.uint(1), Cl.uint(LIMIT_PRICE)], wallet2).result)
      .toBeErr(Cl.uint(ERR_PAST_DEADLINE));
  });

  it("swap-deposit: deposits sBTC to Jing, stamps cycle + limit", function () {
    setupBorrowed();
    const before = getSbtcBalance(SNPL_ID);
    expect(pub(SNPL, "swap-deposit", [Cl.uint(1), Cl.uint(LIMIT_PRICE)], wallet2).result)
      .toBeOk(Cl.bool(true));
    expect(getSbtcBalance(SNPL_ID)).toBe(before - SBTC_22M);
    expect(getOurSbtcInJing()).toBe(SBTC_22M);

    const fields = getLoanFields(1);
    expect(fields["limit-price"]).toBe(String(LIMIT_PRICE));
    // jing-cycle is whatever the live cycle is — just check it changed off zero
    expect(Number(fields["jing-cycle"])).toBeGreaterThan(0);
  });

  it("swap-deposit: rejects when loan not OPEN (already swapped — Jing rejects double deposit)", function () {
    // Jing's `deposit-sbtc` rejects a second deposit by the same depositor in
    // the same cycle. We expect *some* error — we just confirm it did not OK.
    setupSwapped();
    const res = pub(SNPL, "swap-deposit", [Cl.uint(1), Cl.uint(LIMIT_PRICE)], wallet2);
    expect(res.result.type).toBe("err");
  });

  // ------------------------------------------------------------------
  // cancel-swap
  // ------------------------------------------------------------------

  it("cancel-swap: rejects unknown loan-id", function () {
    setupSwapped();
    expect(pub(SNPL, "cancel-swap", [Cl.uint(999)], wallet2).result)
      .toBeErr(Cl.uint(ERR_LOAN_NOT_FOUND));
  });

  it("cancel-swap: rejects non-borrower before deadline", function () {
    setupSwapped();
    expect(pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("cancel-swap: borrower pulls sBTC back from Jing", function () {
    setupSwapped();
    const before = getSbtcBalance(SNPL_ID);
    expect(pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2).result).toBeOk(Cl.bool(true));
    expect(getSbtcBalance(SNPL_ID)).toBe(before + SBTC_22M);
    expect(getOurSbtcInJing()).toBe(0);
    // Loan status unchanged
    expect(getLoanFields(1)["status"]).toBe(String(STATUS_OPEN));
  });

  it("cancel-swap: anyone can cancel after deadline", function () {
    setupSwapped();
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet3).result).toBeOk(Cl.bool(true));
    expect(getOurSbtcInJing()).toBe(0);
  });

  it("cancel-swap: rejects bad status (loan repaid)", function () {
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);
    fundSbtc(wallet2, SBTC_5M); // cover interest
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));
    expect(pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2).result)
      .toBeErr(Cl.uint(ERR_BAD_STATUS));
  });

});

// Extended suite — opt-in via EXTENDED=1 env var. Each test passes in
// isolation, but bundling them with the core 25 above exhausts the anonymous
// Hiro API rate limit. The clarinet-sdk WASM panics with the exact upstream
// message: "Per-minute rate limit exceeded for stacks quota". When the panic
// is suppressed (or the API returns a different transient error), state
// lookups fall back to defaults — SBTC_WHALE balance reads as 0, and the
// next `supply` call returns sBTC error u1 (insufficient balance).
//
// To fix permanently: set HIRO_API_KEY (free tier 100 req/min) by adding
// `api_key = "..."` under [repl.remote_data] in Clarinet.toml.
//
// To run a slice of the extended suite (no key needed):
//   EXTENDED=1 npx vitest run tests/loan-sbtc-stx-0-jing.test.ts -t "set-swap-limit"
//   EXTENDED=1 npx vitest run tests/loan-sbtc-stx-0-jing.test.ts -t "repay"
//   EXTENDED=1 npx vitest run tests/loan-sbtc-stx-0-jing.test.ts -t "seize"
//   EXTENDED=1 npx vitest run tests/loan-sbtc-stx-0-jing.test.ts -t "sequential"
const RUN_EXTENDED = process.env.EXTENDED === "1";
describe.skipIf(!remoteDataEnabled || !RUN_EXTENDED)(
  "loan-sbtc-stx-0-jing (snpl) > extended (opt-in via EXTENDED=1)",
  function () {

  // ------------------------------------------------------------------
  // set-swap-limit
  // ------------------------------------------------------------------

  it("set-swap-limit: rejects non-borrower", function () {
    setupSwapped();
    expect(pub(SNPL, "set-swap-limit", [Cl.uint(1), Cl.uint(LIMIT_PRICE + 1)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("set-swap-limit: rejects past deadline", function () {
    setupSwapped();
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(SNPL, "set-swap-limit", [Cl.uint(1), Cl.uint(LIMIT_PRICE + 1)], wallet2).result)
      .toBeErr(Cl.uint(ERR_PAST_DEADLINE));
  });

  it("set-swap-limit: borrower updates limit, Jing limit reflects", function () {
    setupSwapped();
    const NEW_LIMIT = LIMIT_PRICE + 1_000_000_000_000;
    expect(pub(SNPL, "set-swap-limit", [Cl.uint(1), Cl.uint(NEW_LIMIT)], wallet2).result)
      .toBeOk(Cl.bool(true));
    expect(getLoanFields(1)["limit-price"]).toBe(String(NEW_LIMIT));
    // Jing's per-principal limit also reflects the change
    const limitOnJing = cvToJSON(
      simnet.callReadOnlyFn(
        JING_MARKET,
        "get-sbtc-limit",
        [Cl.contractPrincipal(deployer, SNPL)],
        deployer
      ).result
    );
    expect(limitOnJing.value).toBe(String(NEW_LIMIT));
  });

  it("set-swap-limit: rejects unknown loan-id (ERR-LOAN-NOT-FOUND)", function () {
    setupSwapped();
    expect(pub(SNPL, "set-swap-limit", [Cl.uint(999), Cl.uint(LIMIT_PRICE)], wallet2).result)
      .toBeErr(Cl.uint(ERR_LOAN_NOT_FOUND));
  });

  it("set-swap-limit: rejects bad status (loan repaid)", function () {
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);
    fundSbtc(wallet2, SBTC_1M);
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));
    expect(pub(SNPL, "set-swap-limit", [Cl.uint(1), Cl.uint(LIMIT_PRICE)], wallet2).result)
      .toBeErr(Cl.uint(ERR_BAD_STATUS));
  });

  // ------------------------------------------------------------------
  // repay
  // ------------------------------------------------------------------

  it("repay: rejects non-borrower", function () {
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_BORROWER));
  });

  it("repay: rejects when sBTC still in Jing (ERR-NOT-FULLY-RESOLVED)", function () {
    setupSwapped();
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeErr(Cl.uint(ERR_NOT_FULLY_RESOLVED));
  });

  it("repay: rejects unknown loan-id", function () {
    setupBorrowed();
    expect(pub(SNPL, "repay", [Cl.uint(999), RESERVE_TRAIT], wallet2).result)
      .toBeErr(Cl.uint(ERR_LOAN_NOT_FOUND));
  });

  it("repay: rejects wrong reserve trait reference (ERR-WRONG-RESERVE)", function () {
    // WRONG-RESERVE is asserted before NOT-FULLY-RESOLVED, so a fresh borrow
    // with sBTC still in the snpl (never deposited to Jing) is enough to hit it.
    setupBorrowed();
    deployWrongReserve();
    expect(pub(SNPL, "repay", [Cl.uint(1), WRONG_RESERVE_TRAIT], wallet2).result)
      .toBeErr(Cl.uint(ERR_WRONG_RESERVE));
  });

  it("repay (shortfall): borrower tops up interest, fee→treasury, payoff→reserve", function () {
    // Cancel-swap stand-in: snpl ends with full notional sBTC; payoff = notional + interest.
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);

    const notional = SBTC_22M;
    const payoff = expectedPayoff(notional);
    const interest = payoff - notional;
    const fee = Math.floor((interest * FEE_BPS_OF_INTEREST) / BPS_PRECISION);
    const lenderShare = payoff - fee;
    const shortfall = payoff - notional; // = interest

    fundSbtc(wallet2, shortfall + 100); // exact + buffer
    const treasuryBefore = getSbtcBalance(JING_TREASURY);
    const reserveBefore = getSbtcBalance(RESERVE_ID);

    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));

    // Snpl drained
    expect(getSbtcBalance(SNPL_ID)).toBe(0);
    // Treasury got exactly `fee`
    expect(getSbtcBalance(JING_TREASURY)).toBe(treasuryBefore + fee);
    // Reserve got `lenderShare`
    expect(getSbtcBalance(RESERVE_ID)).toBe(reserveBefore + lenderShare);
    // Loan flipped to REPAID, active-loan cleared
    expect(getLoanFields(1)["status"]).toBe(String(STATUS_REPAID));
    expect(ro(SNPL, "get-active-loan", [])).toBeOk(Cl.none());
    // Reserve outstanding is 0
    const line = cvToJSON(ro(RESERVE, "get-credit-line", [Cl.principal(SNPL_ID)]));
    expect(line.value.value["outstanding-sbtc"].value).toBe("0");
  });

  it("repay (excess sBTC): refund branch returns excess to borrower", function () {
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);

    // Airdrop more than payoff onto the snpl so sbtc-balance > payoff.
    const EXTRA = 5_000_000;
    fundSbtc(SNPL_ID, EXTRA);

    const borrowerBefore = getSbtcBalance(wallet2);
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));
    // payoff was covered fully from on-snpl balance; excess refunded.
    const refund = (SBTC_22M + EXTRA) - expectedPayoff(SBTC_22M);
    expect(getSbtcBalance(wallet2)).toBe(borrowerBefore + refund);
  });

  it("repay (STX-release): stx-out > 0 path ships STX to borrower", function () {
    // Simulate Jing settlement having pushed STX into the snpl, then borrower
    // repays. Verifies the (if (> stx-out u0) ...) branch.
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);

    const STX_AIRDROP = 50_000_000; // 50 STX
    simnet.transferSTX(STX_AIRDROP, SNPL_ID, wallet3);
    expect(getStxBalance(SNPL_ID)).toBe(STX_AIRDROP);

    const interest = expectedPayoff(SBTC_22M) - SBTC_22M;
    fundSbtc(wallet2, interest + 100);
    const borrowerStxBefore = getStxBalance(wallet2);

    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));

    expect(getStxBalance(SNPL_ID)).toBe(0);
    expect(getStxBalance(wallet2)).toBe(borrowerStxBefore + STX_AIRDROP);
    // position-stx stamped on the loan record
    expect(getLoanFields(1)["position-stx"]).toBe(String(STX_AIRDROP));
  });

  it("repay: rejects bad status (already repaid)", function () {
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);
    fundSbtc(wallet2, SBTC_1M);
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeErr(Cl.uint(ERR_BAD_STATUS));
  });

  // ------------------------------------------------------------------
  // seize
  // ------------------------------------------------------------------

  it("seize: rejects unknown loan-id", function () {
    setupBorrowed();
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(SNPL, "seize", [Cl.uint(999), RESERVE_TRAIT], wallet3).result)
      .toBeErr(Cl.uint(ERR_LOAN_NOT_FOUND));
  });

  it("seize: rejects before deadline (ERR-DEADLINE-NOT-REACHED)", function () {
    setupBorrowed();
    expect(pub(SNPL, "seize", [Cl.uint(1), RESERVE_TRAIT], wallet3).result)
      .toBeErr(Cl.uint(ERR_DEADLINE_NOT_REACHED));
  });

  it("seize: rejects wrong reserve trait reference (ERR-WRONG-RESERVE)", function () {
    // WRONG-RESERVE is asserted before DEADLINE-NOT-REACHED and NOT-FULLY-RESOLVED.
    setupBorrowed();
    deployWrongReserve();
    expect(pub(SNPL, "seize", [Cl.uint(1), WRONG_RESERVE_TRAIT], wallet3).result)
      .toBeErr(Cl.uint(ERR_WRONG_RESERVE));
  });

  it("seize: rejects when sBTC still in Jing (ERR-NOT-FULLY-RESOLVED)", function () {
    setupSwapped();
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(SNPL, "seize", [Cl.uint(1), RESERVE_TRAIT], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_FULLY_RESOLVED));
  });

  it("seize: permissionless past deadline, ships sBTC + STX to reserve, no protocol fee", function () {
    // Borrow but never deposit to Jing — Jing position is naturally 0.
    setupBorrowed();
    // Airdrop STX to simulate prior settlement output sitting on snpl
    const STX_AIRDROP = 30_000_000;
    simnet.transferSTX(STX_AIRDROP, SNPL_ID, wallet3);

    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);

    const treasuryBefore = getSbtcBalance(JING_TREASURY);
    const reserveSbtcBefore = getSbtcBalance(RESERVE_ID);
    const reserveStxBefore = getStxBalance(RESERVE_ID);

    // wallet3 (an outsider, not borrower or lender) calls seize — permissionless
    expect(pub(SNPL, "seize", [Cl.uint(1), RESERVE_TRAIT], wallet3).result)
      .toBeOk(Cl.bool(true));

    // Both legs ship to reserve
    expect(getSbtcBalance(SNPL_ID)).toBe(0);
    expect(getStxBalance(SNPL_ID)).toBe(0);
    expect(getSbtcBalance(RESERVE_ID)).toBe(reserveSbtcBefore + SBTC_22M);
    expect(getStxBalance(RESERVE_ID)).toBe(reserveStxBefore + STX_AIRDROP);
    // No protocol fee on seize
    expect(getSbtcBalance(JING_TREASURY)).toBe(treasuryBefore);
    // Status flipped, active-loan cleared, outstanding zeroed
    expect(getLoanFields(1)["status"]).toBe(String(STATUS_SEIZED));
    expect(ro(SNPL, "get-active-loan", [])).toBeOk(Cl.none());
    const line = cvToJSON(ro(RESERVE, "get-credit-line", [Cl.principal(SNPL_ID)]));
    expect(line.value.value["outstanding-sbtc"].value).toBe("0");
  });

  it("seize: rejects bad status (loan already repaid)", function () {
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);
    fundSbtc(wallet2, SBTC_1M);
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result)
      .toBeOk(Cl.bool(true));
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(SNPL, "seize", [Cl.uint(1), RESERVE_TRAIT], wallet3).result)
      .toBeErr(Cl.uint(ERR_BAD_STATUS));
  });

  // ------------------------------------------------------------------
  // Sequential loans (canonical-bytecode property: loan id increments)
  // ------------------------------------------------------------------

  it("sequential: borrow → cancel → repay → re-borrow gets loan id 2", function () {
    setupSwapped();
    pub(SNPL, "cancel-swap", [Cl.uint(1)], wallet2);
    fundSbtc(wallet2, SBTC_1M);
    expect(pub(SNPL, "repay", [Cl.uint(1), RESERVE_TRAIT], wallet2).result).toBeOk(Cl.bool(true));

    // Lender refills the credit line with the recovered principal: outstanding
    // already returned to 0 via notify-return, so a fresh borrow up to cap works.
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeOk(Cl.uint(2));
    expect(ro(SNPL, "get-active-loan", [])).toBeOk(Cl.some(Cl.uint(2)));
  });
});
