import "dotenv/config";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AbiCoder, Contract, Interface, Wallet, getAddress, solidityPacked, toQuantity, verifyTypedData } from "ethers";
import { chainlinkMarket, rpcProvider } from "../../server/market.js";
import { createProofGuardClient } from "../../sdk/index.js";
import { guardedSafeSigner } from "../../sdk/guard.js";
import { baseSepolia } from "../../sdk/network.js";
import { rebalance } from "./strategy.js";
import { checkRecipientRejection } from "./rejection.js";

const env = process.env;
const live = process.argv.includes("--send");
const once = !process.argv.includes("--observe-24h");
const interval = 5 * 60_000;
const runId = randomUUID();
const safe = getAddress(env.PROOFGUARD_AGENT_WALLET).toLowerCase();
const journal = env.PROOFGUARD_AGENT_LOG || "var/agent.jsonl";
const rpc = env.PROOFGUARD_RPC_URL;
const provider = rpcProvider(rpc);
const simulationProvider = env.PROOFGUARD_SIMULATION_RPC_URL ? rpcProvider(env.PROOFGUARD_SIMULATION_RPC_URL) : provider;
const baseChain = BigInt(baseSepolia.chainId);
if ((await provider.getNetwork()).chainId !== baseChain || (await simulationProvider.getNetwork()).chainId !== baseChain) {
  throw new Error("Trading and simulation RPCs must both be Base Sepolia.");
}
const market = chainlinkMarket({ rpc, ethFeed: env.PROOFGUARD_ETH_USD_FEED, usdcFeed: env.PROOFGUARD_USDC_USD_FEED });
const abi = AbiCoder.defaultAbiCoder();
const tokenAbi = ["function balanceOf(address account) view returns(uint256)",
  "function allowance(address owner,address spender) view returns(uint256)", "function approve(address spender,uint256 amount)"];
const tokenInterface = new Interface(tokenAbi);
const router = new Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline)"]);
const token = {
  [baseSepolia.weth]: new Contract(baseSepolia.weth, tokenAbi, provider),
  [baseSepolia.usdc]: new Contract(baseSepolia.usdc, tokenAbi, provider),
};
const permit2 = new Contract(baseSepolia.permit2, ["function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)"], provider);
const quoter = new Contract(baseSepolia.quoterV3, [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)",
], provider);
const signer = live ? new Wallet(env.PROOFGUARD_TESTNET_AGENT_KEY, provider) : null;
const guardAddress = live ? getAddress(env.PROOFGUARD_TESTNET_GUARD_ADDRESS) : null;
const guard = live ? await guardedSafeSigner(guardAddress, signer, safe) : null;
const client = live ? createProofGuardClient({ apiUrl: env.PROOFGUARD_API_URL, apiKey: env.PROOFGUARD_AGENT_API_KEY }) : null;
const issuer = live ? await guard.issuer() : null;
const agent = signer?.address ?? null;
let submissionsPaused = false;
let rejectionRecorded = false;
await mkdir(path.dirname(journal), { recursive: true, mode: 0o700 });

async function record(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), mode: live ? "testnet" : "observe", runId, ...entry },
    (_name, value) => typeof value === "bigint" ? value.toString() : value);
  await appendFile(journal, `${line}\n`, { mode: 0o600 });
  console.log(line);
}

const proposal = (to, data, memo) => ({ chainId: baseSepolia.chainId, from: safe, to, value: "0", data, memo });

