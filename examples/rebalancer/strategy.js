import { baseSepolia } from "../../sdk/network.js";

const ethUnit = 10n ** 18n;
const fraction = 10_000n;
const min = (...values) => values.reduce((smallest, value) => value < smallest ? value : smallest);

export function allowanceRenewals({ allowance, permit, amount, now }) {
  return [
    ...(allowance < amount ? ["token"] : []),
    ...(permit.amount < amount || permit.expiration <= now + 300n ? ["permit2"] : []),
  ];
}

export function reviewCycleStatus(previous, reviewAttempts) {
  const consecutiveCycles = reviewAttempts > 0 ? previous + 1 : 0;
  return { consecutiveCycles, pause: consecutiveCycles >= 3 };
}

export function rebalance({ eth, weth, usdc, prices, maxTradeUsdMicros, maxTokenExposureBps = 1500n }) {
  const usdEth = BigInt(prices[baseSepolia.weth]);
  const usdUsdc = BigInt(prices[baseSepolia.usdc]);
  if (usdEth <= 0n || usdUsdc <= 0n) throw new Error("Nonpositive market price");
  const ethValue = (eth + weth) * usdEth / ethUnit;
  const usdcValue = usdc * usdUsdc / 1_000_000n;
  const total = ethValue + usdcValue;
  if (total === 0n) return { state: "empty" };
  const ethBps = ethValue * fraction / total;
  if (ethBps >= 3500n && ethBps <= 4500n) return { state: "in-band", ethBps };
  const buy = ethBps < 3500n;
  const target = total * 4000n / fraction;
  const intended = buy ? target - ethValue : ethValue - target;
  const spendable = buy ? usdcValue : weth * usdEth / ethUnit;
  const notional = min(intended, spendable, maxTradeUsdMicros, total * maxTokenExposureBps / fraction);
  const amount = buy ? notional * 1_000_000n / usdUsdc : notional * ethUnit / usdEth;
  if (amount === 0n) return { state: "constrained", ethBps };
  return {
    state: buy ? "buy-weth" : "sell-weth", ethBps, notionalUsdMicros: notional, amount,
    tokenIn: buy ? baseSepolia.usdc : baseSepolia.weth, tokenOut: buy ? baseSepolia.weth : baseSepolia.usdc,
  };
}
