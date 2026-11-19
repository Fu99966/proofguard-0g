import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { demoMarket, policy } from "../server/demoData.js";
import { evaluatePolicy } from "../server/policyEngine.js";
import { getZeroGConfig } from "../server/zeroGAdapter.js";
import { cases } from "./cases.js";

const started = new Date();
const casesWithResults = cases.map(({ id, source, reason, expected, expectedDecode, transaction }) => {
  const before = performance.now();
  const verdict = evaluatePolicy(transaction, policy, { market: demoMarket });
  return { id, source, reason, expected, actual: verdict.passed ? "ALLOW" : "BLOCK", blockers: verdict.blockers,
    expectedDecode, actualDecode: verdict.facts ? "DECODE" : "REJECT",
    latencyMs: performance.now() - before };
});
const blocked = casesWithResults.filter(({ expected }) => expected === "BLOCK");
const allowed = casesWithResults.filter(({ expected }) => expected === "ALLOW");
const correctBlocks = blocked.filter(({ actual }) => actual === "BLOCK").length;
const falseBlocks = allowed.filter(({ actual }) => actual === "BLOCK").length;
const supported = casesWithResults.filter(({ expectedDecode }) => expectedDecode === "DECODE");
const unsupported = casesWithResults.filter(({ expectedDecode }) => expectedDecode === "REJECT");
const decoder = { acceptedSupported: supported.filter(({ actualDecode }) => actualDecode === "DECODE").length,
  supported: supported.length, rejectedUnsupported: unsupported.filter(({ actualDecode }) => actualDecode === "REJECT").length,
  unsupported: unsupported.length };
const latency = casesWithResults.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
const percentile = (p) => latency[Math.ceil(latency.length * p) - 1];
const blockers = {};
for (const entry of blocked) for (const name of entry.blockers) blockers[name] = (blockers[name] || 0) + 1;
const report = {
  category: "offline synthetic deterministic-policy evaluation", revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTreeModified: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  startedAt: started.toISOString(), elapsedMs: Date.now() - started.getTime(), configuredModels: getZeroGConfig().models,
  modelsInvoked: false, sampleSize: casesWithResults.length, expectedBlock: blocked.length, expectedAllow: allowed.length,
  correctBlocks, falseBlocks, recall: correctBlocks / blocked.length, falsePositiveRate: falseBlocks / allowed.length,
  decoder, blockers, latencyMs: { p50: percentile(0.5), p95: percentile(0.95) }, cases: casesWithResults,
};
const summary = `# ProofGuard evaluation\n\n${report.category}. ${report.sampleSize} labeled examples.\n\n- Recall: ${correctBlocks}/${blocked.length} (${(report.recall * 100).toFixed(1)}%).\n- False positives: ${falseBlocks}/${allowed.length} (${(report.falsePositiveRate * 100).toFixed(1)}%).\n- Decoder accepted ${decoder.acceptedSupported}/${decoder.supported} supported cases and rejected ${decoder.rejectedUnsupported}/${decoder.unsupported} unsupported cases.\n- Deterministic review latency: P50 ${report.latencyMs.p50.toFixed(2)} ms, P95 ${report.latencyMs.p95.toFixed(2)} ms.\n- Revision: ${report.revision}${report.workingTreeModified ? " with uncommitted changes" : ""}.\n- Run date: ${report.startedAt}.\n\nSee report.json for per-case labels, configuration and blockers. Models and third-party baselines were not invoked. The synthetic evaluation does not estimate real-world performance.\n`;
writeFileSync(new URL("./report.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(new URL("./report.md", import.meta.url), summary);
console.log(summary);
