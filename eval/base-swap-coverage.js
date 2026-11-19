import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Contract, Interface, ZeroAddress, zeroPadValue } from "ethers";
import { decodeTransaction } from "../server/decoder.js";
import { policy } from "../server/demoData.js";
import { rpcProvider } from "../server/market.js";

const fixtureFile = await readFile(new URL("./cases/base-usdc-weth-swaps.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureFile);
const provider = rpcProvider("https://base-rpc.publicnode.com");
const factory = new Contract(fixture.factory, ["function getPool(address,address,uint24) view returns(address)"], provider);
const poolAbi = new Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const tokenAbi = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const routerAbi = new Interface([
  "function execute(bytes commands,bytes[] inputs)",
  "function execute(bytes commands,bytes[] inputs,uint256 deadline)",
]);
const swapTopic = poolAbi.getEvent("Swap").topicHash;
const transferTopic = tokenAbi.getEvent("Transfer").topicHash;
const { WETH, USDC } = fixture.assets;
const sampleSize = 30;
const maximumPerSender = 3;

async function source(hash, pools) {
  const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
  if (!tx?.to || tx.chainId !== BigInt(fixture.chainId) || !Object.hasOwn(fixture.routers, tx.to.toLowerCase()) || tx.value !== 0n
    || tx.blockNumber < fixture.fromBlock || tx.blockNumber > fixture.toBlock) return null;
  if (receipt?.status !== 1 || receipt.blockHash !== tx.blockHash) return null;
  const swaps = receipt.logs.filter((log) => pools.includes(log.address) && log.topics[0] === swapTopic);
  if (swaps.length !== 1) return null;
  const [swap] = swaps;
  const { sender, amount0, amount1 } = poolAbi.parseLog(swap).args;
  if (sender !== tx.to || !((amount0 > 0n && amount1 < 0n) || (amount0 < 0n && amount1 > 0n))) return null;
  const inputAsset = amount0 > 0n ? WETH : USDC;
  const outputAsset = amount0 > 0n ? USDC : WETH;
  const input = amount0 > 0n ? amount0 : amount1;
  const output = amount0 > 0n ? -amount1 : -amount0;
  const transfers = receipt.logs.filter((log) => [USDC, WETH].includes(log.address) && log.topics[0] === transferTopic)
    .map((log) => {
      const { from, to, value } = tokenAbi.parseLog(log).args;
      return { asset: log.address, from, to, value };
    })
    .filter(({ from, to }) => [from, to].includes(tx.from));
  if (transfers.length !== 2
    || !transfers.some(({ asset, from, to, value }) => asset === inputAsset && from === tx.from && to === swap.address && value === input)
    || !transfers.some(({ asset, from, to, value }) => asset === outputAsset && from === swap.address && to === tx.from && value === output)) return null;
  const observed = { hash, block: receipt.blockNumber, pool: swap.address, router: tx.to,
    inputAsset, outputAsset, amountIn: input.toString(), amountOut: output.toString() };
  const proposal = { chainId: fixture.chainId, from: tx.from, to: tx.to, value: "0", data: tx.data };
  return { observed, proposal };
}

async function discover(pools) {
  const selected = [];
  const visited = new Set();
  const senders = new Map();
  const routerTopics = Object.keys(fixture.routers).map((address) => zeroPadValue(address, 32));
  const poolTopics = pools.map((address) => zeroPadValue(address, 32));
  for (let end = fixture.toBlock; end >= fixture.fromBlock && selected.length < sampleSize; end -= 2000) {
    const range = { fromBlock: Math.max(fixture.fromBlock, end - 1999), toBlock: end };
    const [logs, transfersIn, transfersOut] = await Promise.all([
      provider.getLogs({ ...range, address: pools, topics: [swapTopic, routerTopics] }),
      provider.getLogs({ ...range, address: [WETH, USDC], topics: [transferTopic, null, poolTopics] }),
      provider.getLogs({ ...range, address: [WETH, USDC], topics: [transferTopic, poolTopics] }),
    ]);
    const incoming = new Set(transfersIn.map(({ transactionHash, topics }) => `${transactionHash}:${topics[1]}:${topics[2]}`));
    const paired = new Set(transfersOut.filter(({ transactionHash, topics }) =>
      incoming.has(`${transactionHash}:${topics[2]}:${topics[1]}`)).map(({ transactionHash }) => transactionHash));
    logs.sort((first, second) => second.blockNumber - first.blockNumber || second.index - first.index);
    const hashes = [...new Set(logs.map(({ transactionHash }) => transactionHash))]
      .filter((hash) => paired.has(hash) && !visited.has(hash));
    for (let offset = 0; offset < hashes.length && selected.length < sampleSize; offset += 20) {
      const batch = hashes.slice(offset, offset + 20);
      batch.forEach((hash) => visited.add(hash));
      for (const result of await Promise.all(batch.map((hash) => source(hash, pools)))) {
        if (!result) continue;
        const { from } = result.proposal;
        const count = senders.get(from) ?? 0;
        if (count === maximumPerSender) continue;
        senders.set(from, count + 1);
        selected.push(result.observed);
        if (selected.length === sampleSize) break;
      }
    }
  }
  if (selected.length !== sampleSize) throw new Error(`Found only ${selected.length} direct swaps.`);
  return selected;
}

function compare(observed, proposal) {
  const call = routerAbi.parseTransaction({ data: proposal.data });
  const encoded = call && routerAbi.encodeFunctionData(call.fragment, call.args).toLowerCase();
  const data = proposal.data.toLowerCase();
  const trailingBytes = encoded && data.startsWith(encoded) ? (data.length - encoded.length) / 2 : null;
  const registered = Boolean(policy.routers[`${fixture.chainId}:${proposal.to.toLowerCase()}`]);
  let effectsMatched = false;
  let decodeError;
  try {
    const decoded = decodeTransaction(proposal, policy);
    const swaps = decoded.effects.filter(({ kind }) => kind === "swap");
    const [swap] = swaps;
    effectsMatched = swaps.length === 1 && swap.from === proposal.from.toLowerCase() && swap.recipient === swap.from
      && swap.path.length === 2 && swap.path[0] === observed.inputAsset.toLowerCase() && swap.path[1] === observed.outputAsset.toLowerCase()
      && BigInt(swap.maxIn) >= BigInt(observed.amountIn) && BigInt(swap.minOut) <= BigInt(observed.amountOut);
  } catch (error) {
    decodeError = error.message;
  }
  return { ...observed, routerVersion: fixture.routers[proposal.to.toLowerCase()], registered, trailingBytes, effectsMatched, decodeError };
}

try {
  if ((await provider.getNetwork()).chainId !== BigInt(fixture.chainId)) throw new Error("Coverage RPC is on the wrong network.");
  const poolAddresses = await Promise.all(fixture.fees.map((fee) => factory.getPool(WETH, USDC, fee, { blockTag: fixture.toBlock })));
  const pools = poolAddresses.filter((address) => address !== ZeroAddress);
  if (process.argv.includes("--discover")) {
    console.log(JSON.stringify(await discover(pools), null, 2));
  } else {
    if (fixture.cases.length !== sampleSize) throw new Error("Expected 30 pinned swaps.");
    const cases = [];
    const senders = new Map();
    const hashes = new Set();
    const verified = await Promise.all(fixture.cases.map(({ hash }) => source(hash, pools)));
    for (const [index, result] of verified.entries()) {
      const sample = fixture.cases[index];
      if (!result || hashes.has(sample.hash) || Object.entries(result.observed).some(([key, value]) => sample[key] !== value)) {
        throw new Error(`Could not verify pinned swap ${sample.hash}.`);
      }
      hashes.add(sample.hash);
      const { from } = result.proposal;
      const count = senders.get(from) ?? 0;
      if (count === maximumPerSender) throw new Error(`Sample exceeds the per-sender cap at ${sample.hash}.`);
      senders.set(from, count + 1);
      cases.push(compare(result.observed, result.proposal));
    }
    console.log(JSON.stringify({ scope: "Mined direct USDC/WETH swap coverage on Base",
      revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      workingTreeModified: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
      blockRange: [fixture.fromBlock, fixture.toBlock], measuredAt: new Date().toISOString(),
      fixtureSha256: createHash("sha256").update(fixtureFile).digest("hex"), sampleSize: cases.length, distinctSenders: senders.size,
      modelsInvoked: false,
      registered: cases.filter(({ registered }) => registered).length,
      canonical: cases.filter(({ trailingBytes }) => trailingBytes === 0).length,
      canonicalPrefixWithSuffix: cases.filter(({ trailingBytes }) => trailingBytes > 0).length,
      effectsMatched: cases.filter(({ effectsMatched }) => effectsMatched).length, cases }, null, 2));
  }
} finally {
  provider.destroy();
}
