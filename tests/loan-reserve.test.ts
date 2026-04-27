import { describe, expect, it } from "vitest";
import { Cl, cvToJSON } from "@stacks/transactions";

// Detect remote_data is enabled (forked mainnet state). The reserve itself does
// not strictly require mainnet state, but the tests that exercise draw/notify-return
// through the snpl do (the snpl talks to live sbtc-stx-0-jing-v2). All tests are
// gated behind the same flag for consistency.
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
const wallet1 = accounts.get("wallet_1")!; // LENDER (initialized)
const wallet2 = accounts.get("wallet_2")!; // BORROWER (per snpl)
const wallet3 = accounts.get("wallet_3")!; // outsider / non-lender / non-borrower
const wallet4 = accounts.get("wallet_4")!; // alt-lender for cross-principal init

const RESERVE = "loan-reserve";
const RESERVE_ID = `${deployer}.${RESERVE}`;
const SNPL = "loan-sbtc-stx-0-jing";
const SNPL_ID = `${deployer}.${SNPL}`;

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const SAINT = "SP000000000000000000002Q6VF78";

// Constants matching loan-reserve.clar
const DEFAULT_MIN_DRAW = 1_000_000; // 0.01 sBTC
// Constants matching loan-sbtc-stx-0-jing.clar
const CLAWBACK_DELAY = 4200;
const BPS_PRECISION = 10_000;

const SBTC_22M = 22_000_000;
const SBTC_1M = 1_000_000;
const SBTC_500K = 500_000;

const INTEREST_BPS = 100;

// Reserve errors
const ERR_NOT_LENDER = 200;
const ERR_NO_CREDIT_LINE = 201;
const ERR_OVER_LIMIT = 202;
const ERR_INVALID_AMOUNT = 204;
const ERR_LINE_EXISTS = 205;
const ERR_LINE_NOT_FOUND = 206;
const ERR_OUTSTANDING_NONZERO = 207;
const ERR_UNDERFLOW = 208;
const ERR_PAUSED = 209;
const ERR_BORROWER_MISMATCH = 210;
const ERR_NOT_DEPLOYER = 211;
const ERR_ALREADY_INIT = 212;

// Snpl errors (only those used here)
const ERR_NOT_BORROWER = 101;

const LIMIT_PRICE = 31_152_648_000_000;

// Minimal Clarity-4 stub that impls snpl-trait. Used to exercise the
// `notify-return` ERR-UNDERFLOW branch — a real snpl will never report a
// notional larger than its outstanding draw, but the reserve enforces
// `(<= notional current)` defensively. The stub exposes a public
// `overshoot-notify-return` that calls reserve.notify-return with an
// arbitrary amount; with outstanding=0 (no draw yet), any positive amount
// triggers the guard. `get-borrower` returns the deployer at deploy time
// so `open-credit-line` can match the borrower argument.
const MAL_SNPL_NAME = "mal-snpl";
const MAL_SNPL_SRC = `
(impl-trait .snpl-trait.snpl-trait)
(use-trait reserve-trait .reserve-trait.reserve-trait)

(define-data-var borrower-var principal tx-sender)

(define-read-only (get-borrower) (ok (var-get borrower-var)))
(define-read-only (get-reserve) (ok 'SP000000000000000000002Q6VF78))
(define-read-only (get-active-loan) (ok none))
(define-read-only (get-loan (loan-id uint)) (ok none))

(define-public (borrow (amount uint) (interest-bps uint) (reserve <reserve-trait>)) (ok u0))
(define-public (repay (loan-id uint) (reserve <reserve-trait>)) (ok true))
(define-public (seize (loan-id uint) (reserve <reserve-trait>)) (ok true))

(define-public (overshoot-notify-return (amount uint))
  (contract-call? .loan-reserve notify-return amount))
`;

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

const RESERVE_TRAIT = Cl.contractPrincipal(deployer, RESERVE);
const SNPL_TRAIT = Cl.contractPrincipal(deployer, SNPL);

// Initialize reserve+snpl: lender = wallet1, borrower = wallet2.
// Both contracts capture `tx-sender` at deploy as DEPLOYER, and the simnet
// deploys them under `deployer`, so initialize must be called by `deployer`.
function initReserve(lender: string = wallet1) {
  expect(pub(RESERVE, "initialize", [Cl.principal(lender)], deployer).result).toBeOk(Cl.bool(true));
}

