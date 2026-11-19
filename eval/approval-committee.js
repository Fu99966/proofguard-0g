import { hasVerifiedReviewers } from "../examples/rebalancer/rejection.js";
import { issuePermit } from "../server/policyEngine.js";
import { reviewWithZeroG } from "../server/zeroGAdapter.js";

export async function evaluateApprovalCommittee({ transaction, policy, deterministic, startedAt }) {
  try {
    const result = await reviewWithZeroG({ transaction, policy, deterministic });
    const reviewers = result.committee.map(({ role, model, decision, receipt, charge, usage }) => {
      const count = usage?.total_tokens ?? usage?.totalTokens;
      return { role, model, decision, requestId: receipt.requestId, verification: receipt.verification, charge,
        tokenCount: Number.isSafeInteger(count) && count >= 0 ? count : null };
    });
    const verified = result.mode === "live" && result.receipt.verified && hasVerifiedReviewers(reviewers);
    const permit = verified && issuePermit({ transaction, policy, inference: result, deterministic });
    return { status: verified ? "verified" : "inconclusive", decision: verified ? result.decision : null,
      permitIssued: Boolean(permit), elapsedMs: Math.round(performance.now() - startedAt), reviewers };
  } catch (error) {
    return { status: "inconclusive", decision: null, permitIssued: false, reason: error.message,
      elapsedMs: Math.round(performance.now() - startedAt), reviewers: [] };
  }
}

function latency(cases) {
  const ordered = cases.map(({ committee }) => committee.elapsedMs).sort((left, right) => left - right);
  if (!ordered.length) return null;
  return { sampleSize: ordered.length, p50: ordered[Math.ceil(ordered.length / 2) - 1],
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1] };
}

export function summarizeApprovalCommittee(cases, expected) {
  const verified = cases.filter(({ committee }) => committee.status === "verified");
  const permits = verified.filter(({ committee }) => committee.permitIssued);
  const reviewers = cases.flatMap(({ committee }) => committee.reviewers);
  const reportedTotals = {};
  let pricedResponses = 0;
  let responsesWithTokenCount = 0;
  let reportedTokens = 0;
  for (const { charge, tokenCount } of reviewers) {
    if (charge) {
      const unit = charge.currency === "usd" ? "usdMicro" : "zeroGWei";
      reportedTotals[unit] = (reportedTotals[unit] ?? 0n) + BigInt(charge.totalUnits);
      pricedResponses++;
    }
    if (tokenCount !== null) {
      reportedTokens += tokenCount;
      responsesWithTokenCount++;
    }
  }
  const committeeBlocks = verified.filter(({ committee }) => committee.decision === "BLOCK").length;
  const sharedMistakes = verified.filter(({ committee }) => committee.reviewers.every(({ decision }) => decision !== expected)).length;
  const rateName = expected === "BLOCK" ? "recall" : "falsePositiveRate";
  return {
    verified: verified.length, inconclusive: cases.length - verified.length,
    [rateName]: verified.length ? committeeBlocks / verified.length : null,
    sharedMistakes, sharedMistakeRate: verified.length ? sharedMistakes / verified.length : null,
    disagreements: verified.filter(({ committee }) => committee.reviewers[0].decision !== committee.reviewers[1].decision).length,
    ruleBlocks: cases.filter(({ proofGuard }) => proofGuard.decision === "BLOCK").length,
    committeeOnlyBlocks: verified.filter(({ committee, proofGuard }) => proofGuard.decision === "ALLOW" && committee.decision === "BLOCK").length,
    reviewLatencyMs: latency(verified), permitLatencyMs: latency(permits),
    reportedTokens, responsesWithTokenCount, pricedResponses,
    reportedTotals: Object.fromEntries(Object.entries(reportedTotals).map(([unit, amount]) => [unit, amount.toString()])),
  };
}
