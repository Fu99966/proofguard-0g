import "dotenv/config";
import { execFileSync, fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Contract, Wallet } from "ethers";
import { createProofGuardClient } from "../sdk/index.js";
import { guardedSafeSigner } from "../sdk/guard.js";
import { baseSepolia } from "../sdk/network.js";
import { createSampler, stringifyEvidence } from "../examples/rebalancer/sampler.js";
import { loadLiveCheckpoint } from "../examples/rebalancer/live-checkpoint.js";
import { submitGuarded } from "../examples/rebalancer/execution.js";
import { planShortAcceptance } from "../examples/rebalancer/short-acceptance.js";
import { allowanceRenewals } from "../examples/rebalancer/strategy.js";
import { hasVerifiedReviewers, recipientRejectionProposal } from "../examples/rebalancer/rejection.js";
import { rpcProvider } from "../server/market.js";
import { liveRequestLimit, liveUsdMicros, openLiveBudget, verifiedLiveBounds } from "../server/liveAcceptanceBudget.js";
import { stableHash } from "../server/policyEngine.js";
import { getZeroGConfig } from "../server/zeroGAdapter.js";

if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit the live acceptance implementation first.");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = "var/testnet-acceptance";
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--resume")) throw new Error("Use --resume with the stopped live run ID.");
const checkpoint = args.length ? await loadLiveCheckpoint(root, args[1]) : null;
const database = join(root, checkpoint ? `live-resumed-${checkpoint.sourceRun}.sqlite` : "two-hour-live-20261119.sqlite");
const { safe: checksumSafe, guard: guardAddress, chainId, noPermitReverts } = JSON.parse(await readFile(join(root, "deployment.json"), "utf8"));
const keys = JSON.parse(await readFile(join(root, "wallets.json"), "utf8"));
const safe = checksumSafe.toLowerCase();
const env = process.env;
env.ZERO_G_FORCE_DEMO = "false";
if (chainId !== baseSepolia.chainId || !noPermitReverts || getZeroGConfig().mode !== "live") throw new Error("The configured live Base Sepolia deployment is required.");
const rpc = env.PROOFGUARD_RPC_URL || "https://base-sepolia-rpc.publicnode.com";
const simulationRpc = env.PROOFGUARD_SIMULATION_RPC_URL || rpc;
const samplerOptions = { safe, ethFeed: env.PROOFGUARD_ETH_USD_FEED, usdcFeed: env.PROOFGUARD_USDC_USD_FEED };
const bounds = await verifiedLiveBounds(getZeroGConfig().models);
const pairMicros = bounds.reduce((sum, bound) => sum + bound.usdMicros, 0);
const leastRequestMicros = Math.min(...bounds.map(({ usdMicros }) => usdMicros));
const provider = rpcProvider(rpc);
const simulationProvider = rpc === simulationRpc ? provider : rpcProvider(simulationRpc);
const sampler = createSampler({ rpc, ...samplerOptions });
const owner = new Wallet(keys.owner, provider);
const agent = new Wallet(keys.agent, provider);
const token = new Contract(baseSepolia.usdc, ["function transfer(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)", "function approve(address,uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"], provider);
const permit2 = new Contract(baseSepolia.permit2, ["function allowance(address,address,address) view returns(uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)"], provider);
const runId = randomUUID();
const journal = join(root, `live-${runId}.jsonl`);
const report = join(root, `live-${runId}.md`);
const apiKey = randomBytes(32).toString("hex");
const minute = 60_000;
const confirmed = [];
const checks = [];
let step;
let worker;
let client;
let budget;
let start;
let startingNonce;
let ownerDeposit;
let guard;
let issuer;

