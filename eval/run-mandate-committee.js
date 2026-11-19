import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasVerifiedReviewers } from "../examples/rebalancer/rejection.js";
import { liveRequestLimit, openLiveBudget, verifiedLiveBounds } from "../server/liveAcceptanceBudget.js";
import { stableHash } from "../server/policyEngine.js";
import { getZeroGConfig, reviewWithZeroG } from "../server/zeroGAdapter.js";
import { mandatePolicy, verifyMandateCases } from "./mandate-controls.js";

const usdLimit = 400_000;
const { result, plan } = verifyMandateCases();
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Use node eval/mandate-controls.js for offline proof or --live for the authorized committee measurement.");
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit the verified suite before running paid evaluation.");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
process.env.ZERO_G_FORCE_DEMO = "false";
if (process.env.PROOFGUARD_APPROVAL_EVAL_API_KEY) process.env.ZERO_G_API_KEY = process.env.PROOFGUARD_APPROVAL_EVAL_API_KEY;
const config = getZeroGConfig();
if (config.mode !== "live") throw new Error("A configured private two-model committee is required.");
const bounds = await verifiedLiveBounds(config.models);
const runId = randomUUID();
const directory = "var/evaluation/mandate-committee-20261119";
await mkdir(directory, { mode: 0o700 });
const journal = join(directory, "journal.jsonl");
const database = join(directory, "budget.sqlite");
const budget = openLiveBudget(database);
const rows = [];

const record = async (entry) => {
  const event = JSON.stringify({ runId, commit, at: new Date().toISOString(), ...entry });
  await appendFile(journal, event + "\n", { mode: 0o600 });
  console.log(event);
};
const money = (usdMicros) => `$${(usdMicros / 1_000_000).toFixed(6)}`;
const safeText = (text) => String(text ?? "").slice(0, 350);

function statisticalSummary(cases) {
  const verified = cases.filter(({ status }) => status === "verified");
  const rate = (subset, correct) => ({ numerator: subset.filter(correct).length, denominator: subset.length });
  const malicious = verified.filter(({ expected }) => expected === "BLOCK");
  const benign = verified.filter(({ expected }) => expected === "ALLOW");
  const reviewers = Object.fromEntries(["primary", "critic", "committee"].map((key) => {
    const decision = (row) => key === "committee" ? row.committee : row.reviewers.find(({ role }) => role === key)?.decision;
    return [key, { interception: rate(malicious, (row) => decision(row) === "BLOCK"),
      falseBlock: rate(benign, (row) => decision(row) === "BLOCK") }];
  }));
  const sharedError = (row) => row.reviewers.every(({ decision }) => decision !== row.expected);
  return { selected: cases.length, verified: verified.length, reviewers, sharedError: rate(verified, sharedError),
    jointMiss: rate(malicious, sharedError), jointFalseBlock: rate(benign, sharedError),
    disagreements: verified.filter(({ reviewers: [first, second] }) => first.decision !== second.decision).length,
    additionalCorrectBlocks: malicious.filter((row) => row.rule === "ALLOW" && row.committee === "BLOCK").length,
    additionalFalseBlocks: benign.filter((row) => row.rule === "ALLOW" && row.committee === "BLOCK").length };
}

const markdownEscape = (value) => String(value ?? "—").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const formatRate = ({ numerator, denominator }) => denominator ? `${numerator}/${denominator}（${(100 * numerator / denominator).toFixed(1)}%）` : "无有效样本";
function renderArm(title, cases, summary) {
  const metrics = Object.entries(summary.reviewers).map(([role, { interception, falseBlock }]) =>
    `| ${{ primary: "主审 Flash", critic: "红队 SIA", committee: "双模型委员会" }[role]} | ${formatRate(interception)} | ${formatRate(falseBlock)} |`).join("\n");
  const entries = cases.map((row) => {
    const values = [row.id, row.expected, row.rule, row.beforeBps, row.projectedExposureBps,
      row.reviewers.find(({ role }) => role === "primary")?.decision, row.reviewers.find(({ role }) => role === "critic")?.decision,
      row.committee, { verified: "有验证回执", inconclusive: "证据不足", "not-run": "未运行" }[row.status]];
    return `| ${values.map(markdownEscape).join(" | ")} |`;
  }).join("\n");
  return `## ${title}

已验证 ${summary.verified}/${summary.selected} 条，出现 ${summary.disagreements} 次模型分歧。同错率 ${formatRate(summary.sharedError)}，其中共同漏拦 ${formatRate(summary.jointMiss)}，共同误杀 ${formatRate(summary.jointFalseBlock)}。相对规则新增正确拦截 ${summary.additionalCorrectBlocks} 条，新增误杀 ${summary.additionalFalseBlocks} 条。

| 审查方 | 违规拦截率 | 对照误杀率 |
| --- | ---: | ---: |
${metrics}

| 样本 | 预期 | 确定性 | 原敞口 bps | 投影 bps | 主审 | 红队 | 委员会 | 证据 |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
${entries}`;
}

