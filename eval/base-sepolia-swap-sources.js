import { readFile } from "node:fs/promises";
import { Contract, Interface, ZeroAddress } from "ethers";
import { rpcProvider } from "../server/market.js";
import { baseSepolia } from "../sdk/network.js";

const network = baseSepolia;
const factoryAddress = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const scanEnd = 60_748_000;
const scanStart = 60_548_000;
const minimum = 6;
const provider = rpcProvider(process.env.PROOFGUARD_RPC_URL || "https://base-sepolia-rpc.publicnode.com");
const factory = new Contract(factoryAddress, ["function getPool(address,address,uint24) view returns(address)"], provider);
const poolAbi = new Interface(["event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"]);
const erc20 = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const swapTopic = poolAbi.getEvent("Swap").topicHash;
const transferTopic = erc20.getEvent("Transfer").topicHash;
const lower = (value) => value?.toLowerCase();
const assets = [network.usdc, network.weth].sort();

async function verifySource(hash, pools) {
  const [transaction, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
  if (!transaction || !receipt || receipt.status !== 1 || transaction.chainId !== BigInt(network.chainId)
    || transaction.blockHash !== receipt.blockHash || receipt.blockNumber < scanStart || receipt.blockNumber > scanEnd) return null;
  const reference = receipt.logs.filter((log) => pools.has(lower(log.address)) && log.topics[0] === swapTopic);
  if (reference.length !== 1) return null;
  const [entry] = reference;
  const pool = lower(entry.address);
  const { amount0, amount1, sender, recipient } = poolAbi.parseLog(entry).args;
  if ((amount0 <= 0n || amount1 >= 0n) && (amount0 >= 0n || amount1 <= 0n)) return null;
  const tokenIn = amount0 > 0n ? assets[0] : assets[1];
  const tokenOut = amount0 > 0n ? assets[1] : assets[0];
  const amountIn = amount0 > 0n ? amount0 : amount1;
  const amountOut = amount0 > 0n ? -amount1 : -amount0;
  const transfers = receipt.logs.filter((log) => assets.includes(lower(log.address)) && log.topics[0] === transferTopic).map((log) => {
    const { from, to, value } = erc20.parseLog(log).args;
    return { token: lower(log.address), from: lower(from), to: lower(to), value };
  });
  const inputs = transfers.filter(({ token, to, value }) => token === tokenIn && to === pool && value === amountIn);
  const outputs = transfers.filter(({ token, from, to, value }) => token === tokenOut && from === pool && to === lower(recipient) && value === amountOut);
  if (inputs.length !== 1 || outputs.length !== 1) return null;
  const canonical = await provider.getBlock(receipt.blockNumber);
  if (canonical?.hash !== receipt.blockHash) return null;
  return { hash, block: receipt.blockNumber, blockHash: receipt.blockHash, txFrom: transaction.from, txTo: transaction.to, pool,
    fee: pools.get(pool), poolCaller: sender, recipient, payer: inputs[0].from,
    tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: amountOut.toString() };
}

try {
  if ((await provider.getNetwork()).chainId !== BigInt(network.chainId)) throw new Error("Base Sepolia is required.");
  const fees = [100, 500, 3000, 10000];
  const addresses = await Promise.all(fees.map((fee) => factory.getPool(...assets, fee, { blockTag: scanEnd })));
  const pools = new Map(addresses.flatMap((address, index) => address === ZeroAddress ? [] : [[lower(address), fees[index]]]));
  const metadata = { chainId: network.chainId, factory: factoryAddress, scanStart, scanEnd,
    source: "Mined Base Sepolia USDC/WETH V3 swaps. Successful canonical receipts, pool registered in the Uniswap factory, exact reciprocal transfers and a single matching Swap event.",
    modelsInvoked: false };
  const discovering = process.argv.includes("--discover");
  let cases;
  if (discovering) {
    cases = [];
    const visited = new Set();
    for (let toBlock = scanEnd; toBlock >= scanStart && cases.length < minimum; toBlock -= 2000) {
      const logs = await provider.getLogs({ fromBlock: Math.max(scanStart, toBlock - 1999), toBlock, address: [...pools.keys()], topics: [swapTopic] });
      logs.sort((left, right) => right.blockNumber - left.blockNumber || right.index - left.index);
      const hashes = [...new Set(logs.map((entry) => entry.transactionHash))].filter((hash) => !visited.has(hash));
      for (let offset = 0; offset < hashes.length && cases.length < minimum; offset += 8) {
        const group = hashes.slice(offset, offset + 8);
        group.forEach((hash) => visited.add(hash));
        const matches = (await Promise.all(group.map((hash) => verifySource(hash, pools)))).filter(Boolean);
        cases.push(...matches.slice(0, minimum - cases.length));
      }
    }
  } else {
    const fixture = JSON.parse(await readFile(new URL("./cases/base-sepolia-usdc-weth-swaps.json", import.meta.url), "utf8"));
    cases = await Promise.all(fixture.cases.map(({ hash }) => verifySource(hash, pools)));
    if (cases.some((row, index) => !row || JSON.stringify(row) !== JSON.stringify(fixture.cases[index]))) {
      throw new Error("A pinned Base Sepolia swap no longer matches its chain evidence.");
    }
  }
  if (cases.length < 5 || new Set(cases.map(({ hash }) => hash)).size !== cases.length) throw new Error(`Expected at least five distinct swaps. Found ${cases.length}.`);
  console.log(JSON.stringify({ ...metadata, cases }, null, 2));
} finally {
  provider.destroy();
}
