import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { formatUnits, Interface, MaxUint256, toQuantity } from "ethers";
import { policy } from "../server/demoData.js";
import { rpcProvider } from "../server/market.js";
import { evaluatePolicy } from "../server/policyEngine.js";
import { getZeroGConfig } from "../server/zeroGAdapter.js";
import { evaluateApprovalCommittee, summarizeApprovalCommittee } from "./approval-committee.js";

const fixtureFile = await readFile(new URL("./cases/base-usdc-approvals.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureFile);
const { values: options } = parseArgs({ options: { "committee-plan": { type: "boolean" }, "live-committee": { type: "boolean" },
  "archived-goplus": { type: "string" }, "max-router-requests": { type: "string" }, journal: { type: "string" } } });
const live = options["live-committee"];
const plan = options["committee-plan"];
const cap = Number(options["max-router-requests"]);
const plannedRequests = fixture.groups.reduce((count, group) => count + group.cases.length * 2, 0);
const archivePath = options["archived-goplus"];
const mode = live ? "live-committee" : plan ? "committee-plan" : archivePath ? "historical-comparison" : "deterministic-and-goplus";
if ((live && plan) || (archivePath && (live || plan)) || (!live && (options.journal || options["max-router-requests"]))) throw new Error("Select one evaluation mode.");
if (live) {
  if (!Number.isSafeInteger(cap) || cap < plannedRequests || !options.journal) {
    throw new Error(`The full approval evaluation requires an explicit cap of at least ${plannedRequests} Router requests and a new journal path.`);
  }
  const key = process.env.PROOFGUARD_APPROVAL_EVAL_API_KEY?.trim();
  if (!key) throw new Error("Configure PROOFGUARD_APPROVAL_EVAL_API_KEY for the approved evaluation run.");
  process.env.ZERO_G_API_KEY = key;
  process.env.ZERO_G_FORCE_DEMO = "false";
  if (getZeroGConfig().mode !== "live") throw new Error("The approval evaluation requires the private 0G reviewer pair.");
}
const fixtureSha256 = createHash("sha256").update(fixtureFile).digest("hex");
const gitOptions = { cwd: new URL("../", import.meta.url), encoding: "utf8" };
const revision = execFileSync("git", ["rev-parse", "HEAD"], gitOptions).trim();
const workingTreeModified = Boolean(execFileSync("git", ["status", "--porcelain"], gitOptions).trim());
const legacyRevision = "22152a0a1d8f1bb7267a9f8958e8c427c184d277";

async function loadHistoricalBaseline() {
  const archive = JSON.parse(await readFile(archivePath, "utf8"));
  if (archive.fixtureSha256 !== fixtureSha256 || !Array.isArray(archive.groups) || archive.groups.length !== fixture.groups.length) {
    throw new Error("The archived GoPlus report does not correspond to the fixture.");
  }
  const archivedCases = new Map();
  for (const group of fixture.groups) {
    const source = archive.groups.find(({ id, expected }) => id === group.id && expected === group.expected);
    if (!source || source.cases.length !== group.cases.length) throw new Error(`The archive does not cover ${group.id}.`);
    const indexed = new Map(source.cases.map((item) => [item.hash, item]));
    for (const { hash, block, amount } of group.cases) {
      const item = indexed.get(hash);
      if (item?.block !== block || item.amount !== amount || !["CLEAR", "FLAG", "INCONCLUSIVE"].includes(item.goPlus?.decision)
        || archivedCases.has(hash)) throw new Error(`Invalid archived evidence for ${hash}.`);
      archivedCases.set(hash, item.goPlus);
    }
  }
  const historicalModule = (path) => {
    const source = execFileSync("git", ["show", `${legacyRevision}:${path}`], gitOptions);
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  };
  const [{ policy: historicalPolicy }, { evaluatePolicy: historicalJudge, isTransactionProposal }] = await Promise.all([
    historicalModule("server/demoData.js"), historicalModule("server/policyEngine.js"),
  ]);
  const aligned = { ...historicalPolicy, allowedTargets: [fixture.token], maxApprovalUsd: 1_000 };
  function judge(proposal, amount, policyToUse) {
    const legacyProposal = { chainId: proposal.chainId, from: proposal.from, target: proposal.to, calldata: proposal.data,
      method: "approve(address,uint256)", assetIn: "USDC", assetOut: "USDC", valueUsd: 0, slippageBps: 0,
      approvalUsd: Number(formatUnits(amount, 6)) };
    if (!isTransactionProposal(legacyProposal)) throw new Error("The receipt-derived proposal does not match the historic schema.");
    const result = historicalJudge(legacyProposal, policyToUse);
    return { decision: result.passed ? "ALLOW" : "BLOCK", blockers: result.blockers };
  }
  return { revision: legacyRevision, goPlusMeasuredAt: archive.measuredAt, archivedCases,
    judge(proposal, amount) {
      return { defaultPolicy: judge(proposal, amount, historicalPolicy), alignedPolicy: judge(proposal, amount, aligned) };
    } };
}
const historical = archivePath ? await loadHistoricalBaseline() : null;
const token = new Interface([
  "function approve(address spender,uint256 amount)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
const approvalTopic = token.getEvent("Approval").topicHash;
const sameAddress = (left, right) => typeof left === "string" && left.toLowerCase() === right.toLowerCase();
const provider = rpcProvider("https://base-rpc.publicnode.com");
const goPlusUrl = "https://api.gopluslabs.io/api/v1/transaction_simulation";
const benchmarkPolicy = { ...policy, owner: null, maxApprovalUsd: 1_000,
  mandate: "Allow direct USDC approvals of at most 1,000 USDC to the registered Permit2 spender. Block unlimited allowances and other effects.",
  allowedSpenders: [fixture.spender.toLowerCase()] };

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
let journal;
let reserved = 0;
async function record(entry) {
  await journal.write(`${JSON.stringify(entry)}\n`);
  await journal.sync();
}

try {
  if ((await provider.getNetwork()).chainId !== BigInt(fixture.chainId)) throw new Error("Benchmark RPC is on the wrong network.");
  const owners = new Set();
  const controls = [];
  for (const { cases: samples, expected, ...group } of fixture.groups) {
    const verified = [];
    for (const item of samples) {
      const proposal = await verifiedProposal(item, expected);
      const sender = proposal.from.toLowerCase();
      if (owners.has(sender)) throw new Error(`Duplicate sender for ${item.hash}.`);
      owners.add(sender);
      verified.push({ item, proposal, sender });
    }
    controls.push({ ...group, expected, verified });
  }
  if (live) {
    journal = await open(options.journal, "wx", 0o600);
    await record({ event: "started", at: started.toISOString(), revision, workingTreeModified, fixtureSha256,
      cap, plannedRequests, models: getZeroGConfig().models });
  }
  const groups = [];
  for (const { id, expected, labelReason, verified } of controls) {
    const cases = [];
    for (const { item, proposal, sender } of verified) {
      if (live) {
        if (reserved + 2 > cap) throw new Error("Approval evaluation Router cap exhausted.");
        reserved += 2;
        await record({ event: "reserved", hash: item.hash, reserved });
      }
      const casePolicy = { ...benchmarkPolicy, agentWallet: sender };
      const startedAt = performance.now();
      const verdict = evaluatePolicy(proposal, casePolicy, {
        market: { source: "USDC unit valuation for approval controls", usdMicros: { [fixture.token.toLowerCase()]: "1000000" } },
      });
      const evidence = { ...item, proofGuard: { decision: verdict.passed ? "ALLOW" : "BLOCK", blockers: verdict.blockers } };
      if (live) {
        evidence.committee = await evaluateApprovalCommittee({ transaction: proposal, policy: casePolicy, deterministic: verdict, startedAt });
        await record({ event: "reviewed", ...evidence });
      }
      if (historical) {
        evidence.goPlus = historical.archivedCases.get(item.hash);
        evidence.legacy = historical.judge(proposal, item.amount);
      } else if (!plan) evidence.goPlus = await scanWithGoPlus(proposal, item.amount);
      cases.push(evidence);
    }
    const blocked = cases.filter(({ proofGuard }) => proofGuard.decision === "BLOCK").length;
    const legacy = historical ? Object.fromEntries(["defaultPolicy", "alignedPolicy"].map((key) => {
      const count = cases.filter((item) => item.legacy[key].decision === "BLOCK").length;
      return [key, { blocked: count, [expected === "BLOCK" ? "recall" : "falsePositiveRate"]: count / cases.length }];
    })) : null;
    const conclusive = cases.filter(({ goPlus }) => goPlus && goPlus.decision !== "INCONCLUSIVE").length;
    const flagged = cases.filter(({ goPlus }) => goPlus?.decision === "FLAG").length;
    groups.push({ id, expected, labelReason, sampleSize: cases.length,
      proofGuard: { blocked, [expected === "BLOCK" ? "recall" : "falsePositiveRate"]: blocked / cases.length },
      ...(!plan && { goPlus: { simulatedWithMatchingAllowance: conclusive, flagged, inconclusive: cases.length - conclusive,
        flagRateAmongConclusive: conclusive ? flagged / conclusive : null } }),
      ...(legacy && { legacy }),
      ...(live && { committee: summarizeApprovalCommittee(cases, expected) }),
      cases });
  }
  if (journal) await record({ event: "finished", reserved });
  console.log(JSON.stringify({
    scope: "Base mainnet bounded and unlimited USDC approval controls. GoPlus public risk flags use current state. No transaction signing or broadcasts.",
    mode, plannedRequests, routerRequestsReserved: reserved, models: getZeroGConfig().models,
    revision, workingTreeModified,
    ...(historical && { legacyRevision: historical.revision, goPlusMeasuredAt: historical.goPlusMeasuredAt,
      legacyInput: "Real receipt-derived facts projected into the historic self-reported schema. The aligned policy adds the USDC target and applies the same 1,000 USDC ceiling. No new GoPlus call.",
      unavailable: { blockaid: "No authorized API credential or scan results for this dataset.", liveCommittee: "No authorized calls for this dataset." } }),
    fixtureSha256,
    measuredAt: started.toISOString(), elapsedMs: Date.now() - started.getTime(),
    sampleSize: owners.size, groups,
  }, null, 2));
} finally {
  if (journal) await journal.close();
  provider.destroy();
}
