import "dotenv/config";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AbiCoder, Contract, Interface, Wallet, getAddress, solidityPacked } from "ethers";
import { chainlinkMarket, rpcProvider } from "../../server/market.js";
import { createProofGuardClient } from "../../sdk/index.js";
import { guardedSafeSigner } from "../../sdk/guard.js";
import { baseSepolia } from "../../sdk/network.js";
import { submitGuarded } from "./execution.js";
import { allowanceRenewals, rebalance, reviewCycleStatus } from "./strategy.js";
import { checkRecipientRejection } from "./rejection.js";
import { minimumRenewalSeconds } from "./short-acceptance.js";

const env = process.env;
const live = process.argv.includes("--send");
const short = process.argv.includes("--short-acceptance");
const once = !process.argv.includes("--observe-24h");
const interval = 5 * 60_000;
const runId = env.PROOFGUARD_ACCEPTANCE_RUN_ID || randomUUID();
const acceptanceCommit = env.PROOFGUARD_ACCEPTANCE_COMMIT;
if (short && (!live || !once || !/^[a-f\d]{40}$/.test(acceptanceCommit ?? ""))) throw new Error("Short acceptance requires a committed live testnet launcher.");
const safe = getAddress(env.PROOFGUARD_AGENT_WALLET).toLowerCase();
const journal = env.PROOFGUARD_AGENT_LOG || "var/agent.jsonl";
const rpc = env.PROOFGUARD_RPC_URL;
const provider = rpcProvider(rpc);
const simulationProvider = env.PROOFGUARD_SIMULATION_RPC_URL ? rpcProvider(env.PROOFGUARD_SIMULATION_RPC_URL) : provider;
const baseChain = BigInt(baseSepolia.chainId);
if ((await provider.getNetwork()).chainId !== baseChain || (await simulationProvider.getNetwork()).chainId !== baseChain) {
  throw new Error("Trading and simulation RPCs must both be Base Sepolia.");
}
const market = chainlinkMarket({ rpc, ethFeed: env.PROOFGUARD_ETH_USD_FEED || undefined, usdcFeed: env.PROOFGUARD_USDC_USD_FEED });
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
let reviewAttemptsInCycle = 0;
let consecutiveReviewCycles = 0;
await mkdir(path.dirname(journal), { recursive: true, mode: 0o700 });

async function record(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), mode: live ? "testnet" : "observe", runId,
    ...(acceptanceCommit && { commit: acceptanceCommit }), ...entry },
    (_name, value) => typeof value === "bigint" ? value.toString() : value);
  await appendFile(journal, `${line}\n`, { mode: 0o600 });
  console.log(line);
}

const proposal = (to, data, memo) => ({ chainId: baseSepolia.chainId, from: safe, to, value: "0", data, memo });

function submit(tx, expected) {
  reviewAttemptsInCycle += 1;
  return submitGuarded({ client, signer, guard, safe, guardAddress, issuer, simulationProvider, record }, tx, expected);
}

