import { readFileSync } from "node:fs";

import { AbiCoder, Interface, MaxUint256, solidityPacked } from "ethers";
import { describe, expect, it } from "vitest";
import { decodeTransaction } from "./decoder.js";
import { demoMarket, policy, scenarios, testnetPolicy } from "./demoData.js";
import { evaluatePolicy } from "./policyEngine.js";
import { baseSepolia } from "../sdk/network.js";

const safe = scenarios[0].transaction;
const usdc = Object.keys(policy.allowedAssets).find((key) => policy.allowedAssets[key].symbol === "USDC").split(":")[1];
const weth = Object.keys(policy.allowedAssets).find((key) => policy.allowedAssets[key].symbol === "WETH").split(":")[1];
const other = "0x1111111111111111111111111111111111111111";
const token = new Interface(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const router = new Interface(["function execute(bytes,bytes[])"]);
const abi = AbiCoder.defaultAbiCoder();

const result = (tx) => evaluatePolicy(tx, policy, { market: demoMarket });

function swap({ commands = "0x00", asset = usdc, recipient = safe.from } = {}) {
  const path = solidityPacked(["address", "uint24", "address"], [asset, 500, weth]);
  const input = abi.encode(["address", "uint256", "uint256", "bytes", "bool"],
    [recipient, 2_400_000_000n, 996_000_000_000_000_000n, path, true]);
  return { ...safe, data: router.encodeFunctionData("execute", [commands, [input]]) };
}

describe("Calldata policy refusals", () => {
  it.each([
    ["foreign wallet", () => ({ ...safe, from: other }), "sender"],
    ["unrecognized selector", () => ({ ...safe, data: "0xdead0000" }), "decode"],
    ["unsupported Router command", () => swap({ commands: "0x3f" }), "decode"],
    ["unregistered token address", () => swap({ asset: other }), "assets"],
    ["unregistered recipient", () => swap({ recipient: other }), "recipient"],
    ["unbounded allowance", () => ({ ...safe, to: usdc, data: token.encodeFunctionData("approve", [safe.to, MaxUint256]) }), "approval"],
    ["conflicting display claims", () => ({ ...safe, method: "transfer(address,uint256)", valueUsd: 1 }), "claims"],
  ])("blocks %s", (_name, build, check) => {
    const verdict = result(build());
    expect(verdict.passed).toBe(false);
    expect(verdict.blockers).toContain(check);
  });

  it("rejects invalid legacy quantities even when calldata is valid", () => {
    expect(result({ ...safe, valueUsd: -1, approvalUsd: -1, slippageBps: -1 }).blockers).toContain("claims");
  });

  it("accepts the fixture by its decoded facts and rejects it without market evidence", () => {
    expect(result(safe).passed).toBe(true);
    expect(evaluatePolicy(safe, policy).blockers).toContain("market");
    expect(decodeTransaction(safe, policy).effects[0]).toMatchObject({
      kind: "swap", maxIn: "2400000000", minOut: "996000000000000000", recipient: safe.from, path: [usdc, weth],
    });
  });

  it("accepts a bounded token transfer only to an eligible wallet", () => {
    const tx = { ...safe, to: usdc, data: token.encodeFunctionData("transfer", [safe.from, 2_000_000n]) };
    expect(result(tx).passed).toBe(true);
    expect(result({ ...tx, data: token.encodeFunctionData("transfer", [other, 2_000_000n]) }).blockers).toContain("recipient");
  });
});

const historicalSwaps = JSON.parse(readFileSync(new URL("./fixtures/base-router-swaps.json", import.meta.url), "utf8"));

it.each(historicalSwaps)("matches the recorded Uniswap pool swap for $hash", ({ transaction, observed }) => {
  const decoded = decodeTransaction(transaction, policy);
  const swapEffect = decoded.effects.find(({ kind }) => kind === "swap");
  expect(decoded.method).toBe("execute(bytes,bytes[],uint256)");
  expect(swapEffect.recipient).toBe(observed.final.recipient);
  expect(swapEffect.path.slice(0, 2)).toEqual([usdc, weth]);
  expect(BigInt(swapEffect.maxIn)).toBeGreaterThanOrEqual(BigInt(observed.amount1));
  expect(BigInt(swapEffect.minOut)).toBeLessThanOrEqual(BigInt(observed.final.amountOut));
});


it("separates oracle deviation from quoted execution slippage on Base Sepolia", () => {
  const policy = testnetPolicy(null, safe.from);
  const path = solidityPacked(["address", "uint24", "address"], [baseSepolia.usdc, 100, baseSepolia.weth]);
  const make = (minOut) => ({ chainId: baseSepolia.chainId, from: safe.from, to: baseSepolia.router, value: "0",
    data: router.encodeFunctionData("execute", ["0x00", [abi.encode(["address", "uint256", "uint256", "bytes", "bool"],
      [safe.from, 1_000_000, minOut, path, true])]]) });
  const market = { source: "testnet-quote-fixture", usdMicros: { [baseSepolia.usdc]: "1000000", [baseSepolia.weth]: "2000000000" },
    swapQuote: { input: "1000000", output: "490000000000000" } };
  expect(evaluatePolicy(make(487_550_000_000_000n), policy, { market })).toMatchObject({ passed: true,
    facts: { valuation: { worstSlippageBps: 50, priceDeviationBps: 200 } } });
  expect(evaluatePolicy(make(480_000_000_000_000n), policy, { market }).blockers).toContain("slippage");
  expect(evaluatePolicy(make(487_550_000_000_000n), policy, { market: { ...market,
    swapQuote: { ...market.swapQuote, output: "1000000000000000" } } }).blockers).toContain("price-deviation");
  expect(evaluatePolicy(make(487_550_000_000_000n), policy).blockers).toContain("market");
});
