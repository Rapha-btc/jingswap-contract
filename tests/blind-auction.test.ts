import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;
const wallet3 = accounts.get("wallet_3")!;
const wallet4 = accounts.get("wallet_4")!;
const wallet5 = accounts.get("wallet_5")!;
const wallet6 = accounts.get("wallet_6")!;
const wallet7 = accounts.get("wallet_7")!;
const wallet8 = accounts.get("wallet_8")!;

const contract = "blind-auction";

const STX_100 = 100_000_000;
const STX_50 = 50_000_000;
const STX_200 = 200_000_000;
const SBTC_100K = 100_000;
const SBTC_50K = 50_000;

const DEPOSIT_MIN_BLOCKS = 150;
const BUFFER_BLOCKS = 30;
const CANCEL_THRESHOLD = 500;

function pub(fn: string, args: any[], sender: string) {
  return simnet.callPublicFn(contract, fn, args, sender).result;
}

function ro(fn: string, args: any[]) {
  return simnet.callReadOnlyFn(contract, fn, args, deployer).result;
}

describe("blind-auction lifecycle", function () {
  it("full deposit → close → settle → cancel cycle flow", function () {
    // ---- Initial state ----
    expect(ro("get-current-cycle", [])).toBeUint(0);
    expect(ro("get-cycle-phase", [])).toBeUint(0);
    expect(ro("get-min-deposits", [])).toBeTuple({
      "min-stx": Cl.uint(1_000_000),
      "min-sbtc": Cl.uint(1_000),
    });
    expect(ro("get-cycle-totals", [Cl.uint(0)])).toBeTuple({
      "total-stx": Cl.uint(0),
      "total-sbtc": Cl.uint(0),
    });

    // ---- Deposit errors ----
    expect(pub("deposit-stx", [Cl.uint(100)], wallet1)).toBeErr(
      Cl.uint(1001)
    ); // too small
    expect(pub("deposit-sbtc", [Cl.uint(500)], wallet1)).toBeErr(
      Cl.uint(1001)
    );

    // ---- Deposits ----
    // wallet_1: 100 STX
    expect(pub("deposit-stx", [Cl.uint(STX_100)], wallet1)).toBeOk(
      Cl.uint(STX_100)
    );
    expect(
      ro("get-stx-deposit", [Cl.uint(0), Cl.principal(wallet1)])
    ).toBeUint(STX_100);
    expect(ro("get-stx-depositors", [Cl.uint(0)])).toBeList([
      Cl.principal(wallet1),
    ]);

    // wallet_2: 100k sats sBTC
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_100K)], wallet2)).toBeOk(
      Cl.uint(SBTC_100K)
    );
    expect(
      ro("get-sbtc-deposit", [Cl.uint(0), Cl.principal(wallet2)])
    ).toBeUint(SBTC_100K);

    // wallet_1 top-up: +50 STX
    expect(pub("deposit-stx", [Cl.uint(STX_50)], wallet1)).toBeOk(
      Cl.uint(STX_50)
    );
    expect(
      ro("get-stx-deposit", [Cl.uint(0), Cl.principal(wallet1)])
    ).toBeUint(STX_100 + STX_50);
    // no duplicate in depositor list
    expect(ro("get-stx-depositors", [Cl.uint(0)])).toBeList([
      Cl.principal(wallet1),
    ]);

    // wallet_3: 200 STX (second depositor)
    expect(pub("deposit-stx", [Cl.uint(STX_200)], wallet3)).toBeOk(
      Cl.uint(STX_200)
    );
    expect(ro("get-stx-depositors", [Cl.uint(0)])).toBeList([
      Cl.principal(wallet1),
      Cl.principal(wallet3),
    ]);

    // wallet_4: 50k sats sBTC (second depositor)
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_50K)], wallet4)).toBeOk(
      Cl.uint(SBTC_50K)
    );

    // verify totals
    expect(ro("get-cycle-totals", [Cl.uint(0)])).toBeTuple({
      "total-stx": Cl.uint(STX_100 + STX_50 + STX_200),
      "total-sbtc": Cl.uint(SBTC_100K + SBTC_50K),
    });

    // ---- Cancel + re-deposit ----
    expect(pub("cancel-stx-deposit", [], wallet3)).toBeOk(Cl.uint(STX_200));
    expect(
      ro("get-stx-deposit", [Cl.uint(0), Cl.principal(wallet3)])
    ).toBeUint(0);
    expect(ro("get-stx-depositors", [Cl.uint(0)])).toBeList([
      Cl.principal(wallet1),
    ]);

    // cancel with no deposit → error
    expect(pub("cancel-stx-deposit", [], wallet3)).toBeErr(Cl.uint(1008));

    // re-deposit
    expect(pub("deposit-stx", [Cl.uint(STX_200)], wallet3)).toBeOk(
      Cl.uint(STX_200)
    );

    // ---- Admin ----
    // non-owner cannot pause
    expect(pub("set-paused", [Cl.bool(true)], wallet1)).toBeErr(
      Cl.uint(1011)
    );

    // owner pauses
    expect(pub("set-paused", [Cl.bool(true)], deployer)).toBeOk(
      Cl.bool(true)
    );
    // deposit fails when paused
    expect(pub("deposit-stx", [Cl.uint(STX_100)], wallet1)).toBeErr(
      Cl.uint(1010)
    );
    // unpause (var-set always returns true)
    expect(pub("set-paused", [Cl.bool(false)], deployer)).toBeOk(
      Cl.bool(true)
    );
    // deposit works again
    expect(pub("deposit-stx", [Cl.uint(STX_50)], wallet1)).toBeOk(
      Cl.uint(STX_50)
    );

    // owner can change min deposits
    expect(
      pub("set-min-stx-deposit", [Cl.uint(5_000_000)], deployer)
    ).toBeOk(Cl.bool(true));
    pub("set-min-stx-deposit", [Cl.uint(1_000_000)], deployer); // reset

    // owner can switch DEX source
    expect(pub("set-dex-source", [Cl.uint(2)], deployer)).toBeOk(
      Cl.bool(true)
    );
    pub("set-dex-source", [Cl.uint(1)], deployer); // reset

    // ---- Close too early ----
    expect(pub("close-deposits", [], wallet1)).toBeErr(Cl.uint(1015));

    // ---- Close deposits after DEPOSIT_MIN_BLOCKS ----
    simnet.mineEmptyBlocks(DEPOSIT_MIN_BLOCKS + 10);
    expect(pub("close-deposits", [], wallet1)).toBeOk(Cl.bool(true));

    // double close
    expect(pub("close-deposits", [], wallet1)).toBeErr(Cl.uint(1016));

    // ---- Buffer phase ----
    expect(ro("get-cycle-phase", [])).toBeUint(1);
    // deposits rejected
    expect(pub("deposit-stx", [Cl.uint(STX_100)], wallet1)).toBeErr(
      Cl.uint(1002)
    );
    // cancels rejected
    expect(pub("cancel-stx-deposit", [], wallet1)).toBeErr(Cl.uint(1002));

    // ---- Settle phase ----
    simnet.mineEmptyBlocks(BUFFER_BLOCKS + 5);
    expect(ro("get-cycle-phase", [])).toBeUint(2);
    // deposits rejected
    expect(pub("deposit-stx", [Cl.uint(STX_100)], wallet1)).toBeErr(
      Cl.uint(1002)
    );

    // settle fails — no Pyth prices in simnet
    expect(pub("settle", [], wallet1)).toBeErr(Cl.uint(1009));

    // cancel-cycle too early
    expect(pub("cancel-cycle", [], wallet1)).toBeErr(Cl.uint(1014));

    // ---- Cancel cycle after CANCEL_THRESHOLD ----
    simnet.mineEmptyBlocks(CANCEL_THRESHOLD + 10);
    expect(pub("cancel-cycle", [], wallet1)).toBeOk(Cl.bool(true));

    // ---- Verify rollforward to cycle 1 ----
    expect(ro("get-current-cycle", [])).toBeUint(1);
    expect(ro("get-cycle-phase", [])).toBeUint(0); // back to deposit

    // wallet_1: 100 + 50 + 50 (after unpause) = 200 STX
    expect(
      ro("get-stx-deposit", [Cl.uint(1), Cl.principal(wallet1)])
    ).toBeUint(STX_100 + STX_50 + STX_50);
    // wallet_3: 200 STX
    expect(
      ro("get-stx-deposit", [Cl.uint(1), Cl.principal(wallet3)])
    ).toBeUint(STX_200);
    // wallet_2: 100k sats
    expect(
      ro("get-sbtc-deposit", [Cl.uint(1), Cl.principal(wallet2)])
    ).toBeUint(SBTC_100K);
    // wallet_4: 50k sats
    expect(
      ro("get-sbtc-deposit", [Cl.uint(1), Cl.principal(wallet4)])
    ).toBeUint(SBTC_50K);

    // cycle 1 totals
    expect(ro("get-cycle-totals", [Cl.uint(1)])).toBeTuple({
      "total-stx": Cl.uint(STX_100 + STX_50 + STX_50 + STX_200),
      "total-sbtc": Cl.uint(SBTC_100K + SBTC_50K),
    });

    // cycle 0 empty
    expect(ro("get-cycle-totals", [Cl.uint(0)])).toBeTuple({
      "total-stx": Cl.uint(0),
      "total-sbtc": Cl.uint(0),
    });

    // can cancel rolled deposits in new cycle
    expect(pub("cancel-stx-deposit", [], wallet3)).toBeOk(Cl.uint(STX_200));

    // can top up rolled deposits (returns input amount, not cumulative)
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_50K)], wallet2)).toBeOk(
      Cl.uint(SBTC_50K)
    );
    // verify cumulative deposit
    expect(
      ro("get-sbtc-deposit", [Cl.uint(1), Cl.principal(wallet2)])
    ).toBeUint(SBTC_100K + SBTC_50K);
  });

  it("phase guard errors: settle and cancel-cycle in wrong phases", function () {
    // Fresh simnet — cycle 0, deposit phase

    // ---- Settle during deposit phase ----
    expect(pub("settle", [], wallet1)).toBeErr(Cl.uint(1009)); // ERR_ZERO_PRICE (hits price check before phase check in execution order)

    // ---- Cancel-cycle during deposit phase ----
    // cancel-cycle checks (> closed-block u0) first — deposits not closed yet
    expect(pub("cancel-cycle", [], wallet1)).toBeErr(Cl.uint(1003)); // ERR_NOT_SETTLE_PHASE

    // ---- Close with only STX deposited (no sBTC) → ERR_NOTHING_TO_SETTLE ----
    expect(pub("deposit-stx", [Cl.uint(STX_100)], wallet1)).toBeOk(
      Cl.uint(STX_100)
    );
    simnet.mineEmptyBlocks(DEPOSIT_MIN_BLOCKS + 5);
    expect(pub("close-deposits", [], wallet1)).toBeErr(Cl.uint(1012)); // ERR_NOTHING_TO_SETTLE

    // ---- Now deposit sBTC so we can close ----
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_100K)], wallet2)).toBeOk(
      Cl.uint(SBTC_100K)
    );
    expect(pub("close-deposits", [], wallet1)).toBeOk(Cl.bool(true));

    // ---- Cancel sBTC during buffer phase ----
    expect(ro("get-cycle-phase", [])).toBeUint(1); // BUFFER
    expect(pub("cancel-sbtc-deposit", [], wallet2)).toBeErr(Cl.uint(1002)); // ERR_NOT_DEPOSIT_PHASE

    // ---- Settle during buffer phase ----
    expect(pub("settle", [], wallet1)).toBeErr(Cl.uint(1009)); // ERR_ZERO_PRICE (no pyth data, but also not settle phase yet)

    // ---- Advance to settle phase ----
    simnet.mineEmptyBlocks(BUFFER_BLOCKS + 5);
    expect(ro("get-cycle-phase", [])).toBeUint(2); // SETTLE

    // ---- Cancel sBTC during settle phase ----
    expect(pub("cancel-sbtc-deposit", [], wallet2)).toBeErr(Cl.uint(1002));

    // ---- Settle fails (no Pyth in simnet) ----
    expect(pub("settle", [], wallet1)).toBeErr(Cl.uint(1009)); // ERR_ZERO_PRICE

    // ---- Cancel-cycle too early ----
    expect(pub("cancel-cycle", [], wallet1)).toBeErr(Cl.uint(1014)); // ERR_CANCEL_TOO_EARLY

    // ---- Cancel-cycle after threshold ----
    simnet.mineEmptyBlocks(CANCEL_THRESHOLD + 10);
    expect(pub("cancel-cycle", [], wallet1)).toBeOk(Cl.bool(true));

    // ---- Double cancel-cycle should fail (already advanced) ----
    // Now in cycle 1 deposit phase — closed-block is 0
    expect(pub("cancel-cycle", [], wallet1)).toBeErr(Cl.uint(1003)); // ERR_NOT_SETTLE_PHASE
  });

  it("admin: treasury, owner transfer, min-sbtc, invalid dex source", function () {
    // ---- set-treasury ----
    expect(pub("set-treasury", [Cl.principal(wallet1)], deployer)).toBeOk(
      Cl.bool(true)
    );
    // non-owner cannot set treasury
    expect(pub("set-treasury", [Cl.principal(wallet2)], wallet1)).toBeErr(
      Cl.uint(1011)
    );

    // ---- set-contract-owner ----
    expect(
      pub("set-contract-owner", [Cl.principal(wallet1)], deployer)
    ).toBeOk(Cl.bool(true));
    // deployer is no longer owner — should fail
    expect(pub("set-paused", [Cl.bool(true)], deployer)).toBeErr(
      Cl.uint(1011)
    );
    // wallet1 is now owner
    expect(pub("set-paused", [Cl.bool(true)], wallet1)).toBeOk(
      Cl.bool(true)
    );
    expect(pub("set-paused", [Cl.bool(false)], wallet1)).toBeOk(
      Cl.bool(true)
    );
    // transfer back
    expect(
      pub("set-contract-owner", [Cl.principal(deployer)], wallet1)
    ).toBeOk(Cl.bool(true));

    // ---- set-min-sbtc-deposit ----
    expect(
      pub("set-min-sbtc-deposit", [Cl.uint(5_000)], deployer)
    ).toBeOk(Cl.bool(true));
    // deposit below new min
    expect(pub("deposit-sbtc", [Cl.uint(2_000)], wallet2)).toBeErr(
      Cl.uint(1001)
    );
    // reset
    pub("set-min-sbtc-deposit", [Cl.uint(1_000)], deployer);

    // ---- invalid DEX source ----
    expect(pub("set-dex-source", [Cl.uint(3)], deployer)).toBeErr(
      Cl.uint(1011)
    );
    expect(pub("set-dex-source", [Cl.uint(0)], deployer)).toBeErr(
      Cl.uint(1011)
    );
  });

  it("cancel sBTC deposit during deposit phase", function () {
    // deposit sBTC
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_100K)], wallet2)).toBeOk(
      Cl.uint(SBTC_100K)
    );
    expect(
      ro("get-sbtc-deposit", [Cl.uint(0), Cl.principal(wallet2)])
    ).toBeUint(SBTC_100K);

    // cancel
    expect(pub("cancel-sbtc-deposit", [], wallet2)).toBeOk(
      Cl.uint(SBTC_100K)
    );
    expect(
      ro("get-sbtc-deposit", [Cl.uint(0), Cl.principal(wallet2)])
    ).toBeUint(0);
    expect(ro("get-sbtc-depositors", [Cl.uint(0)])).toBeList([]);

    // cancel with nothing
    expect(pub("cancel-sbtc-deposit", [], wallet2)).toBeErr(Cl.uint(1008));
  });

  it("priority queue: fill 5 slots, bump smallest, fail if too small", function () {
    const STX_2 = 2_000_000; // 2 STX
    const STX_1 = 1_000_000; // 1 STX (smallest — will be bumped)
    const STX_3 = 3_000_000; // 3 STX (bumper)

    const SBTC_2K = 2_000;
    const SBTC_1K = 1_000; // smallest
    const SBTC_3K = 3_000; // bumper

    // ---- Fill STX queue: 4 x 2 STX + 1 x 1 STX ----
    expect(pub("deposit-stx", [Cl.uint(STX_2)], wallet1)).toBeOk(Cl.uint(STX_2));
    expect(pub("deposit-stx", [Cl.uint(STX_2)], wallet2)).toBeOk(Cl.uint(STX_2));
    expect(pub("deposit-stx", [Cl.uint(STX_2)], wallet3)).toBeOk(Cl.uint(STX_2));
    expect(pub("deposit-stx", [Cl.uint(STX_2)], wallet4)).toBeOk(Cl.uint(STX_2));
    expect(pub("deposit-stx", [Cl.uint(STX_1)], wallet5)).toBeOk(Cl.uint(STX_1)); // smallest

    // verify queue full
    expect(ro("get-stx-depositors", [Cl.uint(0)])).toBeList([
      Cl.principal(wallet1),
      Cl.principal(wallet2),
      Cl.principal(wallet3),
      Cl.principal(wallet4),
      Cl.principal(wallet5),
    ]);

    // ---- 6th depositor too small → ERR_QUEUE_FULL ----
    expect(pub("deposit-stx", [Cl.uint(STX_1)], wallet6)).toBeErr(
      Cl.uint(1013) // ERR_QUEUE_FULL (equal to smallest, not greater)
    );

    // ---- 6th depositor below min → ERR_DEPOSIT_TOO_SMALL ----
    expect(pub("deposit-stx", [Cl.uint(500_000)], wallet6)).toBeErr(
      Cl.uint(1001)
    );

    // ---- 6th depositor bigger → bumps wallet5 (smallest) ----
    expect(pub("deposit-stx", [Cl.uint(STX_3)], wallet6)).toBeOk(Cl.uint(STX_3));

    // wallet5 is gone, wallet6 is in
    expect(
      ro("get-stx-deposit", [Cl.uint(0), Cl.principal(wallet5)])
    ).toBeUint(0);
    expect(
      ro("get-stx-deposit", [Cl.uint(0), Cl.principal(wallet6)])
    ).toBeUint(STX_3);

    // still 5 depositors
    expect(ro("get-stx-depositors", [Cl.uint(0)])).toBeList([
      Cl.principal(wallet1),
      Cl.principal(wallet2),
      Cl.principal(wallet3),
      Cl.principal(wallet4),
      Cl.principal(wallet6),
    ]);

    // totals updated: was 4×2+1=9, now 4×2+3=11
    expect(ro("get-cycle-totals", [Cl.uint(0)])).toBeTuple({
      "total-stx": Cl.uint(4 * STX_2 + STX_3),
      "total-sbtc": Cl.uint(0),
    });

    // ---- Same for sBTC side ----
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_2K)], wallet1)).toBeOk(Cl.uint(SBTC_2K));
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_2K)], wallet2)).toBeOk(Cl.uint(SBTC_2K));
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_2K)], wallet3)).toBeOk(Cl.uint(SBTC_2K));
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_2K)], wallet4)).toBeOk(Cl.uint(SBTC_2K));
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_1K)], wallet5)).toBeOk(Cl.uint(SBTC_1K)); // smallest

    // 6th too small
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_1K)], wallet6)).toBeErr(
      Cl.uint(1013)
    );

    // 6th bigger → bumps wallet5
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_3K)], wallet7)).toBeOk(Cl.uint(SBTC_3K));

    expect(
      ro("get-sbtc-deposit", [Cl.uint(0), Cl.principal(wallet5)])
    ).toBeUint(0);
    expect(
      ro("get-sbtc-deposit", [Cl.uint(0), Cl.principal(wallet7)])
    ).toBeUint(SBTC_3K);

    // still 5 depositors
    expect(ro("get-sbtc-depositors", [Cl.uint(0)])).toBeList([
      Cl.principal(wallet1),
      Cl.principal(wallet2),
      Cl.principal(wallet3),
      Cl.principal(wallet4),
      Cl.principal(wallet7),
    ]);
  });

  // NOTE: Full settlement test requires remote_data (mainnet pool state)
  // but remote_data breaks sBTC transfers with "Clarity VM failed to track token supply".
  // Settlement is fully tested via stxer mainnet fork simulations instead.
  // See simulations/README-stxer.md for settlement results.
});