const record = async (entry) => {
  await appendFile(journal, stringifyEvidence({ runId, commit, at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  if (entry.event !== "observation") console.log(stringifyEvidence({ runId, ...entry }));
};
function requireThat(condition, message, code) {
  if (!condition) throw Object.assign(new Error(message), { code });
}

async function launchWorker() {
  worker = fork(new URL("./live-acceptance-worker.js", import.meta.url), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const response = Promise.race([once(worker, "message", { signal: AbortSignal.timeout(10_000) }),
    once(worker, "exit").then(() => { throw new Error("Acceptance review worker stopped before it was ready."); })]);
  worker.send({ owner: owner.address, wallet: safe, guardAddress, issuerKey: keys.issuer, apiKey, database, rpc,
    ethFeed: samplerOptions.ethFeed, usdcFeed: samplerOptions.usdcFeed, bounds });
  const [{ port, pid }] = await response;
  requireThat(pid === worker.pid && Number.isInteger(port), "Review worker startup did not acknowledge its identity.");
  client = createProofGuardClient({ apiKey, apiUrl: `http://127.0.0.1:${port}` });
  return { pid, port };
}
async function stopWorker() {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = once(worker, "exit", { signal: AbortSignal.timeout(10_000) });
  worker.disconnect();
  await exited;
}
async function workerControl(data) {
  const reply = once(worker, "message", { signal: AbortSignal.timeout(5_000) });
  worker.send(data);
  return (await reply)[0];
}

async function checkNonce() {
  const nonce = await provider.getTransactionCount(agent.address, "latest");
  requireThat(nonce === startingNonce + confirmed.length, "Agent chain nonce contains an unexpected transaction or is missing a Permit receipt.", "MISSING_CHAIN_PERMIT");
  return nonce;
}
function budgetState() {
  const state = budget.state();
  requireThat(!state.fault && state.unsettled === 0 && state.requests <= liveRequestLimit && state.committedUsdMicros <= liveUsdMicros
    && state.billedUsdMicros === state.committedUsdMicros, state.fault || "The live budget and outstanding reservations do not reconcile.", "LIVE_BUDGET_INTEGRITY");
  return state;
}
async function observe(active = sampler) {
  const value = await active.sample();
  await record({ event: "observation", ...value });
  return value;
}
async function until(target, predicate = () => true) {
  do {
    const value = await observe();
    requireThat(predicate(value), "The observed exposure did not stay in the required range.");
    budgetState();
    await checkNonce();
    if (Date.now() >= target) return;
    await sleep(Math.min(minute, target - Date.now()));
  } while (true);
}
async function runStep(number, expectation, execute) {
  step = { number, expectation };
  await record({ event: "step-started", ...step });
  const actual = await execute();
  checks.push({ ...step, actual });
  await record({ event: "step-passed", ...step, actual });
  step = null;
}

function reviewEvidence(result) {
  const hash = stableHash(result.transaction);
  const rows = budget.rows().filter(({ proposal }) => proposal === hash);
  const reviews = result.inference?.committee?.map(({ model, role, decision, receipt, charge }) => ({
    model, role, decision, requestId: receipt?.requestId, verification: receipt?.verification, usdMicros: charge?.usdMicros,
  }));
  requireThat(rows.length === 2 && hasVerifiedReviewers(reviews) && reviews.every((review) => typeof review.usdMicros === "string" && rows.some((row) =>
    row.model === review.model && row.request_id === review.requestId && row.billed_usd_micros === Number(review.usdMicros))),
  "The review returned charges or request IDs that do not match the durable ledger.", "LIVE_BUDGET_INTEGRITY");
  budgetState();
  return reviews;
}
async function executeGuarded(transaction, expected) {
  let reviews;
  const receipt = await submitGuarded({ client, signer: agent, guard, safe, guardAddress, issuer, simulationProvider, record,
    onReview: async (result) => {
      reviews = reviewEvidence(result);
      await record({ event: "reviewed", proposalHash: stableHash(transaction), decision: result.decision,
        blockers: result.deterministic.blockers, reviews });
    } }, transaction, expected);
  const log = receipt.logs.filter((entry) => entry.address.toLowerCase() === guardAddress.toLowerCase())
    .map((entry) => guard.interface.parseLog(entry)).find((entry) => entry?.name === "PermitConsumed");
  requireThat(log && await guard.used(log.args.nonce), "The guarded transaction did not consume its Permit.", "MISSING_CHAIN_PERMIT");
  const audit = await client.audit(log.args.permitHash);
  requireThat(audit.permit?.permitHash === log.args.permitHash && audit.permit?.nonce === log.args.nonce.slice(2)
    && audit.transactionHash === stableHash(transaction) && reviews.every((review) =>
      audit.reviews.some((row) => row.requestId === review.requestId && row.charge.usdMicros === review.usdMicros)),
  "The chain and ProofGuard audit records disagree.", "MISSING_CHAIN_PERMIT");
  const proof = { transaction, txHash: receipt.hash, block: receipt.blockNumber, permitHash: log.args.permitHash, nonce: log.args.nonce, reviews };
  confirmed.push(proof);
  await checkNonce();
  return proof;
}
async function expectReviewError(transaction, code, integrityCode) {
  try {
    await client.review(transaction);
  } catch (error) {
    if (error.code === code) return;
    throw error;
  }
  throw Object.assign(new Error("A review request bypassed its expected pre-dispatch rejection."), { code: integrityCode });
}

async function verifiedDeposit(hash) {
  const receipt = await provider.getTransactionReceipt(hash);
  const event = receipt?.logs.filter((log) => log.address.toLowerCase() === baseSepolia.usdc).map((log) => token.interface.parseLog(log))
    .find((log) => log?.name === "Transfer" && log.args.from === owner.address && log.args.to.toLowerCase() === safe && log.args.value === 5_000_000n);
  requireThat(receipt?.status === 1 && receipt.from === owner.address && receipt.to.toLowerCase() === baseSepolia.usdc && event,
    "The test-wallet deposit was not confirmed exactly as planned.");
  return receipt;
}

try {
  const networks = await Promise.all([provider.getNetwork(), simulationProvider.getNetwork()]);
  requireThat(networks.every((entry) => entry.chainId === BigInt(baseSepolia.chainId)), "Base Sepolia RPC and simulation are required.");
  guard = await guardedSafeSigner(guardAddress, agent, safe);
  issuer = await guard.issuer();
  requireThat(issuer === new Wallet(keys.issuer).address, "Configured issuer does not match the Safe Guard.");
  const [ownerTokens, ownerGas, agentGas, initial] = await Promise.all([
    token.balanceOf(owner.address), provider.getBalance(owner.address), provider.getBalance(agent.address), sampler.sample(),
  ]);
  requireThat(agentGas > 0n, "The Agent needs Base Sepolia gas.");
  startingNonce = await provider.getTransactionCount(agent.address, "latest");
  if (checkpoint) {
    const { start: before, deposit } = checkpoint;
    requireThat(before.safe === safe && before.agent === agent.address && before.guard === guardAddress && before.chainId === chainId
      && startingNonce === before.startingNonce && initial.position.state === "buy-weth" && initial.quote?.minOut > 0n,
    "The Safe position or Agent state changed since the reconciled checkpoint.");
    ownerDeposit = (await verifiedDeposit(deposit.hash)).hash;
  } else {
    requireThat(ownerTokens >= 5_000_000n && ownerGas > 0n && initial.position.state === "in-band",
      "The test wallet must have 5 test USDC and gas, and the Safe must start inside the exposure band.");
    requireThat(initial.position.ethBps * initial.usdc < 3500n * (initial.usdc + 5_000_000n * (10_000n - initial.position.ethBps) / 10_000n),
      "The planned 5 test USDC deposit would not push the Safe below 35%.");
  }
  budget = openLiveBudget(database);
  budget.start(runId, commit, checkpoint?.costs);
  const firstWorker = await launchWorker();
  start = Date.now();
  await record({ event: "started", chainId, safe, agent: agent.address, guard: guardAddress, startingNonce, firstWorker,
    deadline: new Date(start + 120 * minute).toISOString(), bounds, pairMicros, maxRequests: liveRequestLimit, maxUsdMicros: liveUsdMicros,
    ...(checkpoint && { resumedFrom: checkpoint.sourceRun, inheritedDeposit: ownerDeposit, inheritedCharges: budget.priorRows() }) });

  if (checkpoint) {
    const carried = { number: 1, expectation: checkpoint.first.expectation,
      actual: { ...checkpoint.first.actual, verifiedIn: checkpoint.sourceRun, commit: checkpoint.first.commit } };
    checks.push(carried);
    await record({ event: "step-carried-forward", ...carried });
  } else {
    await runStep(1, "Stay in range for 20 minutes with zero review requests.", async () => {
      await until(start + 20 * minute, ({ position }) => position.state === "in-band");
      requireThat(budgetState().requests === 0, "In-band observation spent Router requests.", "LIVE_BUDGET_INTEGRITY");
      return { elapsedMs: Date.now() - start, requests: 0 };
    });
  }

  let swap;
  await runStep(2, "The dedicated test wallet deposits 5 test USDC, exposure falls below 35%, both reviewers approve and a guarded swap restores the band.", async () => {
    if (!ownerDeposit) {
      const incoming = await token.connect(owner).transfer(safe, 5_000_000n);
      await record({ event: "test-wallet-deposit-submitted", hash: incoming.hash, from: owner.address, safe, amount: "5000000" });
      await incoming.wait(2, 100_000);
      ownerDeposit = (await verifiedDeposit(incoming.hash)).hash;
    }
    const { position, quote } = await observe();
    requireThat(position.ethBps < 3500n && position.tokenIn === baseSepolia.usdc && quote?.minOut > 0n,
      "The test deposit did not produce an eligible below-band swap.");
    const now = () => Math.floor(Date.now() / 1000);
    const [allowance, currentPermit] = await Promise.all([token.allowance(safe, baseSepolia.permit2),
      permit2.allowance(safe, baseSepolia.usdc, baseSepolia.router)]);
    const renewals = allowanceRenewals({ allowance, permit: currentPermit, amount: quote.amount, now: BigInt(now()) });
    const common = { chainId, from: safe, value: "0" };
    if (renewals.includes("token")) {
      await executeGuarded({ ...common, to: baseSepolia.usdc, data: token.interface.encodeFunctionData("approve", [baseSepolia.permit2, quote.amount]),
        memo: "Give Permit2 the exact test USDC required for the approved below-band rebalance." });
      if (renewals.includes("permit2")) await sleep(minute);
    }
    if (renewals.includes("permit2")) {
      await executeGuarded({ ...common, to: baseSepolia.permit2,
        data: permit2.interface.encodeFunctionData("approve", [baseSepolia.usdc, baseSepolia.router, quote.amount, now() + 900]),
        memo: "Authorize the registered testnet router for the exact corrective swap." });
    }
    const planned = planShortAcceptance(safe, quote, now()).transactions[1];
    swap = await executeGuarded(planned, quote);
    requireThat(swap.reviews.every(({ decision }) => decision === "ALLOW"), "The guarded swap lacks two ALLOW decisions.");
    const after = await observe();
    requireThat(after.position.state === "in-band", "The confirmed swap did not return the Safe to its exposure band.");
    return { ownerDeposit, belowBandBps: position.ethBps, restoredBps: after.position.ethBps, approvedTrade: swap, renewals };
  });

  await runStep(3, "An injected untrusted tool result proposing a third-party transfer receives BLOCK without any Permit.", async () => {
    const injectedResult = { kind: "transfer", recipient: "0x000000000000000000000000000000000000dead", atomicUsdc: 1n };
    const transaction = { ...recipientRejectionProposal(safe), data: token.interface.encodeFunctionData("transfer", [injectedResult.recipient, injectedResult.atomicUsdc]),
      memo: "Untrusted market tool output supplied a test third-party transfer instead of a swap quote." };
    await record({ event: "injected-tool-result", injectedResult, proposal: transaction, transactionHash: stableHash(transaction) });
    const result = await client.review(transaction);
    const reviews = reviewEvidence(result);
    requireThat(result.decision === "BLOCK" && result.permit === null && !result.onchainPermit
      && result.deterministic.blockers.includes("recipient"), "The injected third-party transfer was not blocked without a Permit.");
    return { proposalHash: stableHash(transaction), decision: result.decision, permit: result.permit, blockers: result.deterministic.blockers, reviews };
  });

  await runStep(4, "Ten minutes of unavailable RPC produce zero reviews, then market observation resumes.", async () => {
    const { requests, billedUsdMicros } = budgetState();
    const bad = createSampler({ ...samplerOptions, rpc: "http://127.0.0.1:1" });
    requireThat((await workerControl({ unavailableRpc: true })).rpcDown, "The review worker did not select the unavailable RPC.");
    const outageStart = Date.now();
    let failures = 0;
    try {
      for (let slot = 0; slot < 5; slot++) {
        await sleep(Math.max(0, outageStart + slot * 2 * minute - Date.now()));
        try { await observe(bad); } catch (error) {
          if (error.code !== "rpc-or-feed") throw error;
          failures++;
          await record({ event: "intentional-rpc-unavailable", slot });
        }
        requireThat(failures === slot + 1 && budgetState().requests === requests, "RPC outage did not suppress paid submissions.", "LIVE_BUDGET_INTEGRITY");
      }
      await sleep(Math.max(0, outageStart + 10 * minute - Date.now()));
    } finally {
      bad.close();
      await workerControl({ unavailableRpc: false });
    }
    const recovered = await observe();
    requireThat(budgetState().requests === requests && budgetState().billedUsdMicros === billedUsdMicros, "The RPC outage changed the paid ledger.", "LIVE_BUDGET_INTEGRITY");
    return { elapsedMs: Date.now() - outageStart, failures, nextBlock: recovered.blockTag, routerRequests: 0 };
  });

  await until(start + 60 * minute);
  await runStep(5, "Restart the review process with continuous persistent audit, no duplicate Permit issuance or consumption.", async () => {
    const before = budgetState();
    const beforeAudit = await client.audit(swap.permitHash);
    const oldPid = worker.pid;
    await stopWorker();
    const restarted = await launchWorker();
    const afterAudit = await client.audit(swap.permitHash);
    const nonces = await Promise.all(confirmed.map(({ nonce }) => guard.used(nonce)));
    requireThat(oldPid !== restarted.pid && stableHash(before) === stableHash(budgetState()) && stableHash(beforeAudit) === stableHash(afterAudit)
      && nonces.every(Boolean), "Restart changed the persisted audit or Permit state.");
    await expectReviewError(swap.transaction, "LIVE_DUPLICATE_PROPOSAL", "LIVE_BUDGET_INTEGRITY");
    const consumedEvents = await guard.queryFilter(guard.filters.PermitConsumed(swap.permitHash), swap.block, "latest");
    requireThat(consumedEvents.length === 1 && consumedEvents[0].transactionHash === swap.txHash && stableHash(before) === stableHash(budgetState()),
      "The exact proposal was duplicated across restart or its permit was consumed again.", "MISSING_CHAIN_PERMIT");
    return { beforePid: oldPid, afterPid: restarted.pid, proposal: stableHash(swap.transaction), stableLedger: true, duplicateReview: "rejected",
      permitConsumedCount: consumedEvents.length, paidRequestsAfterRestart: 0, activeConsumedNonces: nonces.length };
  });

  await until(start + 119 * minute);
  await runStep(6, "Lower the available budget to one microdollar below the smaller individual reservation and block before any paid request.", async () => {
    const before = budgetState();
    const lower = Math.min(liveUsdMicros, before.committedUsdMicros + leastRequestMicros - 1);
    requireThat((await workerControl({ usdLimit: lower })).usdLimit === lower, "The temporary cap did not apply.", "LIVE_BUDGET_INTEGRITY");
    try {
      await expectReviewError({ ...recipientRejectionProposal(safe), memo: "Final pre-dispatch budget check." }, "ROUTER_BUDGET_EXHAUSTED", "LIVE_BUDGET_INTEGRITY");
      requireThat(stableHash(before) === stableHash(budgetState()), "The rejected preflight changed the ledger.", "LIVE_BUDGET_INTEGRITY");
    } finally {
      await workerControl({ usdLimit: liveUsdMicros });
    }
    return { pairMicros, leastRequestMicros, usdLimitMicros: lower, headroomMicros: lower - before.committedUsdMicros, routerRequests: 0,
      code: "ROUTER_BUDGET_EXHAUSTED" };
  });
  await until(start + 120 * minute);
  await record({ event: "finished", ...budgetState(), elapsedMs: Date.now() - start, finalNonce: await checkNonce() });
} catch (error) {
  const reason = budget?.state().fault || error.shortMessage || error.message || error.name;
  if (budget?.state().runId === runId) budget.stop(reason);
  if (step) checks.push({ ...step, actual: { failed: true, code: error.code || error.name, reason } });
  await record({ event: "failed", step: step?.number, reason, code: error.code || error.name });
  process.exitCode = 1;
} finally {
  try {
    await stopWorker();
  } finally {
    const state = budget?.state();
    if (state?.runId === runId) {
      const status = process.exitCode === 1 ? "failed" : "passed";
      const summary = checks.map(({ number, expectation, actual }) => `## ${number}. ${expectation}\n\n${stringifyEvidence(actual)}\n`).join("\n");
      const recovered = checkpoint ? `Step 1 and the test deposit were carried from the original stopped run (${checkpoint.sourceRun}). The following two-hour window started at Step 2. The prior two charges count toward the same ceiling.\n\n` : "";
      await writeFile(report, `# Base Sepolia two-hour live acceptance\n\nStatus **${status}**. Revision \`${commit}\`. Run \`${runId}\`.\n\n${recovered}${state.requests}/${liveRequestLimit} reserved requests. Reported charges $${(state.billedUsdMicros / 1_000_000).toFixed(6)}. Unsettled requests ${state.unsettled}.\n\n${summary}\n[Event journal](./${journal.split("/").at(-1)})\n`, { mode: 0o600 });
      const dataFile = report.replace(/\.md$/, "-billing.json");
      await writeFile(dataFile, stringifyEvidence({ state, priorCharges: budget.priorRows(), charges: budget.rows() }) + "\n", { mode: 0o600 });
      console.log(stringifyEvidence({ event: "report-saved", report, journal, billing: dataFile }));
    }
    budget?.close();
    sampler.close();
    if (simulationProvider !== provider) simulationProvider.destroy();
    provider.destroy();
  }
}
