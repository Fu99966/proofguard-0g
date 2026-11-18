import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createProofGuardClient } from "../sdk/index.js";
import { rpcProvider } from "../server/market.js";
import { verifyAgentRun } from "../examples/rebalancer/verify-run.js";

const [runId] = process.argv.slice(2);
if (!runId) throw new Error("Provide the run ID recorded by the Agent.");
const env = process.env;
const file = env.PROOFGUARD_AGENT_LOG || "var/agent.jsonl";
const entries = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.runId === runId);
const client = createProofGuardClient({ apiUrl: env.PROOFGUARD_API_URL, apiKey: env.PROOFGUARD_AGENT_API_KEY });
const result = await verifyAgentRun(entries, { provider: rpcProvider(env.PROOFGUARD_RPC_URL), readAudit: client.audit });
console.log(JSON.stringify(result, null, 2));
