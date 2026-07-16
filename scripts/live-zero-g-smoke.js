import "dotenv/config";
import { policy, scenarios } from "../server/demoData.js";
import { evaluatePolicy } from "../server/policyEngine.js";
import { getZeroGConfig, reviewWithZeroG } from "../server/zeroGAdapter.js";

const config = getZeroGConfig();
if (config.mode !== "live") {
  console.error("ZERO_G_API_KEY is missing. Add it to .env before running the live 0G smoke test.");
  process.exit(1);
}

const scenario = scenarios.find((item) => item.id === "safe-swap");
const deterministic = evaluatePolicy(scenario.transaction, policy);

console.log(`Calling ${config.models.join(" + ")} through 0G Private Computer...`);
const inference = await reviewWithZeroG({ transaction: scenario.transaction, policy, deterministic });

console.log(JSON.stringify({
  mode: inference.mode,
  decision: inference.decision,
  models: inference.models,
  trustMode: inference.trustMode,
  latencyMs: inference.latencyMs,
  usage: inference.usage,
  committee: inference.committee.map((reviewer) => ({
    role: reviewer.role,
    model: reviewer.model,
    decision: reviewer.decision,
    responseId: reviewer.receipt.responseId,
    attestationReturned: reviewer.receipt.verified,
    receiptLabel: reviewer.receipt.label,
  })),
  committeeReceipt: inference.receipt.label,
}, null, 2));

