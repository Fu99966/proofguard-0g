import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hasVerifiedReviewers } from "../examples/rebalancer/rejection.js";

function indexReport(fixture, digest, report, mode) {
  if (report.mode !== mode || report.fixtureSha256 !== digest || !Array.isArray(report.groups)
    || report.groups.length !== fixture.groups.length) throw new Error(`Unexpected cohort for ${mode}.`);
  const entries = new Map();
  for (const group of fixture.groups) {
    const source = report.groups.find((entry) => entry.id === group.id && entry.expected === group.expected);
    if (source?.cases?.length !== group.cases.length) throw new Error(`Missing ${group.id} cases for ${mode}.`);
    const index = new Map(source.cases.map((sample) => [sample.hash, sample]));
    for (const { hash, amount, block } of group.cases) {
      const sample = index.get(hash);
      if (!sample || sample.amount !== amount || sample.block !== block || entries.has(hash)) {
        throw new Error(`Transaction evidence disagrees with the fixture for ${hash} in ${mode}.`);
      }
      entries.set(hash, sample);
    }
  }
  return entries;
}

const ruleVerdicts = new Set(["ALLOW", "BLOCK"]);
const signalVerdicts = new Set(["CLEAR", "FLAG", "INCONCLUSIVE"]);
const pending = "NOT_RUN";

function decisionOf(entry, allowed) {
  if (!allowed.has(entry?.decision)) throw new Error("Missing required baseline decision.");
  return entry.decision;
}

function uniqueReceipts(receipts, ids) {
  if (receipts.some((id) => ids.has(id))) throw new Error("Duplicate vendor request ID in report.");
  receipts.forEach((id) => ids.add(id));
}

function committeeDecision(sample, ids) {
  if (!sample) return pending;
  const { committee, proofGuard } = sample;
  if (committee?.status === "inconclusive") return "INCONCLUSIVE";
  if (committee?.status !== "verified" || !hasVerifiedReviewers(committee.reviewers)
    || !ruleVerdicts.has(committee.decision) || !ruleVerdicts.has(proofGuard?.decision)) {
    throw new Error("A claimed committee result is missing verified reviewer evidence.");
  }
  const decision = committee.reviewers.some((reviewer) => reviewer.decision === "BLOCK") ? "BLOCK" : "ALLOW";
  if (committee.decision !== decision || committee.permitIssued !== (decision === "ALLOW" && proofGuard.decision === "ALLOW")) {
    throw new Error("Committee decision or permit status conflicts with its evidence.");
  }
  uniqueReceipts(committee.reviewers.map(({ requestId }) => requestId), ids);
  return decision;
}

function blockaidSignal(sample, expectedBlock, ids) {
  if (!sample) return pending;
  const scan = sample.blockaid;
  if (scan?.decision === pending || scan?.decision === "INCONCLUSIVE") return scan.decision;
  const expected = { Benign: "CLEAR", Malicious: "FLAG", Warning: "FLAG" };
  if (!scan || !Object.hasOwn(expected, scan.vendorRisk) || scan.decision !== expected[scan.vendorRisk]
    || scan.scanBlock !== String(expectedBlock) || typeof scan.requestId !== "string" || !scan.requestId.trim()) {
    throw new Error("A claimed Blockaid signal lacks matching receipt metadata.");
  }
  uniqueReceipts([scan.requestId], ids);
  return scan.decision;
}

function summaryFor(cases, key) {
  const verdicts = cases.map((row) => row[key]);
  const counts = {
    flagged: verdicts.filter((value) => value === "FLAG" || value === "BLOCK").length,
    clear: verdicts.filter((value) => value === "CLEAR" || value === "ALLOW").length,
    inconclusive: verdicts.filter((value) => value === "INCONCLUSIVE").length,
    notRun: verdicts.filter((value) => value === pending).length,
  };
  const denominator = counts.flagged + counts.clear;
  return { ...counts, denominator, rate: denominator ? counts.flagged / denominator : null };
}

const names = { current: "当前规则", legacyDefault: "旧版原策略", legacyAligned: "旧版对齐策略", goPlus: "GoPlus 公共风险",
  blockaid: "Blockaid 公共风险", committee: "双模型委员会" };

