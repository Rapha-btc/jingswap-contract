import { describe, expect, it } from "vitest";
import { Cl, cvToJSON } from "@stacks/transactions";

// Detect if remote_data is enabled by checking XYK pool state
const xykPool = cvToJSON(simnet.callReadOnlyFn(
  "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1",
  "get-total-supply", [], simnet.getAccounts().get("deployer")!
).result);
const remoteDataEnabled = Number(xykPool.value?.value || 0) > 0;

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;

// Use blind-auction-stxer: identical logic, relaxed timing gates
// DEPOSIT_MIN_BLOCKS=0, BUFFER_BLOCKS=0, MAX_STALENESS=999999999
const contract = "blind-auction-stxer";

const STX_100 = 100_000_000;
const SBTC_100K = 100_000;

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const PYTH_STORAGE = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4";
const BTC_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_FEED = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

function pub(fn: string, args: any[], sender: string) {
  return simnet.callPublicFn(contract, fn, args, sender).result;
}

function ro(fn: string, args: any[]) {
  return simnet.callReadOnlyFn(contract, fn, args, deployer).result;
}

function fundSbtc(recipient: string, amount: number) {
  const result = simnet.callPublicFn(
    SBTC_TOKEN, "transfer",
    [Cl.uint(amount), Cl.principal(SBTC_WHALE), Cl.principal(recipient), Cl.none()],
    SBTC_WHALE
  );
  expect(result.result).toBeOk(Cl.bool(true));
}

describe.skipIf(!remoteDataEnabled)("full settlement with remote_data", function () {
  it("deposit -> close -> settle with mainnet state", function () {
    // ---- Mainnet state check ----
    const dexPrice = cvToJSON(ro("get-dex-price", []));
    console.log("DEX price (uSTX/sat):", dexPrice);

    const btcPyth = cvToJSON(simnet.callReadOnlyFn(
      PYTH_STORAGE, "get-price", [Cl.bufferFromHex(BTC_FEED)], deployer
    ).result);
    const stxPyth = cvToJSON(simnet.callReadOnlyFn(
      PYTH_STORAGE, "get-price", [Cl.bufferFromHex(STX_FEED)], deployer
    ).result);
    const btcUsd = Number(btcPyth.value.value.price.value) / 1e8;
    const stxUsd = Number(stxPyth.value.value.price.value) / 1e8;
    console.log(`Pyth BTC: $${btcUsd.toFixed(2)}, STX: $${stxUsd.toFixed(4)}`);
    console.log(`Oracle STX/BTC: ${(btcUsd / stxUsd).toFixed(0)} STX per BTC`);

    // ---- Fund sBTC ----
    fundSbtc(wallet2, SBTC_100K);

    // ---- Deposits ----
    expect(pub("deposit-stx", [Cl.uint(STX_100)], wallet1)).toBeOk(Cl.uint(STX_100));
    expect(pub("deposit-sbtc", [Cl.uint(SBTC_100K)], wallet2)).toBeOk(Cl.uint(SBTC_100K));

    const totals = cvToJSON(ro("get-cycle-totals", [Cl.uint(0)]));
    console.log("Totals:", totals.value);

    // ---- Close deposits (DEPOSIT_MIN_BLOCKS=0 in stxer) ----
    expect(pub("close-deposits", [], wallet1)).toBeOk(Cl.bool(true));

    // ---- Phase check ----
    const phase = cvToJSON(ro("get-cycle-phase", []));
    console.log("Phase:", phase.value, "(2 = settle)");

    // ---- SETTLE (MAX_STALENESS=999999999, stored prices accepted) ----
    const settleResult = pub("settle", [], wallet1);
    const result = cvToJSON(settleResult);
    console.log("\nSettle result:", result);

    if (!result.success) {
      console.log("Error code:", result.value.value);
    }

    expect(settleResult).toBeOk(Cl.bool(true));

    // ---- Verify settlement ----
    expect(ro("get-current-cycle", [])).toBeUint(1);
    const settlement = cvToJSON(ro("get-settlement", [Cl.uint(0)]));
    console.log("\n=== Settlement Record ===");
    console.log(JSON.stringify(settlement.value.value, null, 2));

    const w1stx = cvToJSON(ro("get-stx-deposit", [Cl.uint(0), Cl.principal(wallet1)]));
    console.log("\nwallet1 stx deposit after settle:", w1stx.value);

    const w2sbtc = cvToJSON(ro("get-sbtc-deposit", [Cl.uint(0), Cl.principal(wallet2)]));
    console.log("wallet2 sbtc deposit after settle:", w2sbtc.value);
  });
});
