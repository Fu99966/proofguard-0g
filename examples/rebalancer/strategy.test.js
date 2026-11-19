import { describe, expect, it } from "vitest";
import { baseSepolia } from "../../sdk/network.js";
import { allowanceRenewals, rebalance, reviewCycleStatus } from "./strategy.js";

const prices = { [baseSepolia.usdc]: "1000000", [baseSepolia.weth]: "2000000000" };
const dollars = (n) => BigInt(n) * 1_000_000n;
const position = (eth, usdc) => ({ weth: 0n, eth: BigInt(eth) * 10n ** 15n, usdc: dollars(usdc), prices, maxTradeUsdMicros: dollars(10) });

describe("testnet portfolio strategy", () => {
  it("trades only outside the mandate band", () => {
    expect(rebalance(position(20, 60))).toMatchObject({ state: "in-band", ethBps: 4000n });
    expect(rebalance(position(10, 80))).toMatchObject({ state: "buy-weth", tokenIn: baseSepolia.usdc,
      tokenOut: baseSepolia.weth, amount: dollars(10) });
  });

  it("reduces ETH exposure with a capped WETH sale", () => {
    expect(rebalance({ ...position(20, 30), weth: 10n ** 16n })).toMatchObject({
      state: "sell-weth", tokenIn: baseSepolia.weth, tokenOut: baseSepolia.usdc,
      amount: 5n * 10n ** 15n, notionalUsdMicros: dollars(10),
    });
  });

  it("identifies when a cycle would need both approval transactions", () => {
    const current = { allowance: 10n, permit: { amount: 10n, expiration: 301n }, amount: 10n, now: 0n };
    expect(allowanceRenewals(current)).toEqual([]);
    expect(allowanceRenewals({ ...current, allowance: 9n })).toEqual(["token"]);
    const expiring = { ...current, permit: { ...current.permit, expiration: 300n } };
    expect(allowanceRenewals(expiring)).toEqual(["permit2"]);
    expect(allowanceRenewals({ ...expiring, allowance: 9n })).toEqual(["token", "permit2"]);
  });

  it("pauses after three consecutive review cycles and resets the streak after an in-band cycle", () => {
    const first = reviewCycleStatus(0, 3);
    expect(first).toEqual({ consecutiveCycles: 1, pause: false });
    const second = reviewCycleStatus(first.consecutiveCycles, 1);
    expect(second).toEqual({ consecutiveCycles: 2, pause: false });
    expect(reviewCycleStatus(second.consecutiveCycles, 0)).toEqual({ consecutiveCycles: 0, pause: false });
    expect(reviewCycleStatus(second.consecutiveCycles, 2)).toEqual({ consecutiveCycles: 3, pause: true });
  });
});
