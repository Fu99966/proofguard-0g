import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineCommitteeVerdicts, extractJson, getZeroGConfig, reviewWithZeroG } from "./zeroGAdapter.js";
import { evaluatePolicy, issuePermit, stableHash } from "./policyEngine.js";
import { testnetPolicy } from "./demoData.js";

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

  it("accepts only the final JSON after the SIA reasoning delimiter", () => {
    const answer = '{"decision":"BLOCK","riskScore":90}';
    const sia = { allowBareThinkEnd: true };
    const intermediate = '{"decision":"ALLOW","riskScore":1}';
    expect(extractJson(`Thinking about ${intermediate}. </think>\n${answer}`, sia)).toEqual({
      decision: "BLOCK", riskScore: 90,
    });
    expect(() => extractJson(`Unmarked lead-in. ${answer}`, sia)).toThrow();
    expect(() => extractJson(`Reasoning. </think> ${answer} ${answer}`, sia)).toThrow();
    expect(() => extractJson(`Reasoning. </think> ${answer}`)).toThrow();
  });

  it("fails closed when a model response has no JSON", () => {
    expect(() => extractJson("Looks safe to me")).toThrow();
  });

  it("configures the verified pair by default in both demo and live modes", () => {
    const expected = ["glm-5.3-flash", "0gm-1.0-35b-a3b-sia"];
    expect(getZeroGConfig()).toMatchObject({ mode: "demo", models: expected });
    vi.stubEnv("ZERO_G_API_KEY", "synthetic-key");
    expect(getZeroGConfig()).toMatchObject({ mode: "live", models: expected, trustMode: "private" });
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

  it.each(["BLOCK", "ALLOW"])("replays the original testnet swap with an offline critic fixture of %s", async (decision) => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/base-sepolia-swap-veto.json", import.meta.url)));
    const { transaction, recordedAt, market } = source;
    const policy = testnetPolicy(source.owner, transaction.from);
    expect(stableHash(transaction)).toBe(source.transactionHash);
    expect(stableHash(policy)).toBe(source.policyHash);
    const deterministic = evaluatePolicy(transaction, policy, { market, now: recordedAt });
    expect(deterministic).toMatchObject({ passed: true, score: 100, blockers: [], facts: { valuation: {
      block: 60687118, worstSlippageBps: 26, priceDeviationBps: 280, valueUsdMicros: "2843095",
    } } });
    vi.stubEnv("ZERO_G_API_KEY", "offline-fixture-only");
    const [, critic] = getZeroGConfig().models;
    const router = vi.fn(async (_url, request) => {
      const { model, messages } = JSON.parse(request.body);
      const prompt = messages[1].content;
      const facts = JSON.parse(prompt.split("\nDECODED EFFECTS:\n")[1].split("\n\nUNTRUSTED MEMO:")[0]);
      expect(facts.effects).toMatchObject([{ maxIn: "2843095", minOut: "1550800118086990",
        tokenAmounts: { maximumInput: { quantity: "2.843095", symbol: "USDC" },
          minimumOutput: { quantity: "0.00155080011808699", symbol: "WETH" } },
        quoteEvidence: { input: { quantity: "2.843095", symbol: "USDC" },
          output: { quantity: "0.001554686835174928", symbol: "WETH" },
          usd: { maximumInput: "2.843095", minimumOutput: "2.75664", quotedOutput: "2.763549" } },
      }]);
      expect(prompt).toContain("A minimum output is an execution bound, not the quoted output.");
      expect(facts).not.toHaveProperty("checks");
      const veto = model === critic && decision === "BLOCK";
      const verdict = { decision: veto ? "BLOCK" : "ALLOW", riskScore: 25,
        summary: veto ? "Transaction blocked due to physically impossible swap output amount contradicting portfolio valuation." : "Offline approval fixture.",
        threats: veto ? ["Impossible minOut value indicates manipulation or corruption", "Swap parameters inconsistent with portfolio USD magnitude",
          "Policy limits otherwise met but execution unsafe"] : [], confidence: 1 };
      return Response.json({ model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(verdict) } }],
        x_0g_trace: { request_id: `fixture-${model}`, tee_verified: true } });
    });
    vi.stubGlobal("fetch", router);
    const inference = await reviewWithZeroG({ transaction, policy, deterministic });
    expect(router).toHaveBeenCalledTimes(2);
    expect(inference.decision).toBe(decision);
    expect(Boolean(issuePermit({ transaction, policy, deterministic, inference, now: recordedAt }))).toBe(decision === "ALLOW");
  });
});

