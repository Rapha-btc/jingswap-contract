import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

describe("trait extracted from fold accumulator", () => {
  it("transfers sBTC via (contract-call? tt ...) where tt = (let ((tt (get t acc))))", () => {
    const testContract = `${deployer}.test-trait-fold`;

    // Fund the test-trait-fold contract with sBTC (so it can `as-contract?` transfer)
    const fund = simnet.callPublicFn(
      SBTC_TOKEN,
      "transfer",
      [Cl.uint(10), Cl.principal(SBTC_WHALE), Cl.principal(testContract), Cl.none()],
      SBTC_WHALE
    );
    expect(fund.result).toBeOk(Cl.bool(true));

    // Call drive() with the sBTC trait + one recipient. process-one should
    // execute (contract-call? tt transfer ...) where tt was extracted from
    // the fold accumulator. If friedger's strict reading is correct, this
    // reverts at runtime. If liberal reading (what we're hoping), it succeeds.
    const result = simnet.callPublicFn(
      "test-trait-fold",
      "drive",
      [
        Cl.contractPrincipal("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", "sbtc-token"),
        Cl.stringAscii("sbtc-token"),
        Cl.list([Cl.principal(wallet1)]),
      ],
      deployer
    );

    console.log("drive result:", JSON.stringify(result.result, null, 2));
    console.log("events:", JSON.stringify(result.events, null, 2));

    expect(result.result).toBeOk(Cl.uint(1));
  });
});
