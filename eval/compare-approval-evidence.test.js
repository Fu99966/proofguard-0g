import { expect, it } from "vitest";
import { compareApprovalEvidence } from "./compare-approval-evidence.js";

const digest = "fixture-checksum";
const bounded = { hash: "bounded", block: 200, amount: "1000000000" };
const unlimited = { hash: "unlimited", block: 300, amount: "unlimited-uint256" };
const groups = [{ id: "bounded", expected: "ALLOW", cases: [bounded] },
  { id: "unlimited", expected: "BLOCK", cases: [unlimited] }];
const fixture = { groups };

function archive(mode, evidence) {
  return { mode, fixtureSha256: digest, groups: groups.map(({ id, expected, cases }) => ({
    id, expected, cases: cases.map((item) => ({ ...item, proofGuard: { decision: expected }, ...evidence(item, expected) })),
  })) };
}

const historical = archive("historical-comparison", (_item, expected) => ({
  legacy: { defaultPolicy: { decision: "BLOCK" }, alignedPolicy: { decision: expected } }, goPlus: { decision: "CLEAR" },
}));
const base = { fixture, digest, historical };
const reviewers = (id) => [{ role: "primary", model: "first", decision: "ALLOW", requestId: id, verification: "router-verified" },
  { role: "critic", model: "second", decision: "ALLOW", requestId: `${id}-2`, verification: "router-verified" }];

it("joins matched evidence without turning pending scans or missing attestations into cleared samples", () => {
  const blockaid = archive("blockaid-comparison", (item) => ({ blockaid: item.hash === "bounded"
    ? { decision: "NOT_RUN" }
    : { decision: "FLAG", vendorRisk: "Warning", requestId: "scan-1", scanBlock: String(item.block - 1) } }));
  const committee = archive("live-committee", (item) => ({ committee: item.hash === "bounded"
    ? { status: "verified", decision: "ALLOW", permitIssued: true, reviewers: reviewers(item.hash) }
    : { status: "inconclusive" } }));
  const result = compareApprovalEvidence({ ...base, blockaid, committee });
  expect(result.groups[0].summaries).toMatchObject({ blockaid: { denominator: 0, notRun: 1, rate: null },
    committee: { denominator: 1, clear: 1, rate: 0 } });
  expect(result.groups[1].summaries).toMatchObject({ blockaid: { denominator: 1, flagged: 1, rate: 1 },
    committee: { denominator: 0, inconclusive: 1, rate: null } });
});

it("rejects a different cohort or a changed approval amount or rule", () => {
  const blockaid = archive("blockaid-comparison", () => ({ blockaid: { decision: "NOT_RUN" } }));
  expect(() => compareApprovalEvidence({ ...base, blockaid: { ...blockaid, fixtureSha256: "different" } })).toThrow("cohort");
  blockaid.groups[0].cases[0].amount = "5";
  expect(() => compareApprovalEvidence({ ...base, blockaid })).toThrow("disagrees with the fixture");
  blockaid.groups[0].cases[0].amount = bounded.amount;
  blockaid.groups[0].cases[0].proofGuard.decision = "BLOCK";
  expect(() => compareApprovalEvidence({ ...base, blockaid })).toThrow("policy result differs");
});

it("rejects reused receipt IDs across two different committee cases", () => {
  const committee = archive("live-committee", (_item, expected) => ({
    committee: { status: "verified", decision: "ALLOW", permitIssued: expected === "ALLOW", reviewers: reviewers("same-id") },
  }));
  expect(() => compareApprovalEvidence({ ...base, committee })).toThrow("Duplicate vendor request ID");
});
