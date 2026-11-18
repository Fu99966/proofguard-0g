import { describe, expect, it } from "vitest";
import { baseSepolia } from "../../sdk/network.js";
import { rebalance } from "./strategy.js";

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
});
