import { describe, expect, it } from "vitest";
import { policy, scenarios } from "./demoData.js";
import { evaluatePolicy, issuePermit, stableHash } from "./policyEngine.js";

const tx = (id) => scenarios.find((scenario) => scenario.id === id).transaction;

describe("ProofGuard policy engine", () => {
  it("allows a bounded swap through an approved router", () => {
    const result = evaluatePolicy(tx("safe-swap"), policy);
    expect(result.passed).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("detects prompt injection and an unknown target", () => {
    const result = evaluatePolicy(tx("prompt-injection"), policy);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("injection");
    expect(result.blockers).toContain("target");
    expect(result.blockers).toContain("assets");
  });

  it("blocks unlimited approvals and excessive slippage", () => {
    expect(evaluatePolicy(tx("unlimited-approval"), policy).blockers).toContain("approval");
    expect(evaluatePolicy(tx("slippage-spike"), policy).blockers).toContain("slippage");
  });

  it("issues an enforceable permit only when both gates allow", () => {
    const transaction = tx("safe-swap");
    const deterministic = evaluatePolicy(transaction, policy);
    const allow = issuePermit({
      transaction,
      policy,
      deterministic,
      inference: { decision: "ALLOW", model: "0GM-1.0-35B-A3B", trustMode: "private", rawDecision: "allow" },
    });
    const block = issuePermit({
      transaction,
      policy,
      deterministic,
      inference: { decision: "BLOCK", model: "0GM-1.0-35B-A3B", trustMode: "private", rawDecision: "block" },
    });
    expect(allow.enforceable).toBe(true);
    expect(block.enforceable).toBe(false);
    expect(allow.permitHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("hashes object keys deterministically", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });
});