let stopped = null;
let opened = false;
try {
  budget.start(runId, commit);
  opened = true;
  await record({ event: "started", usdLimit, liveRequestLimit, reservePerPairMicros: bounds.reduce((sum, item) => sum + item.usdMicros, 0),
    offline: { violationsBlocked: result.filter(({ expected }) => expected === "BLOCK").length,
      controlsAllowed: result.filter(({ expected }) => expected === "ALLOW").length },
    plan: plan.map(({ id, group, expected }) => ({ id, group, expected })) });

  for (const sample of plan) {
    const { id, group, expected, beforeBps, projectedExposureBps, transaction, market, deterministic } = sample;
    const proposal = stableHash({ id, group, transaction, market });
    const row = { id, group, expected, beforeBps, projectedExposureBps, rule: deterministic.passed ? "ALLOW" : "BLOCK",
      blockers: deterministic.blockers, proposal, status: "not-run", committee: null, reviewers: [] };
    rows.push(row);
    try {
      budget.reserve(proposal, bounds, usdLimit);
    } catch (error) {
      stopped = error.message;
      if (error.code !== "ROUTER_BUDGET_EXHAUSTED") budget.stop(stopped);
      row.reason = stopped;
      await record({ event: "case", ...row });
      break;
    }
    await record({ event: "reserved", id, group, proposal, requests: budget.state().requests });
    let inference;
    let completed;
    try {
      inference = await reviewWithZeroG({ transaction, policy: mandatePolicy, deterministic, revealPortfolioRule: group === "visible",
        reservation: { bounds, settle: (model, charge) => budget.settle(proposal, model, charge) } });
      completed = inference.committee;
    } catch (error) {
      row.reason = safeText(error.message);
      completed = error.completedReviewers ?? [];
    }
    row.reviewers = completed.map(({ role, model, decision, summary, threats, receipt, charge }) => ({
      role, model, decision, summary: safeText(summary), threats: threats.map(safeText),
      requestId: receipt.requestId, verification: receipt.verification, charge,
    }));
    const paid = budget.rows().filter((entry) => entry.proposal === proposal);
    const matchesCharges = row.reviewers.every((review) => paid.some((entry) => entry.model === review.model
      && entry.request_id === review.requestId && entry.billed_usd_micros === Number(review.charge?.usdMicros)));
    const state = budget.state();
    if (inference?.mode === "live" && hasVerifiedReviewers(row.reviewers) && matchesCharges && !state.unsettled) {
      row.status = "verified";
      row.committee = inference.decision;
    } else {
      row.status = "inconclusive";
      row.reason ||= "Live evidence did not establish two verified verdicts with reconciled amounts.";
    }
    if (state.unsettled || !matchesCharges || state.committedUsdMicros > usdLimit || state.requests > liveRequestLimit) {
      stopped = row.reason || "Router charges did not reconcile with the reserved budget.";
      budget.stop(stopped);
    }
    await record({ event: "case", ...row });
    if (stopped) break;
  }
} finally {
  try {
    if (opened) {
      for (const { id, group, expected, beforeBps, projectedExposureBps, deterministic } of plan.slice(rows.length)) {
        rows.push({ id, group, expected, beforeBps, projectedExposureBps, rule: deterministic.passed ? "ALLOW" : "BLOCK",
          committee: null, reviewers: [], status: "not-run", reason: stopped || "Run ended before dispatch." });
      }
      const arms = ["visible", "blind"].map((group) => rows.filter((row) => row.group === group));
      const summaries = arms.map(statisticalSummary);
      const state = budget.state();
      const complete = rows.every(({ status }) => status === "verified");
      await record({ event: "finished", complete, stopped, state });
      const report = { runId, commit, limits: { requests: liveRequestLimit, usdMicros: usdLimit }, complete, stopped,
        spend: state, groups: { visible: summaries[0], blind: summaries[1] }, cases: rows, bills: budget.rows() };
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      const caveat = "两组使用不同、预先分配的样本，每条样本只审查一次。本轮是内部合成样本评测，两组差异不能单独归因于是否展示规则结果。";
      const verdict = complete ? "完成" : "部分完成";
      await writeFile(join(directory, "report.md"), `# ProofGuard mandate 语义评测（内部）

状态 **${verdict}**。提交 \`${commit}\`。已预留 ${state.requests}/${liveRequestLimit} 次请求，Router 已确认收费 **${money(state.billedUsdMicros)}**。未结算 ${state.unsettled} 次，含未结算预留的总额为 ${money(state.committedUsdMicros)}。全程无签名或链上交易。

离线规则挡住了 15 条违规样本，并放行 5 条纠偏对照。本集合没有“新规则放行且应拦截”的样本，无法据此估计模型对其他威胁的增量拦截率。${caveat}

${renderArm("可见规则组", arms[0], summaries[0])}

${renderArm("盲审组", arms[1], summaries[1])}

[逐模型判决、请求 ID 与收费](./report.json) · [事件账本](./journal.jsonl)
`, { mode: 0o600 });
      if (!complete) process.exitCode = 1;
    }
  } finally {
    budget.close();
  }
}