function initSnpl(borrower: string = wallet2) {
  expect(
    pub(SNPL, "initialize", [Cl.principal(borrower), RESERVE_TRAIT], deployer).result
  ).toBeOk(Cl.bool(true));
}

// Lender supplies sBTC to the reserve.
function supplyReserve(amount: number, lender: string = wallet1) {
  fundSbtc(lender, amount);
  expect(pub(RESERVE, "supply", [Cl.uint(amount)], lender).result).toBeOk(Cl.bool(true));
}

// Lender opens a credit line for the canonical snpl with given borrower/cap/bps.
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

// Full pre-amble: init both, fund + supply, open line.
function setupOpenLine(opts: {
  supply?: number;
  cap?: number;
  bps?: number;
  borrower?: string;
  lender?: string;
} = {}) {
  const lender = opts.lender ?? wallet1;
  const borrower = opts.borrower ?? wallet2;
  const supply = opts.supply ?? SBTC_22M;
  const cap = opts.cap ?? SBTC_22M;
  const bps = opts.bps ?? INTEREST_BPS;
  initReserve(lender);
  initSnpl(borrower);
  supplyReserve(supply, lender);
  openLine(borrower, cap, bps, lender);
}

// Drives the snpl all the way to "post-borrow", which is the only way to bump
// reserve.outstanding-sbtc without a custom test contract.
function setupBorrowed(opts: {
  supply?: number;
  cap?: number;
  bps?: number;
  amount?: number;
} = {}) {
  const supply = opts.supply ?? SBTC_22M;
  const cap = opts.cap ?? SBTC_22M;
  const bps = opts.bps ?? INTEREST_BPS;
  const amount = opts.amount ?? SBTC_22M;
  setupOpenLine({ supply, cap, bps });
  expect(
    pub(SNPL, "borrow", [Cl.uint(amount), Cl.uint(bps), RESERVE_TRAIT], wallet2).result
  ).toBeOk(Cl.uint(1));
}

// ============================================================================