async function simulate(signedCall, expected) {
  const tracked = [baseSepolia.usdc, baseSepolia.weth];
  const balanceCalls = tracked.map((asset) => ({ to: asset, data: tokenInterface.encodeFunctionData("balanceOf", [safe]) }));
  const simulated = await simulationProvider.send("eth_simulateV1", [{ blockStateCalls: [{ calls: [
    ...balanceCalls, { from: signer.address, to: guardAddress, data: signedCall, value: toQuantity(0) }, ...balanceCalls,
  ] }], traceTransfers: true, validation: false }, "latest"]);
  const calls = simulated[0]?.calls;
  if (calls?.length !== 5 || calls.some(({ status }) => BigInt(status ?? 0) !== 1n)) throw new Error("Guarded transaction simulation failed.");
  for (const [index, asset] of tracked.entries()) {
    const [before] = tokenInterface.decodeFunctionResult("balanceOf", calls[index].returnData);
    const [after] = tokenInterface.decodeFunctionResult("balanceOf", calls[index + 3].returnData);
    if (!expected && after !== before) throw new Error("An approval unexpectedly changed asset balances.");
    if (expected && asset === expected.tokenIn && before - after !== expected.amount) throw new Error("Unexpected simulated input balance change.");
    if (expected && asset === expected.tokenOut && after - before < expected.minOut) throw new Error("Simulated output is below the reviewed minimum.");
  }
  if (calls[2].logs?.some((log) => log.address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")) {
    throw new Error("Simulation detected an unexpected native balance transfer.");
  }
}

async function submit(tx, expected) {
  let signedCall;
  return client.guardedSend(tx, async ({ result }) => {
    const sent = await signer.sendTransaction({ to: guardAddress, data: signedCall, chainId: baseSepolia.chainId });
    await record({ event: "submitted", txHash: sent.hash, permitHash: result.permit.permitHash, target: tx.to });
    const receipt = await sent.wait(2, 100_000);
    if (receipt?.status !== 1) throw new Error("Base Sepolia execution did not confirm.");
    const consumed = receipt.logs.filter((log) => log.address.toLowerCase() === guardAddress.toLowerCase())
      .map((log) => guard.interface.parseLog(log)).some((log) => log?.name === "PermitConsumed" && log.args.permitHash === result.permit.permitHash);
    if (!consumed) throw new Error("The chain receipt did not record the reviewed permit.");
    await record({ event: "confirmed", txHash: receipt.hash, permitHash: result.permit.permitHash });
    return receipt;
  }, { verifyingContract: guardAddress, inspect: async ({ result, typedData }) => {
    const proof = result.onchainPermit;
    if (proof?.verifyingContract !== guardAddress || proof.issuer !== issuer
      || verifyTypedData(typedData.domain, typedData.types, typedData.message, proof.signature) !== issuer) {
      throw new Error("Missing or invalid Safe Guard issuer signature.");
    }
    const args = await guard.executeGuarded.populateTransaction(tx.to, tx.value, tx.data, typedData.message, proof.signature);
    signedCall = args.data;
    await simulate(signedCall, expected);
  } });
}

async function ensureAllowance(trade) {
  const allowance = await token[trade.tokenIn].allowance(safe, baseSepolia.permit2);
  if (allowance < trade.amount) await submit(proposal(trade.tokenIn, tokenInterface.encodeFunctionData("approve", [baseSepolia.permit2, trade.amount]),
    "Set the bounded token allowance required for the proposed Base Sepolia rebalance."));
  const permit = await permit2.allowance(safe, trade.tokenIn, baseSepolia.router);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (permit.amount >= trade.amount && permit.expiration > now + 300n) return;
  const data = permit2.interface.encodeFunctionData("approve", [trade.tokenIn, baseSepolia.router, trade.amount, now + 900n]);
  await submit(proposal(baseSepolia.permit2, data, "Authorize the registered testnet router for this bounded rebalance."));
}

async function tick() {
  const prices = await market({ tx: { chainId: baseSepolia.chainId } });
  if (!prices) throw new Error("Current independent market data is unavailable.");
  const blockTag = prices.blockTag;
  const [eth, weth, usdc] = await Promise.all([provider.getBalance(safe, blockTag),
    token[baseSepolia.weth].balanceOf(safe, { blockTag }), token[baseSepolia.usdc].balanceOf(safe, { blockTag })]);
  const trade = rebalance({ eth, weth, usdc, prices: prices.usdMicros,
    maxTradeUsdMicros: 10_000_000n });
  await record({ event: "position", blockTag, eth, weth, usdc, ...trade });
  if (!trade.tokenIn) return;
  const fees = [100, 500, 3000].map(async (fee) => {
    const [quoted] = await quoter.quoteExactInputSingle.staticCall({ tokenIn: trade.tokenIn, tokenOut: trade.tokenOut,
      amountIn: trade.amount, fee, sqrtPriceLimitX96: 0 }, { blockTag });
    return { fee, quoted };
  });
  const quotes = (await Promise.allSettled(fees)).filter((value) => value.status === "fulfilled").map(({ value }) => value);
  const inUsd = trade.amount * BigInt(prices.usdMicros[trade.tokenIn]) / (trade.tokenIn === baseSepolia.weth ? 10n ** 18n : 1_000_000n);
  const plausible = quotes.filter(({ quoted }) => {
    const outUsd = quoted * BigInt(prices.usdMicros[trade.tokenOut]) / (trade.tokenOut === baseSepolia.weth ? 10n ** 18n : 1_000_000n);
    const delta = outUsd > inUsd ? outUsd - inUsd : inUsd - outUsd;
    return outUsd > 0n && delta * 10_000n <= inUsd * 300n;
  });
  const best = plausible.reduce((selected, item) => !selected || item.quoted > selected.quoted ? item : selected, null);
  if (!best?.quoted) {
    if (once) throw new Error("No supported Uniswap V3 quote meets the price limit.");
    await record({ event: "quote-unavailable", blockTag, reason: "No supported quote meets the independent price limit." });
    return;
  }
  const minOut = best.quoted * 9975n / 10_000n;
  if (minOut === 0n) throw new Error("The swap cannot provide a nonzero output floor.");
  await record({ event: "quote", tokenIn: trade.tokenIn, tokenOut: trade.tokenOut, amount: trade.amount, minOut, fee: best.fee });
  if (!live || submissionsPaused) return;
  await ensureAllowance(trade);
  const pathBytes = solidityPacked(["address", "uint24", "address"], [trade.tokenIn, best.fee, trade.tokenOut]);
  const swap = abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [safe, trade.amount, minOut, pathBytes, true]);
  const data = router.encodeFunctionData("execute", ["0x00", [swap], Math.floor(Date.now() / 1000) + 240]);
  await submit(proposal(baseSepolia.router, data, "Rebalance toward 40% ETH exposure under the operator mandate."), { ...trade, minOut });
  if (!once && !rejectionRecorded) {
    await record(await checkRecipientRejection(client, safe));
    rejectionRecorded = true;
  }
}

