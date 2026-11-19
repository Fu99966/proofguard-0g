import { afterEach, expect, it, vi } from "vitest";
import { evaluatePolicy } from "../server/policyEngine.js";
import { reviewWithZeroG } from "../server/zeroGAdapter.js";
import { mandateControl, mandatePolicy, verifyMandateCases } from "./mandate-controls.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("checks all twenty labels and gives both paid arms three kinds of violation and both expected decisions", () => {
  const { result, plan } = verifyMandateCases();
  expect(result.filter(({ deterministic }) => !deterministic.passed)).toHaveLength(15);
  expect(result.filter(({ deterministic }) => deterministic.passed)).toHaveLength(5);
  for (const group of ["visible", "blind"]) {
    const cases = plan.filter((sample) => sample.group === group);
    expect(cases.filter(({ expected }) => expected === "BLOCK")).toHaveLength(5);
    expect(new Set(cases.map(({ kind }) => kind))).toEqual(new Set(["in-band", "wrong-direction", "overshoot", "corrective"]));
  }
});

it.each([
  [3500, 1, true, "in-band"],
  [4500, 1, false, "in-band"],
  [3000, 9, true, "closer-within-opposite-boundary"],
  [5000, 9, false, "closer-within-opposite-boundary"],
  [3000, 10, true, "crosses-opposite-boundary"],
  [5000, 10, false, "crosses-opposite-boundary"],
])("checks boundary behavior on both sides of the target (%i, %i, %s)", (before, dollars, buy, reason) => {
  const { transaction, market } = mandateControl("boundary", "control", before, dollars, buy, "");
  expect(evaluatePolicy(transaction, mandatePolicy, { market }).checks.find(({ id }) => id === "portfolio-mandate").detail).toBe(reason);
  expect(evaluatePolicy(transaction, mandatePolicy, { market: { ...market, portfolio: undefined } }).blockers).toContain("portfolio-mandate");
});

it("shows the new result only to the visible arm while both receive the same independent projection", async () => {
  const { plan } = verifyMandateCases();
  const { transaction, deterministic } = plan[0];
  vi.stubEnv("ZERO_G_API_KEY", "offline-only");
  vi.stubEnv("ZERO_G_FORCE_DEMO", "false");
  vi.stubEnv("ZERO_G_MODEL", "glm-5.3-flash");
  vi.stubEnv("ZERO_G_CRITIC_MODEL", "0gm-1.0-35b-a3b-sia");
  const prompts = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, request) => {
    const { model, messages } = JSON.parse(request.body);
    prompts.push(messages[1].content);
    return Response.json({ model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      decision: "BLOCK", riskScore: 80, summary: "Fixture", threats: [], confidence: 1,
    }) } }], x_0g_trace: { request_id: model, tee_verified: true } });
  }));
  const args = { transaction, deterministic, policy: mandatePolicy };
  await reviewWithZeroG(args);
  await reviewWithZeroG({ ...args, revealPortfolioRule: true });
  expect(prompts).toHaveLength(4);
  expect(prompts.every((prompt) => prompt.includes('"projectedExposureBps":3983'))).toBe(true);
  expect(prompts.slice(0, 2).every((prompt) => !prompt.includes("DETERMINISTIC PORTFOLIO RULE RESULT") && !prompt.includes('"reason":"in-band"'))).toBe(true);
  expect(prompts.slice(2).every((prompt) => prompt.includes('{"decision":"BLOCK","reason":"in-band"}') && !prompt.includes('"checks"'))).toBe(true);
});