export function compareApprovalEvidence({ fixture, digest, historical, blockaid, committee }) {
  const old = indexReport(fixture, digest, historical, "historical-comparison");
  const vendor = blockaid && indexReport(fixture, digest, blockaid, "blockaid-comparison");
  const models = committee && indexReport(fixture, digest, committee, "live-committee");
  const modelIds = new Set();
  const vendorIds = new Set();
  const groups = fixture.groups.map(({ id, expected, cases: pinned }) => {
    const cases = pinned.map(({ hash, block, amount }) => {
      const prior = old.get(hash);
      const model = models?.get(hash);
      const signal = vendor?.get(hash);
      const current = decisionOf(prior.proofGuard, ruleVerdicts);
      if ([model, signal].some((entry) => entry && entry.proofGuard?.decision !== current)) {
        throw new Error(`The archived policy result differs for ${hash}.`);
      }
      return { hash, block, amount, expected, current,
        legacyDefault: decisionOf(prior.legacy?.defaultPolicy, ruleVerdicts),
        legacyAligned: decisionOf(prior.legacy?.alignedPolicy, ruleVerdicts),
        goPlus: decisionOf(prior.goPlus, signalVerdicts), blockaid: blockaidSignal(signal, block - 1, vendorIds),
        committee: committeeDecision(model, modelIds),
        ...(signal && { blockaidEvidence: signal.blockaid }),
        ...(model && { committeeEvidence: model.committee }),
      };
    });
    return { id, expected, sampleSize: cases.length, summaries: Object.fromEntries(Object.keys(names).map((key) =>
      [key, summaryFor(cases, key)])), cases };
  });
  return { fixtureSha256: digest, groups, sources: { historical: historical.revision, legacy: historical.legacyRevision,
    goPlusMeasuredAt: historical.goPlusMeasuredAt, blockaid: blockaid?.revision ?? null, committee: committee?.revision ?? null },
    requestsMade: 0 };
}

function markdown(result) {
  const bounded = result.groups.find(({ expected }) => expected === "ALLOW");
  const unlimited = result.groups.find(({ expected }) => expected === "BLOCK");
  const label = ({ flagged, denominator, inconclusive, notRun }) => [
    denominator ? `${flagged}/${denominator}` : "暂无可验证样本",
    ...(inconclusive ? [`${inconclusive} 条证据不足`] : []),
    ...(notRun ? [`${notRun} 条未评测`] : []),
  ].join("，");
  const lines = Object.entries(names).map(([key, name]) =>
    `| ${name} | ${label(bounded.summaries[key])} | ${label(unlimited.summaries[key])} |`);
  return [
    "# 真实 USDC 授权 · 同批基线对照",
    "",
    "同一批 20 笔 Base 历史交易，按本项目的 Permit2 白名单和 1,000 USDC 额度标注。第三方数字为公共风险标记，同表展示其与本地标签的一致程度。",
    "",
    "| 方法 | 限额内组拦截或标记 | 无限授权组拦截或标记 |",
    "| --- | ---: | ---: |",
    ...lines,
    "",
    "回执不足和未评测的样本保留在报告中，分母只纳入可验证结果。此次汇总使用零次新 API 请求。",
    "",
    "[逐笔 JSON](./base-approval-comparison.json)",
    "",
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values: args } = parseArgs({ options: { historical: { type: "string" }, blockaid: { type: "string" },
    committee: { type: "string" }, markdown: { type: "boolean" } } });
  if (!args.historical) throw new Error("Provide the historical comparison JSON archive.");
  const load = async (path) => path && JSON.parse(await readFile(path, "utf8"));
  const [data, historical, blockaid, committee] = await Promise.all([readFile(new URL("./cases/base-usdc-approvals.json", import.meta.url)),
    load(args.historical), load(args.blockaid), load(args.committee)]);
  const result = compareApprovalEvidence({ fixture: JSON.parse(data), digest: createHash("sha256").update(data).digest("hex"),
    historical, blockaid, committee });
  console.log(args.markdown ? markdown(result) : JSON.stringify(result, null, 2));
}
