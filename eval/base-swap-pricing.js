import { AbiCoder, Contract, solidityPacked } from "ethers";

const abi = AbiCoder.defaultAbiCoder();
const feedAbi = [
  "function description() view returns(string)",
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
];
const quoterAbi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)",
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amountOut,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)",
];
const boundsTypes = ["address", "uint256", "uint256", "bytes", "bool"];
const hopPriceScale = 10n ** 36n;
export const pricingLimits = Object.freeze({ maximumUsd: 10_000, slippageBps: 75, priceDeviationBps: 300 });

function swapBounds(call, version, { inputAsset, outputAsset, amountIn, amountOut }, fee) {
  if (!call) throw new Error("Unsupported Router entrypoint for pricing");
  const [commands, inputs] = call.args;
  const swaps = (commands.slice(2).match(/../g) ?? []).map((command, index) => ({ command, input: inputs[index] }))
    .filter(({ command }) => command === "00" || command === "01");
  if (swaps.length !== 1) throw new Error("Expected one V3 swap command");
  const [{ command, input }] = swaps;
  const exactOut = command === "01";
  const types = version.startsWith("Universal Router V2.1.") ? [...boundsTypes, "uint256[]"] : boundsTypes;
  const decoded = abi.decode(types, input);
  const [, amount, limit, path, , hopPrices = []] = decoded;
  const tokens = exactOut ? [outputAsset, inputAsset] : [inputAsset, outputAsset];
  if (abi.encode(types, decoded).toLowerCase() !== input.toLowerCase()
    || path.toLowerCase() !== solidityPacked(["address", "uint24", "address"], [tokens[0], fee, tokens[1]])) {
    throw new Error("Swap bounds do not match the paid pool");
  }
  if (hopPrices.length > 1) throw new Error("Unexpected V3 hop-price array for one pool");
  const [hopPrice = 0n] = hopPrices;
  let maxIn = exactOut ? limit : amount;
  let minOut = exactOut ? amount : limit;
  if (hopPrice > 0n && exactOut) {
    const hopMaxIn = minOut * hopPriceScale / hopPrice;
    if (hopMaxIn < maxIn) maxIn = hopMaxIn;
  }
  if (hopPrice > 0n && !exactOut) {
    const hopMinOut = (maxIn * hopPrice + hopPriceScale - 1n) / hopPriceScale;
    if (hopMinOut > minOut) minOut = hopMinOut;
  }
  if (minOut === 0n || maxIn === 0n || (exactOut
    ? minOut !== BigInt(amountOut) || maxIn < BigInt(amountIn)
    : maxIn !== BigInt(amountIn) || minOut > BigInt(amountOut))) {
    throw new Error("Swap bounds disagree with the receipt");
  }
  return { maxIn, minOut, exactOut, hopPrice };
}

async function feedPrice(contract, pair, tokenDecimals, maximumAge, block) {
  const options = { blockTag: block.number };
  const [description, decimals, round] = await Promise.all([
    contract.description(options), contract.decimals(options), contract.latestRoundData(options),
  ]);
  const age = BigInt(block.timestamp) - round.updatedAt;
  if (description !== pair || decimals > 18n || round.answer <= 0n || round.updatedAt === 0n
    || round.answeredInRound < round.roundId || age < 0n || age > BigInt(maximumAge)) {
    throw new Error(`Unavailable or stale ${pair} feed`);
  }
  return { roundId: round.roundId.toString(), updatedAt: Number(round.updatedAt), answer: round.answer.toString(), decimals: Number(decimals),
    toUsdMicros: (amount, roundUp = false) => {
      const unit = 10n ** (decimals + BigInt(tokenDecimals));
      return (amount * round.answer * 1_000_000n + (roundUp ? unit - 1n : 0n)) / unit;
    } };
}

function ceilingBps(part, total) {
  return Number((part * 10_000n + total - 1n) / total);
}

export function historicalSwapPricer(provider, { WETH, USDC }) {
  const ethUsd = new Contract("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", feedAbi, provider);
  const usdcUsd = new Contract("0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", feedAbi, provider);
  const quoter = new Contract("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", quoterAbi, provider);
  return async (sample, call, fee) => {
    const parentNumber = sample.block - 1;
    try {
      const { maxIn, minOut, exactOut, hopPrice } = swapBounds(call, sample.routerVersion, sample, fee);
      const parent = await provider.getBlock(parentNumber);
      if (!parent) throw new Error("Missing parent block");
      const amount = exactOut ? minOut : maxIn;
      const method = exactOut ? quoter.quoteExactOutputSingle : quoter.quoteExactInputSingle;
      const [eth, usdc, [quoted]] = await Promise.all([
        feedPrice(ethUsd, "ETH / USD", 18, 3_600, parent),
        feedPrice(usdcUsd, "USDC / USD", 6, 90_000, parent),
        method.staticCall([sample.inputAsset, sample.outputAsset, amount, fee, 0n], { blockTag: parentNumber }),
      ]);
      const quoteInput = exactOut ? quoted : maxIn;
      const quoteOutput = exactOut ? minOut : quoted;
      const prices = { [WETH]: eth, [USDC]: usdc };
      const usdInput = prices[sample.inputAsset].toUsdMicros(quoteInput);
      const usdOutput = prices[sample.outputAsset].toUsdMicros(quoteOutput);
      if (usdInput === 0n || usdOutput === 0n) throw new Error("Quote below valuation resolution");
      const maximumUsdMicros = prices[sample.inputAsset].toUsdMicros(maxIn, true);
      const priceDeviationBps = ceilingBps(usdInput > usdOutput ? usdInput - usdOutput : usdOutput - usdInput, usdInput);
      const adverse = exactOut ? maxIn - quoteInput : quoteOutput - minOut;
      const slippageBps = adverse <= 0n ? 0 : ceilingBps(adverse, exactOut ? quoteInput : quoteOutput);
      const violations = [];
      if (maximumUsdMicros > BigInt(pricingLimits.maximumUsd) * 1_000_000n) violations.push("value");
      if (quoteInput > maxIn || quoteOutput < minOut) violations.push("quote-outside-bounds");
      if (slippageBps > pricingLimits.slippageBps) violations.push("slippage");
      if (priceDeviationBps > pricingLimits.priceDeviationBps) violations.push("price-deviation");
      return { status: violations.length ? "outside-limits" : "within-limits", parentNumber, parentHash: parent.hash,
        fee, exactOut, minimumHopPriceX36: hopPrice.toString(), maximumUsdMicros: maximumUsdMicros.toString(),
        slippageBps, priceDeviationBps, violations,
        maxIn: maxIn.toString(), minOut: minOut.toString(), quoteInput: quoteInput.toString(), quoteOutput: quoteOutput.toString(),
        prices: { ETH: eth, USDC: usdc } };
    } catch (error) {
      return { status: "inconclusive", parentNumber, reason: error.shortMessage ?? error.message };
    }
  };
}