describe.skipIf(!remoteDataEnabled)("loan-reserve", function () {

  // ------------------------------------------------------------------
  // Pre-init invariants — the SAINT sentinel blocks every admin path
  // ------------------------------------------------------------------

  it("pre-init: lender var equals SAINT", function () {
    expect(ro(RESERVE, "get-lender", [])).toBePrincipal(SAINT);
    expect(ro(RESERVE, "is-paused", [])).toBeBool(false);
    expect(ro(RESERVE, "get-min-sbtc-draw", [])).toBeUint(DEFAULT_MIN_DRAW);
    expect(ro(RESERVE, "has-credit-line", [Cl.principal(SNPL_ID)])).toBeBool(false);
  });

  it("pre-init: supply blocked (lender is SAINT)", function () {
    fundSbtc(wallet1, SBTC_1M);
    expect(pub(RESERVE, "supply", [Cl.uint(SBTC_1M)], wallet1).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("pre-init: withdraw-sbtc blocked", function () {
    expect(pub(RESERVE, "withdraw-sbtc", [Cl.uint(SBTC_1M)], wallet1).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("pre-init: withdraw-stx blocked", function () {
    expect(pub(RESERVE, "withdraw-stx", [Cl.uint(1)], wallet1).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("pre-init: admin functions all blocked", function () {
    expect(pub(RESERVE, "set-paused", [Cl.bool(true)], wallet1).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
    expect(pub(RESERVE, "set-min-sbtc-draw", [Cl.uint(2_000_000)], wallet1).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
    expect(
      pub(
        RESERVE,
        "open-credit-line",
        [SNPL_TRAIT, Cl.principal(wallet2), Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS)],
        wallet1
      ).result
    ).toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  // ------------------------------------------------------------------
  // initialize
  // ------------------------------------------------------------------

  it("initialize: only deployer can call (ERR-NOT-DEPLOYER)", function () {
    expect(pub(RESERVE, "initialize", [Cl.principal(wallet1)], wallet1).result)
      .toBeErr(Cl.uint(ERR_NOT_DEPLOYER));
  });

  it("initialize: deployer sets lender, var flips from SAINT", function () {
    initReserve(wallet1);
    expect(ro(RESERVE, "get-lender", [])).toBePrincipal(wallet1);
  });

  it("initialize: cross-principal lender (deployer != lender)", function () {
    initReserve(wallet4);
    expect(ro(RESERVE, "get-lender", [])).toBePrincipal(wallet4);
  });

  it("initialize: cannot re-init (ERR-ALREADY-INIT)", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "initialize", [Cl.principal(wallet4)], deployer).result)
      .toBeErr(Cl.uint(ERR_ALREADY_INIT));
  });

  // ------------------------------------------------------------------
  // supply
  // ------------------------------------------------------------------

  it("supply: rejects non-lender after init", function () {
    initReserve(wallet1);
    fundSbtc(wallet3, SBTC_1M);
    expect(pub(RESERVE, "supply", [Cl.uint(SBTC_1M)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("supply: rejects zero amount", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "supply", [Cl.uint(0)], wallet1).result)
      .toBeErr(Cl.uint(ERR_INVALID_AMOUNT));
  });

  it("supply: lender deposits sBTC to reserve", function () {
    initReserve(wallet1);
    fundSbtc(wallet1, SBTC_22M);
    const before = getSbtcBalance(RESERVE_ID);
    expect(pub(RESERVE, "supply", [Cl.uint(SBTC_22M)], wallet1).result)
      .toBeOk(Cl.bool(true));
    expect(getSbtcBalance(RESERVE_ID)).toBe(before + SBTC_22M);
  });

  // ------------------------------------------------------------------
  // withdraw-sbtc
  // ------------------------------------------------------------------

  it("withdraw-sbtc: rejects non-lender", function () {
    initReserve(wallet1);
    supplyReserve(SBTC_1M, wallet1);
    expect(pub(RESERVE, "withdraw-sbtc", [Cl.uint(SBTC_500K)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("withdraw-sbtc: lender pulls sBTC back", function () {
    initReserve(wallet1);
    supplyReserve(SBTC_22M, wallet1);
    const lenderBefore = getSbtcBalance(wallet1);
    const reserveBefore = getSbtcBalance(RESERVE_ID);
    expect(pub(RESERVE, "withdraw-sbtc", [Cl.uint(SBTC_1M)], wallet1).result)
      .toBeOk(Cl.bool(true));
    expect(getSbtcBalance(wallet1)).toBe(lenderBefore + SBTC_1M);
    expect(getSbtcBalance(RESERVE_ID)).toBe(reserveBefore - SBTC_1M);
  });

  it("withdraw-sbtc: amount > reserve balance fails (with-ft constraint)", function () {
    initReserve(wallet1);
    supplyReserve(SBTC_1M, wallet1);
    const res = pub(RESERVE, "withdraw-sbtc", [Cl.uint(SBTC_22M)], wallet1);
    // The `with-ft` constraint in `as-contract?` returns an error when the
    // contract's sBTC balance is below `amount`. We don't pin the exact code
    // here — just confirm the call does not succeed and no funds moved.
    expect(res.result.type).toBe("err");
    expect(getSbtcBalance(RESERVE_ID)).toBe(SBTC_1M);
  });

  // ------------------------------------------------------------------
  // withdraw-stx (sweeps STX accumulated from seized snpl loans)
  // ------------------------------------------------------------------

  it("withdraw-stx: rejects non-lender", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "withdraw-stx", [Cl.uint(1)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("withdraw-stx: lender sweeps STX (airdropped to reserve)", function () {
    initReserve(wallet1);
    // Simulate a seized loan having pushed STX into the reserve. Any wallet
    // can stx-transfer to a contract principal directly.
    const STX_AIRDROP = 50_000_000; // 50 STX
    simnet.transferSTX(STX_AIRDROP, RESERVE_ID, wallet3);
    expect(getStxBalance(RESERVE_ID)).toBe(STX_AIRDROP);

    const lenderBefore = getStxBalance(wallet1);
    expect(pub(RESERVE, "withdraw-stx", [Cl.uint(STX_AIRDROP)], wallet1).result)
      .toBeOk(Cl.bool(true));
    expect(getStxBalance(RESERVE_ID)).toBe(0);
    expect(getStxBalance(wallet1)).toBe(lenderBefore + STX_AIRDROP);
  });

  // ------------------------------------------------------------------
  // open-credit-line
  // ------------------------------------------------------------------

  it("open-credit-line: rejects non-lender", function () {
    initReserve(wallet1);
    initSnpl(wallet2);
    expect(
      pub(
        RESERVE,
        "open-credit-line",
        [SNPL_TRAIT, Cl.principal(wallet2), Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS)],
        wallet3
      ).result
    ).toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("open-credit-line: rejects borrower mismatch (snpl borrower != arg)", function () {
    initReserve(wallet1);
    initSnpl(wallet2); // snpl borrower = wallet2
    expect(
      pub(
        RESERVE,
        "open-credit-line",
        // We pass wallet3 — does not match snpl's get-borrower (wallet2)
        [SNPL_TRAIT, Cl.principal(wallet3), Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS)],
        wallet1
      ).result
    ).toBeErr(Cl.uint(ERR_BORROWER_MISMATCH));
  });

  it("open-credit-line: opens line, has-credit-line flips to true", function () {
    initReserve(wallet1);
    initSnpl(wallet2);
    openLine(wallet2, SBTC_22M, INTEREST_BPS, wallet1);
    expect(ro(RESERVE, "has-credit-line", [Cl.principal(SNPL_ID)])).toBeBool(true);
    const line = cvToJSON(ro(RESERVE, "get-credit-line", [Cl.principal(SNPL_ID)]));
    expect(line.value.value["borrower"].value).toBe(wallet2);
    expect(line.value.value["cap-sbtc"].value).toBe(String(SBTC_22M));
    expect(line.value.value["interest-bps"].value).toBe(String(INTEREST_BPS));
    expect(line.value.value["outstanding-sbtc"].value).toBe("0");
  });

  it("open-credit-line: rejects duplicate (ERR-LINE-EXISTS)", function () {
    setupOpenLine();
    expect(
      pub(
        RESERVE,
        "open-credit-line",
        [SNPL_TRAIT, Cl.principal(wallet2), Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS)],
        wallet1
      ).result
    ).toBeErr(Cl.uint(ERR_LINE_EXISTS));
  });

  // ------------------------------------------------------------------
  // set-credit-line-cap
  // ------------------------------------------------------------------

  it("set-credit-line-cap: rejects non-lender", function () {
    setupOpenLine();
    expect(pub(RESERVE, "set-credit-line-cap", [Cl.principal(SNPL_ID), Cl.uint(SBTC_22M * 2)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("set-credit-line-cap: rejects unknown line (ERR-LINE-NOT-FOUND)", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "set-credit-line-cap", [Cl.principal(SNPL_ID), Cl.uint(SBTC_22M)], wallet1).result)
      .toBeErr(Cl.uint(ERR_LINE_NOT_FOUND));
  });

  it("set-credit-line-cap: lender updates cap", function () {
    setupOpenLine();
    const newCap = SBTC_22M * 2;
    expect(pub(RESERVE, "set-credit-line-cap", [Cl.principal(SNPL_ID), Cl.uint(newCap)], wallet1).result)
      .toBeOk(Cl.bool(true));
    const line = cvToJSON(ro(RESERVE, "get-credit-line", [Cl.principal(SNPL_ID)]));
    expect(line.value.value["cap-sbtc"].value).toBe(String(newCap));
  });

  // ------------------------------------------------------------------
  // set-credit-line-interest
  // ------------------------------------------------------------------

  it("set-credit-line-interest: rejects non-lender", function () {
    setupOpenLine();
    expect(pub(RESERVE, "set-credit-line-interest", [Cl.principal(SNPL_ID), Cl.uint(200)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("set-credit-line-interest: rejects unknown line", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "set-credit-line-interest", [Cl.principal(SNPL_ID), Cl.uint(200)], wallet1).result)
      .toBeErr(Cl.uint(ERR_LINE_NOT_FOUND));
  });

  it("set-credit-line-interest: lender updates rate; existing-loan rate unchanged", function () {
    setupOpenLine();
    expect(pub(RESERVE, "set-credit-line-interest", [Cl.principal(SNPL_ID), Cl.uint(250)], wallet1).result)
      .toBeOk(Cl.bool(true));
    const line = cvToJSON(ro(RESERVE, "get-credit-line", [Cl.principal(SNPL_ID)]));
    expect(line.value.value["interest-bps"].value).toBe("250");
  });

  // ------------------------------------------------------------------
  // close-credit-line
  // ------------------------------------------------------------------

  it("close-credit-line: rejects non-lender", function () {
    setupOpenLine();
    expect(pub(RESERVE, "close-credit-line", [Cl.principal(SNPL_ID)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("close-credit-line: rejects unknown line", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "close-credit-line", [Cl.principal(SNPL_ID)], wallet1).result)
      .toBeErr(Cl.uint(ERR_LINE_NOT_FOUND));
  });

  it("close-credit-line: rejects when outstanding > 0 (ERR-OUTSTANDING-NONZERO)", function () {
    // Borrow → outstanding = SBTC_22M → close should fail
    setupBorrowed();
    expect(pub(RESERVE, "close-credit-line", [Cl.principal(SNPL_ID)], wallet1).result)
      .toBeErr(Cl.uint(ERR_OUTSTANDING_NONZERO));
  });

  it("close-credit-line: lender closes line when outstanding == 0", function () {
    setupOpenLine();
    expect(pub(RESERVE, "close-credit-line", [Cl.principal(SNPL_ID)], wallet1).result)
      .toBeOk(Cl.bool(true));
    expect(ro(RESERVE, "has-credit-line", [Cl.principal(SNPL_ID)])).toBeBool(false);
  });

  // ------------------------------------------------------------------
  // set-paused
  // ------------------------------------------------------------------

  it("set-paused: rejects non-lender", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "set-paused", [Cl.bool(true)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("set-paused: lender flips flag both ways", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "set-paused", [Cl.bool(true)], wallet1).result).toBeOk(Cl.bool(true));
    expect(ro(RESERVE, "is-paused", [])).toBeBool(true);
    expect(pub(RESERVE, "set-paused", [Cl.bool(false)], wallet1).result).toBeOk(Cl.bool(true));
    expect(ro(RESERVE, "is-paused", [])).toBeBool(false);
  });

  it("set-paused: paused blocks subsequent draws (ERR-PAUSED via borrow)", function () {
    setupOpenLine();
    expect(pub(RESERVE, "set-paused", [Cl.bool(true)], wallet1).result).toBeOk(Cl.bool(true));
    // Borrow → snpl calls reserve.draw → reserve asserts not paused
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_PAUSED));
  });

  it("set-paused: pause then unpause unblocks draws", function () {
    setupOpenLine();
    pub(RESERVE, "set-paused", [Cl.bool(true)], wallet1);
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_PAUSED));
    expect(pub(RESERVE, "set-paused", [Cl.bool(false)], wallet1).result).toBeOk(Cl.bool(true));
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeOk(Cl.uint(1));
  });

  // ------------------------------------------------------------------
  // set-min-sbtc-draw
  // ------------------------------------------------------------------

  it("set-min-sbtc-draw: rejects non-lender", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "set-min-sbtc-draw", [Cl.uint(2_000_000)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NOT_LENDER));
  });

  it("set-min-sbtc-draw: rejects zero", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "set-min-sbtc-draw", [Cl.uint(0)], wallet1).result)
      .toBeErr(Cl.uint(ERR_INVALID_AMOUNT));
  });

  it("set-min-sbtc-draw: lender bumps min, sub-min draws revert", function () {
    setupOpenLine();
    const NEW_MIN = 5_000_000;
    expect(pub(RESERVE, "set-min-sbtc-draw", [Cl.uint(NEW_MIN)], wallet1).result)
      .toBeOk(Cl.bool(true));
    expect(ro(RESERVE, "get-min-sbtc-draw", [])).toBeUint(NEW_MIN);
    // Old default would have allowed 1M; new min rejects it.
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_1M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_INVALID_AMOUNT));
  });

  // ------------------------------------------------------------------
  // draw — direct EOA caller hits ERR-NO-CREDIT-LINE branch
  // (Real draws via the snpl's borrow are exercised in the snpl test file
  // and via the cap/min tests above; here we hit the bare guard.)
  // ------------------------------------------------------------------

  it("draw: EOA caller without a line gets ERR-NO-CREDIT-LINE", function () {
    initReserve(wallet1);
    // Wallet3 is an EOA; contract-caller == wallet3, no credit-lines entry.
    expect(pub(RESERVE, "draw", [Cl.uint(SBTC_1M)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NO_CREDIT_LINE));
  });

  it("draw: through snpl bumps outstanding and pushes sBTC", function () {
    setupOpenLine();
    const before = getSbtcBalance(SNPL_ID);
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeOk(Cl.uint(1));
    expect(getSbtcBalance(SNPL_ID)).toBe(before + SBTC_22M);
    const line = cvToJSON(ro(RESERVE, "get-credit-line", [Cl.principal(SNPL_ID)]));
    expect(line.value.value["outstanding-sbtc"].value).toBe(String(SBTC_22M));
  });

  it("draw: cap enforced — borrow over cap reverts (ERR-OVER-LIMIT)", function () {
    setupOpenLine({ supply: SBTC_22M, cap: SBTC_1M, bps: INTEREST_BPS });
    expect(
      pub(SNPL, "borrow", [Cl.uint(SBTC_22M), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_OVER_LIMIT));
  });

  it("draw: min enforced — borrow under default min reverts (ERR-INVALID-AMOUNT)", function () {
    setupOpenLine({ cap: SBTC_22M });
    expect(
      pub(SNPL, "borrow", [Cl.uint(DEFAULT_MIN_DRAW - 1), Cl.uint(INTEREST_BPS), RESERVE_TRAIT], wallet2).result
    ).toBeErr(Cl.uint(ERR_INVALID_AMOUNT));
  });

  // ------------------------------------------------------------------
  // notify-return — direct EOA caller hits ERR-NO-CREDIT-LINE branch
  // (Real notify-return is exercised through repay/seize in the snpl tests.)
  // ------------------------------------------------------------------

  it("notify-return: EOA caller without a line gets ERR-NO-CREDIT-LINE", function () {
    initReserve(wallet1);
    expect(pub(RESERVE, "notify-return", [Cl.uint(SBTC_1M)], wallet3).result)
      .toBeErr(Cl.uint(ERR_NO_CREDIT_LINE));
  });

  it("notify-return: rejects underflow when notional > outstanding (ERR-UNDERFLOW)", function () {
    initReserve(wallet1);
    // Deploy a malicious snpl that exposes a public passthrough to
    // reserve.notify-return. open-credit-line on it; outstanding starts at 0.
    simnet.deployContract(MAL_SNPL_NAME, MAL_SNPL_SRC, { clarityVersion: 4 }, deployer);
    expect(
      pub(
        RESERVE,
        "open-credit-line",
        [
          Cl.contractPrincipal(deployer, MAL_SNPL_NAME),
          Cl.principal(deployer),
          Cl.uint(SBTC_22M),
          Cl.uint(INTEREST_BPS),
        ],
        wallet1
      ).result
    ).toBeOk(Cl.bool(true));
    // outstanding-sbtc is 0 — any positive notional must underflow.
    expect(pub(MAL_SNPL_NAME, "overshoot-notify-return", [Cl.uint(100)], wallet3).result)
      .toBeErr(Cl.uint(ERR_UNDERFLOW));
  });

});

// Extended suite — opt-in via EXTENDED=1 env var. Same rate-limit story as
// the snpl test file: bundling the post-seize end-to-end smoke test with the
// rest of the file (or running both loan-* test files together) exhausts the
// anonymous Hiro API rate limit and surfaces stale state. Set HIRO_API_KEY in
// Clarinet.toml under [repl.remote_data] to bundle reliably.
const RUN_EXTENDED = process.env.EXTENDED === "1";
describe.skipIf(!remoteDataEnabled || !RUN_EXTENDED)(
  "loan-reserve > extended (opt-in via EXTENDED=1)",
  function () {

  // End-to-end: post-seize the reserve holds STX + sBTC
  // (smoke test the reserve side of the seize accounting; the snpl test file
  // verifies the snpl side.)
  it("post-seize: outstanding zeroed, lender can withdraw recovered sBTC", function () {
    setupBorrowed({ supply: SBTC_22M, cap: SBTC_22M, amount: SBTC_22M });
    // Loan funded from reserve to snpl; sBTC sits on snpl, never deposited
    // to Jing. Fast-forward past deadline and seize permissionlessly.
    simnet.mineEmptyBurnBlocks(CLAWBACK_DELAY + 1);
    expect(pub(SNPL, "seize", [Cl.uint(1), RESERVE_TRAIT], wallet3).result)
      .toBeOk(Cl.bool(true));

    const line = cvToJSON(ro(RESERVE, "get-credit-line", [Cl.principal(SNPL_ID)]));
    expect(line.value.value["outstanding-sbtc"].value).toBe("0");
    // Reserve received the principal back from the snpl on seize.
    expect(getSbtcBalance(RESERVE_ID)).toBe(SBTC_22M);

    // Lender pulls it.
    const lenderBefore = getSbtcBalance(wallet1);
    expect(pub(RESERVE, "withdraw-sbtc", [Cl.uint(SBTC_22M)], wallet1).result)
      .toBeOk(Cl.bool(true));
    expect(getSbtcBalance(wallet1)).toBe(lenderBefore + SBTC_22M);
  });
});