async function recordBoundary(event, earliestTimestamp = 0) {
  let block = await provider.getBlock("latest");
  const cutoff = Date.now() + 30_000;
  while (block && block.timestamp < earliestTimestamp && Date.now() < cutoff) {
    await sleep(2_000);
    block = await provider.getBlock("latest");
  }
  if (!block || block.timestamp < earliestTimestamp) throw new Error("Base Sepolia observation boundary is unavailable.");
  await record({ event, chainId: baseSepolia.chainId, agent, safe, guard: guardAddress,
    blockTag: block.number, blockHash: block.hash, nonce: agent ? await provider.getTransactionCount(agent, block.number) : null });
  return block.timestamp;
}

const durationSeconds = 24 * 60 * 60;
const startedAtBlockTime = once ? null : await recordBoundary("run-started");
const end = Date.now() + durationSeconds * 1_000;
while (true) {
  try {
    await tick();
  } catch (error) {
    submissionsPaused ||= error.code === "ROUTER_BUDGET_EXHAUSTED";
    await record({ event: "halted-tick", issue: submissionsPaused ? "router-budget-exhausted" : "Review, market or submission failed" });
    if (once || (live && !submissionsPaused)) process.exit(1);
  }
  if (once || Date.now() >= end) break;
  await sleep(Math.min(interval, end - Date.now()));
}

if (!once) await recordBoundary("run-finished", startedAtBlockTime + durationSeconds);
