import { describe, expect, it } from "vitest";
import { combineCommitteeVerdicts, extractJson, getZeroGConfig, getZeroGMode } from "./zeroGAdapter.js";

describe("0G adapter", () => {
  it("runs in explicitly labelled demo mode without a key", () => {
    expect(getZeroGMode()).toBe(process.env.ZERO_G_API_KEY ? "live" : "demo");
  });

  it("extracts JSON from model thinking and markdown fences", () => {
    const result = extractJson('<think>private reasoning</think>```json\n{"decision":"ALLOW","riskScore":8}\n```');
    expect(result).toEqual({ decision: "ALLOW", riskScore: 8 });
  });

  it("fails closed when a model response has no JSON", () => {
    expect(() => extractJson("Looks safe to me")).toThrow(/no JSON decision/);
  });

  it("configures the sponsor-native two-model committee by default", () => {
    const config = getZeroGConfig();
    expect(config.models).toContain("0GM-1.0-35B-A3B");
    expect(config.models).toContain("0GM-1.0-35B-A3B-SIA");
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
});

