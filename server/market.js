import { Contract, FetchRequest, getAddress, JsonRpcProvider, solidityPacked } from "ethers";
import { baseSepolia } from "../sdk/network.js";

const feedAbi = [
  "function description() view returns(string)",
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
];

const quoterAbi = [
  "function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[],uint32[],uint256)",
  "function quoteExactOutput(bytes path,uint256 amountOut) returns(uint256 amountIn,uint160[],uint32[],uint256)",
];

function packPath(path, fees) {
  const types = ["address"];
  const values = [path[0]];
  for (let index = 0; index < fees.length; index++) {
    types.push("uint24", "address");
    values.push(fees[index], path[index + 1]);
  }
  return solidityPacked(types, values);
}

export function rpcProvider(url) {
  const request = new FetchRequest(url);
  request.timeout = 8_000;
  return new JsonRpcProvider(request);
}

export function chainlinkMarket({ rpc, ethFeed = baseSepolia.ethUsdFeed, usdcFeed, now = Date.now, maxAgeSeconds = 3600 }) {
  if (!rpc || !ethFeed) return async () => null;
  const provider = rpcProvider(rpc);
  const eth = new Contract(getAddress(ethFeed), feedAbi, provider);
  const usdc = usdcFeed ? new Contract(getAddress(usdcFeed), feedAbi, provider) : null;
  const quoter = new Contract(baseSepolia.quoterV3, quoterAbi, provider);
  const tokenAbi = ["function balanceOf(address) view returns(uint256)"];
  const ethToken = new Contract(baseSepolia.weth, tokenAbi, provider);
  const usdcToken = new Contract(baseSepolia.usdc, tokenAbi, provider);
  return async ({ tx, effects = [] }) => {
    if (tx.chainId !== baseSepolia.chainId) return null;
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(tx.chainId)) return null;
      const blockTag = await provider.getBlockNumber();
      const ageLimit = BigInt(Math.floor(now() / 1000) - maxAgeSeconds);
      const read = async (contract, expected) => {
        const [name, decimals, [round, answer, , updatedAt, answeredInRound]] = await Promise.all([
          contract.description({ blockTag }), contract.decimals({ blockTag }), contract.latestRoundData({ blockTag }),
        ]);
        if (name !== expected || answer <= 0n || decimals > 18n || updatedAt <= ageLimit
          || updatedAt > BigInt(Math.floor(now() / 1000) + 30) || answeredInRound < round) throw new Error("Invalid price feed");
        return (answer * 1_000_000n / (10n ** decimals)).toString();
      };
      const [ethUsd, usdcUsd] = await Promise.all([read(eth, "ETH / USD"), usdc ? read(usdc, "USDC / USD") : "1000000"]);
      const swaps = effects.filter(({ kind }) => kind === "swap");
      const swap = swaps.length === 1 ? swaps[0] : null;
      let swapQuote;
      if (swap?.protocol === "uniswap-v3" && swap.path.every((token) => [baseSepolia.weth, baseSepolia.usdc].includes(token))) {
        if (swap.exactOut) {
          const [amount] = await quoter.quoteExactOutput.staticCall(packPath([...swap.path].reverse(), [...swap.fees].reverse()), swap.minOut, { blockTag });
          swapQuote = { input: amount.toString(), output: swap.minOut };
        } else {
          const [amount] = await quoter.quoteExactInput.staticCall(packPath(swap.path, swap.fees), swap.maxIn, { blockTag });
          swapQuote = { input: swap.maxIn, output: amount.toString() };
        }
      }
      let portfolio;
      if (tx.from) {
        const [eth, wrapped, stable] = await Promise.all([provider.getBalance(tx.from, blockTag),
          ethToken.balanceOf(tx.from, { blockTag }), usdcToken.balanceOf(tx.from, { blockTag })]);
        const etherUsd = (eth + wrapped) * BigInt(ethUsd) / 10n ** 18n;
        const stableUsd = stable * BigInt(usdcUsd) / 1_000_000n;
        const total = etherUsd + stableUsd;
        portfolio = { ethExposureBps: total > 0n ? Number(etherUsd * 10_000n / total) : null,
          totalUsdMicros: total.toString() };
      }
      return { source: usdc ? "chainlink" : "chainlink-eth-and-testnet-usdc-unit", blockTag, swapQuote, portfolio,
        usdMicros: { [baseSepolia.weth]: ethUsd, native: ethUsd, [baseSepolia.usdc]: usdcUsd } };
    } catch {
      return null;
    }
  };
}
