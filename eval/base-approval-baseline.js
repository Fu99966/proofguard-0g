import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Interface, MaxUint256, toQuantity } from "ethers";
import { policy } from "../server/demoData.js";
import { rpcProvider } from "../server/market.js";
import { evaluatePolicy } from "../server/policyEngine.js";

const fixtureFile = await readFile(new URL("./cases/base-usdc-approvals.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureFile);
const token = new Interface([
  "function approve(address spender,uint256 amount)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
const approvalTopic = token.getEvent("Approval").topicHash;
const sameAddress = (left, right) => typeof left === "string" && left.toLowerCase() === right.toLowerCase();
const provider = rpcProvider("https://base-rpc.publicnode.com");
const goPlusUrl = "https://api.gopluslabs.io/api/v1/transaction_simulation";

async function verifiedProposal({ hash, block, amount }, expected) {
  const allowance = BigInt(amount);
  const matchesLabel = expected === "ALLOW"
    ? allowance > 0n && allowance <= 1_000_000_000n
    : expected === "BLOCK" && allowance === MaxUint256;
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(hash), provider.getTransactionReceipt(hash),
  ]);
  if (!transaction || receipt?.status !== 1 || receipt.blockNumber !== block || transaction.blockHash !== receipt.blockHash
    || transaction.chainId !== BigInt(fixture.chainId)
    || block < fixture.fromBlock || block > fixture.toBlock || !matchesLabel
    || !sameAddress(transaction.to, fixture.token) || transaction.value !== 0n
    || transaction.data !== token.encodeFunctionData("approve", [fixture.spender, allowance])) {
    throw new Error(`Unexpected source transaction ${hash}.`);
  }
  const matchesReceipt = receipt.logs.filter((log) => sameAddress(log.address, fixture.token) && log.topics[0] === approvalTopic)
    .map((log) => token.parseLog(log).args).filter(({ owner, spender, value }) =>
      sameAddress(owner, transaction.from) && sameAddress(spender, fixture.spender) && value === allowance);
  if (matchesReceipt.length !== 1) throw new Error(`Missing unique approval event for ${hash}.`);
  return { chainId: fixture.chainId, from: transaction.from, to: transaction.to, value: "0", data: transaction.data };
}

async function scanWithGoPlus(proposal, amount) {
  const started = performance.now();
  try {
    const response = await fetch(goPlusUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain_id: toQuantity(proposal.chainId), from: proposal.from, to: proposal.to,
        data: proposal.data, value: toQuantity(BigInt(proposal.value)) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    const result = payload.result;
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok || payload.code !== 1 || result?.is_simulated !== true || result?.is_revert !== false
      || !Array.isArray(result.flagged) || !Array.isArray(result.suspicious_addresses)) {
      return { decision: "INCONCLUSIVE", apiCode: payload.code ?? null, latencyMs, reason: "No completed, non-reverted simulation" };
    }
    const flags = result.flagged.length + result.suspicious_addresses.length;
    const matchedAllowance = result.erc20_allowance_changes?.some((change) => sameAddress(change.token_address, fixture.token)
      && sameAddress(change.owner, proposal.from) && sameAddress(change.spender, fixture.spender)
      && BigInt(change.amount) === BigInt(amount)) ?? false;
    if (!matchedAllowance) return { decision: "INCONCLUSIVE", flags, latencyMs, reason: "Expected allowance was absent" };
    return { decision: flags ? "FLAG" : "CLEAR", flags, latencyMs };
  } catch (error) {
    return { decision: "INCONCLUSIVE", latencyMs: Math.round(performance.now() - started), reason: error.name };
  }
}

const started = new Date();
try {
  if ((await provider.getNetwork()).chainId !== BigInt(fixture.chainId)) throw new Error("Benchmark RPC is on the wrong network.");
  const groups = [];
  const owners = new Set();
  for (const { id, expected, labelReason, cases: samples } of fixture.groups) {
    const cases = [];
    for (const item of samples) {
      const proposal = await verifiedProposal(item, expected);
      const sender = proposal.from.toLowerCase();
      if (owners.has(sender)) throw new Error(`Duplicate sender for ${item.hash}.`);
      owners.add(sender);
      const verdict = evaluatePolicy(proposal, { ...policy, agentWallet: sender }, {
        market: { source: "USDC unit valuation for approval controls", usdMicros: { [fixture.token.toLowerCase()]: "1000000" } },
      });
      cases.push({ ...item,
        proofGuard: { decision: verdict.passed ? "ALLOW" : "BLOCK", blockers: verdict.blockers },
        goPlus: await scanWithGoPlus(proposal, item.amount) });
    }
    const blocked = cases.filter(({ proofGuard }) => proofGuard.decision === "BLOCK").length;
    const conclusive = cases.filter(({ goPlus }) => goPlus.decision !== "INCONCLUSIVE").length;
    const flagged = cases.filter(({ goPlus }) => goPlus.decision === "FLAG").length;
    groups.push({ id, expected, labelReason, sampleSize: cases.length,
      proofGuard: { blocked, [expected === "BLOCK" ? "recall" : "falsePositiveRate"]: blocked / cases.length },
      goPlus: { simulatedWithMatchingAllowance: conclusive, flagged, inconclusive: cases.length - conclusive,
        flagRateAmongConclusive: conclusive ? flagged / conclusive : null },
      cases });
  }
  console.log(JSON.stringify({
    scope: "Base mainnet bounded and unlimited USDC approval controls. GoPlus simulates current state and reports public risk flags. ProofGuard applies its local owner policy. No 0G requests or broadcasts.",
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeModified: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    fixtureSha256: createHash("sha256").update(fixtureFile).digest("hex"),
    measuredAt: started.toISOString(), elapsedMs: Date.now() - started.getTime(),
    sampleSize: owners.size, groups,
  }, null, 2));
} finally {
  provider.destroy();
}
