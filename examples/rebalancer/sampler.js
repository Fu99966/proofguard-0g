import { Contract } from "ethers";
import { chainlinkMarket, rpcProvider } from "../../server/market.js";
import { baseSepolia } from "../../sdk/network.js";
import { rebalance } from "./strategy.js";

const tokenAbi = ["function balanceOf(address account) view returns(uint256)"];
const quoterAbi = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"];

export function createSampler({ rpc, safe, ethFeed, usdcFeed }) {
  const provider = rpcProvider(rpc);
  const market = chainlinkMarket({ provider, ethFeed, usdcFeed });
  const usdc = new Contract(baseSepolia.usdc, tokenAbi, provider);
  const weth = new Contract(baseSepolia.weth, tokenAbi, provider);
  const quoter = new Contract(baseSepolia.quoterV3, quoterAbi, provider);

  return {
    close: () => provider.destroy(),
    async sample({ quoteHealthCheck = false, rejectQuote = false } = {}) {
      const prices = await market({ tx: { chainId: baseSepolia.chainId } });
      if (!prices) throw Object.assign(new Error("Independent market data is unavailable."), { code: "rpc-or-feed" });
      const { blockTag } = prices;
      const [eth, wrapped, stable] = await Promise.all([provider.getBalance(safe, blockTag),
        weth.balanceOf(safe, { blockTag }), usdc.balanceOf(safe, { blockTag })]);
      const position = rebalance({ eth, weth: wrapped, usdc: stable, prices: prices.usdMicros, maxTradeUsdMicros: 10_000_000n });
      const sample = { blockTag, eth, weth: wrapped, usdc: stable, position, quote: null };
      if (!position.tokenIn && !quoteHealthCheck) return sample;
      const { tokenIn, tokenOut, amount } = position.tokenIn ? position
        : { tokenIn: baseSepolia.usdc, tokenOut: baseSepolia.weth, amount: 1_000_000n };
      const inUsd = amount * BigInt(prices.usdMicros[tokenIn]) / (tokenIn === baseSepolia.weth ? 10n ** 18n : 1_000_000n);
      const quotes = await Promise.allSettled([100, 500, 3000].map(async (fee) => {
        const [quoted] = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn: amount, fee, sqrtPriceLimitX96: 0 }, { blockTag });
        return { fee, quoted: rejectQuote ? 0n : quoted };
      }));
      const returned = quotes.flatMap((result) => result.status === "fulfilled" && result.value.quoted > 0n ? [result.value] : []);
      if (!returned.length) return { ...sample, issue: "quote-unavailable" };
      const plausible = returned.filter(({ quoted }) => {
        const outUsd = quoted * BigInt(prices.usdMicros[tokenOut]) / (tokenOut === baseSepolia.weth ? 10n ** 18n : 1_000_000n);
        const delta = outUsd > inUsd ? outUsd - inUsd : inUsd - outUsd;
        return outUsd > 0n && delta * 10_000n <= inUsd * 300n;
      });
      const best = plausible.reduce((highest, quote) => !highest || quote.quoted > highest.quoted ? quote : highest, null);
      if (!best) return { ...sample, quoteStatus: "outside-price-policy", returned };
      return { ...sample, quote: { ...best, minOut: best.quoted * 9975n / 10_000n, tokenIn, tokenOut, amount } };
    },
  };
}

export const stringifyEvidence = (data) => JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value);
