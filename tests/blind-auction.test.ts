import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;
const wallet3 = accounts.get("wallet_3")!;
const wallet4 = accounts.get("wallet_4")!;

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
});
