import { Interface } from "ethers";
import { afterEach, expect, it, vi } from "vitest";
import { demoMarket, policy } from "../server/demoData.js";
import { evaluatePolicy } from "../server/policyEngine.js";
import { getZeroGConfig } from "../server/zeroGAdapter.js";
import { evaluateApprovalCommittee, summarizeApprovalCommittee } from "./approval-committee.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("uses complete Router receipts to measure approval decisions and charges", async () => {
  for (const key of ["BASE_URL", "MODEL", "CRITIC_MODEL", "TRUST_MODE", "ENABLE_COMMITTEE"]) vi.stubEnv(`ZERO_G_${key}`, undefined);
  vi.stubEnv("ZERO_G_API_KEY", "fixture-key");
  vi.stubEnv("ZERO_G_FORCE_DEMO", "false");
  const [, critic] = getZeroGConfig().models;
  let confirmations = true;
  const router = vi.fn(async (url, request) => {
    expect(url).toBe("https://router-api.0g.ai/v1/chat/completions");
    const { model } = JSON.parse(request.body);
    const verdict = { decision: model === critic ? "BLOCK" : "ALLOW", riskScore: 25, summary: "Fixture decision", threats: [], confidence: 1 };
    return Response.json({ model, id: `response-${model}`, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(verdict) } }],
      usage: { total_tokens: 12 }, x_0g_trace: { request_id: `request-${model}`, tee_verified: confirmations,
        billing: { currency: "usd", total_cost: model === critic ? "2" : "3" } } });
  });
  vi.stubGlobal("fetch", router);
  const token = new Interface(["function approve(address spender,uint256 amount)"]);
  const transaction = { chainId: 8453, from: policy.agentWallet, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: "0",
    data: token.encodeFunctionData("approve", [policy.allowedSpenders[0], 1_000_000n]) };
  const deterministic = evaluatePolicy(transaction, policy, { market: demoMarket });
  expect(deterministic.passed).toBe(true);
  const evaluate = () => evaluateApprovalCommittee({ transaction, policy, deterministic, startedAt: performance.now() });
  const verified = await evaluate();
  confirmations = false;
  const inconclusive = await evaluate();
  expect(router).toHaveBeenCalledTimes(4);
  expect(verified).toMatchObject({ status: "verified", decision: "BLOCK", permitIssued: false });
  expect(inconclusive).toMatchObject({ status: "inconclusive", decision: null, permitIssued: false });
  const controls = [verified, inconclusive].map((committee) => ({ committee, proofGuard: { decision: "ALLOW" } }));
  expect(summarizeApprovalCommittee(controls, "ALLOW")).toMatchObject({ verified: 1, inconclusive: 1, falsePositiveRate: 1,
    disagreements: 1, sharedMistakeRate: 0, ruleBlocks: 0, committeeOnlyBlocks: 1, permitLatencyMs: null,
    reportedTokens: 48, responsesWithTokenCount: 4, pricedResponses: 4, reportedTotals: { usdMicro: "10" } });
});