async function ensureAllowance(trade) {
  const [allowance, permit] = await Promise.all([token[trade.tokenIn].allowance(safe, baseSepolia.permit2),
    permit2.allowance(safe, trade.tokenIn, baseSepolia.router)]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const renewals = allowanceRenewals({ allowance, permit, amount: trade.amount, now });
  if (!once && renewals.length > 1) {
    await record({ event: "allowance-renewal-anomaly", requiredRenewals: renewals.length, approvalTypes: renewals, submittedRenewals: 0,
      tokenIn: trade.tokenIn });
    return false;
  }
  if (renewals.includes("token")) await submit(proposal(trade.tokenIn, tokenInterface.encodeFunctionData("approve", [baseSepolia.permit2, trade.amount]),
    "Set the bounded token allowance required for the proposed Base Sepolia rebalance."));
  if (renewals.includes("permit2")) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + 900n;
    const data = permit2.interface.encodeFunctionData("approve", [trade.tokenIn, baseSepolia.router, trade.amount, expiresAt]);
    await submit(proposal(baseSepolia.permit2, data, "Authorize the registered testnet router for this bounded rebalance."));
  }
  return true;
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
  if (!await ensureAllowance(trade)) return;
  const pathBytes = solidityPacked(["address", "uint24", "address"], [trade.tokenIn, best.fee, trade.tokenOut]);
  const swap = abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [safe, trade.amount, minOut, pathBytes, true]);
  const data = router.encodeFunctionData("execute", ["0x00", [swap], Math.floor(Date.now() / 1000) + 240]);
  await submit(proposal(baseSepolia.router, data, "Rebalance toward 40% ETH exposure under the operator mandate."), { ...trade, minOut });
  if (!once && !rejectionRecorded) {
    reviewAttemptsInCycle += 1;
    await record(await checkRecipientRejection(client, safe, { requireModels: false }));
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

if (short) {
  const plan = JSON.parse(env.PROOFGUARD_SHORT_PLAN);
  const [renewal, swap] = plan.transactions;
  let step = "permit2-renewal";
  await record({ event: "short-started", amount: plan.amount, tokenIn: plan.tokenIn, expiresAt: plan.expiresAt });
  try {
    const [allowance, currentPermit] = await Promise.all([token[plan.tokenIn].allowance(safe, baseSepolia.permit2),
      permit2.allowance(safe, plan.tokenIn, baseSepolia.router)]);
    if (allowance < BigInt(plan.amount) || currentPermit.expiration > BigInt(Math.floor(Date.now() / 1000))) {
      throw new Error("The required ERC-20 allowance or expired Permit2 state does not match the approved three-step flow.");
    }
    const renewalReceipt = await submit(renewal);
    const [block, renewed] = await Promise.all([provider.getBlock(renewalReceipt.blockNumber),
      permit2.allowance(safe, plan.tokenIn, baseSepolia.router, { blockTag: renewalReceipt.blockNumber })]);
    if (renewed.amount !== BigInt(plan.amount) || renewed.expiration !== BigInt(plan.expiresAt)
      || !block || plan.expiresAt - block.timestamp < minimumRenewalSeconds) throw new Error("The confirmed allowance does not meet the requested amount and 48-hour validity.");
    await record({ event: "permit2-renewal-verified", step, blockTag: block.number, txHash: renewalReceipt.hash,
      amount: renewed.amount, expiresAt: plan.expiresAt, remainingSeconds: plan.expiresAt - block.timestamp, reason: renewal.memo });
    step = "safe-swap";
    await submit(swap, { ...plan, amount: BigInt(plan.amount), minOut: BigInt(plan.minOut) });
    const after = await market({ tx: { chainId: baseSepolia.chainId, from: safe } });
    const exposure = after?.portfolio?.ethExposureBps;
    if (!Number.isFinite(exposure) || exposure < 3500 || exposure > 4500) throw new Error("The confirmed swap did not return exposure to the 35–45% band.");
    await record({ event: "post-swap-position", blockTag: after.blockTag, ethExposureBps: exposure });
    step = "invalid-recipient";
    await record(await checkRecipientRejection(client, safe));
    await record({ event: "short-finished" });
    process.exit(0);
  } catch (error) {
    await record({ event: "short-failed", step, reason: error.message });
    process.exit(1);
  }
}

const durationSeconds = 24 * 60 * 60;
const startedAtBlockTime = once ? null : await recordBoundary("run-started");
const end = Date.now() + durationSeconds * 1_000;
while (true) {
  reviewAttemptsInCycle = 0;
  try {
    await tick();
  } catch (error) {
    if (error.code === "ROUTER_BUDGET_EXHAUSTED") {
      submissionsPaused = true;
      await record({ event: "run-submissions-paused", reason: "router-budget-exhausted" });
    } else {
      await record({ event: "halted-tick", issue: "Review, market or submission failed" });
    }
    if (once || (live && !submissionsPaused)) process.exit(1);
  }
  if (live && !once && !submissionsPaused) {
    const cycle = reviewCycleStatus(consecutiveReviewCycles, reviewAttemptsInCycle);
    consecutiveReviewCycles = cycle.consecutiveCycles;
    if (cycle.pause) {
      submissionsPaused = true;
      await record({ event: "run-submissions-paused", reason: "three-consecutive-review-cycles", classification: "bug", consecutiveReviewCycles });
    }
  }
  if (once || Date.now() >= end) break;
  await sleep(Math.min(interval, end - Date.now()));
}

if (!once) await recordBoundary("run-finished", startedAtBlockTime + durationSeconds);
