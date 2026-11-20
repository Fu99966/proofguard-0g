import { describe, expect, it } from "vitest";
import { RULES_ONLY, RULES_PLUS_MODELS } from "../sdk/review.js";
import { demoMarket, policy, scenarios } from "./demoData.js";
import { evaluatePolicy, issuePermit, stableHash } from "./policyEngine.js";

const tx = (id) => scenarios.find((scenario) => scenario.id === id).transaction;

describe("ProofGuard policy engine", () => {
  it("allows a bounded swap through an approved router", () => {
    const result = evaluatePolicy(tx("safe-swap"), policy, { market: demoMarket });
    expect(result.passed).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("detects prompt injection and a foreign recipient", () => {
    const result = evaluatePolicy(tx("prompt-injection"), policy, { market: demoMarket });
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("injection");
    expect(result.blockers).toContain("recipient");
  });

  it("blocks unlimited approvals and excessive slippage", () => {
    expect(evaluatePolicy(tx("unlimited-approval"), policy, { market: demoMarket }).blockers).toContain("approval");
    expect(evaluatePolicy(tx("slippage-spike"), policy, { market: demoMarket }).blockers).toContain("slippage");
  });

  it("issues only a rules-based permit by default and requires both reviewers when enabled", () => {
    const transaction = tx("safe-swap");
    const deterministic = evaluatePolicy(transaction, policy, { market: demoMarket });
    const permitInput = { transaction, policy, deterministic };
    const allow = issuePermit(permitInput);
    expect(allow).toMatchObject({ decision: "ALLOW", enforceable: false, reviewMode: RULES_ONLY, models: [] });
    expect(allow.permitHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(issuePermit({ ...permitInput, reviewMode: RULES_PLUS_MODELS })).toBeNull();
    expect(issuePermit({ ...permitInput, reviewMode: RULES_PLUS_MODELS, inference: { decision: "ALLOW", mode: "live" } })).toBeNull();
  });

  it("hashes object keys deterministically", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });
});

