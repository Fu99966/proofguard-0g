import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineCommitteeVerdicts, extractJson, getZeroGConfig, reviewWithZeroG } from "./zeroGAdapter.js";

describe("0G adapter", () => {
  beforeEach(() => {
    for (const name of ["API_KEY", "FORCE_DEMO", "BASE_URL", "MODEL", "CRITIC_MODEL", "TRUST_MODE", "ENABLE_COMMITTEE"]) {
      vi.stubEnv(`ZERO_G_${name}`, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("runs in explicitly labelled demo mode without a key", () => {
    expect(getZeroGConfig().mode).toBe("demo");
  });

  it("extracts JSON from model thinking and markdown fences", () => {
    const result = extractJson('<think>private reasoning</think>```json\n{"decision":"ALLOW","riskScore":8}\n```');
    expect(result).toEqual({ decision: "ALLOW", riskScore: 8 });
  });

  it("fails closed when a model response has no JSON", () => {
    expect(() => extractJson("Looks safe to me")).toThrow();
  });

  it("configures the sponsor-native two-model committee by default", () => {
    const config = getZeroGConfig();
    expect(config.models).toContain("0gm-1.0-35b-a3b");
    expect(config.models).toContain("0gm-1.0-35b-a3b-sia");
  });

  it("fails closed when either committee reviewer blocks", () => {
    const receipt = { verified: true, responseId: "response-1" };
    const combined = combineCommitteeVerdicts([
      { role: "primary", model: "0GM", decision: "ALLOW", riskScore: 8, confidence: 0.93, threats: [], summary: "safe", rawDecision: "allow", latencyMs: 100, receipt },
      { role: "critic", model: "0GM-SIA", decision: "BLOCK", riskScore: 81, confidence: 0.88, threats: ["ambiguous calldata"], summary: "blocked", rawDecision: "block", latencyMs: 120, receipt },
    ], "live");

    expect(combined.decision).toBe("BLOCK");
    expect(combined.riskScore).toBe(81);
    expect(combined.models).toEqual(["0GM", "0GM-SIA"]);
    expect(combined.receipt.verified).toBe(true);
  });

  it("does not call the Router in force-demo mode even when a key is configured", async () => {
    vi.stubEnv("ZERO_G_API_KEY", "synthetic-key");
    vi.stubEnv("ZERO_G_FORCE_DEMO", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reviewWithZeroG({ deterministic: { passed: true, checks: [] } });
    expect(result).toMatchObject({ decision: "ALLOW", mode: "demo", receipt: { verification: "simulation", verified: false } });
    expect(result.committee).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

