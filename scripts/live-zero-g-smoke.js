import "dotenv/config";
import { RULES_PLUS_MODELS } from "../sdk/review.js";
import { demoMarket, policy, scenarios } from "../server/demoData.js";
import { evaluatePolicy, issuePermit, stableHash } from "../server/policyEngine.js";
import { getZeroGConfig, reviewWithZeroG } from "../server/zeroGAdapter.js";

const config = getZeroGConfig();
if (config.mode !== "live") {
  console.error("Live smoke requires a local 0G key, the official Router, private mode, and two distinct reviewer models. Disable force-demo for this run.");
  process.exit(1);
}

for (const [id, expected] of [["safe-swap", "ALLOW"], ["prompt-injection", "BLOCK"]]) {
  const { transaction } = scenarios.find(({ id: scenarioId }) => scenarioId === id);
  try {
    const deterministic = evaluatePolicy(transaction, policy, { market: demoMarket });
    const inference = await reviewWithZeroG({ transaction, policy, deterministic });
    const decision = issuePermit({ transaction, policy, inference, deterministic, reviewMode: RULES_PLUS_MODELS }) ? "ALLOW" : "BLOCK";
    const responseContent = JSON.parse(inference.rawDecision);
    const committee = inference.committee.map((reviewer) => ({
      role: reviewer.role,
      model: reviewer.model,
      decision: reviewer.decision,
      requestId: reviewer.receipt.requestId,
      responseId: reviewer.receipt.responseId,
      provider: reviewer.receipt.provider,
      chatId: reviewer.receipt.chatId,
      verification: reviewer.receipt.verification,
      responseContent: responseContent[reviewer.role],
    }));
    console.log(JSON.stringify({
      scenario: id,
      expected,
      decision,
      committee,
      responseCommitment: stableHash(inference.rawDecision),
      routerVerified: inference.receipt.verified,
      independentVerification: "not performed",
    }, null, 2));

    if (decision !== expected || !inference.receipt.verified || committee.some(({ requestId, provider, chatId }) => !requestId || !provider || !chatId)
      || committee[0].requestId === committee[1].requestId) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`${id}: ${error.message}`);
    process.exitCode = 1;
  }
}
