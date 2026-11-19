import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Contract, Interface, JsonRpcProvider, Wallet, toQuantity } from "ethers";
import { createApp } from "../server/index.js";
import { createProofGuardClient } from "../sdk/index.js";
import { baseSepolia } from "../sdk/network.js";
import { guardedSafeSigner } from "../sdk/guard.js";
import { setupSafe } from "../sdk/safeSetup.js";
import { permitTypedData } from "../sdk/permit.js";

const localRpc = new URL(process.env.PROOFGUARD_FORK_RPC || "http://127.0.0.1:18545");
if (localRpc.hostname !== "127.0.0.1") throw new Error("Use an isolated loopback Anvil fork.");
const provider = new JsonRpcProvider(localRpc.href);
if ((await provider.getNetwork()).chainId !== 84532n) throw new Error("Expected a Base Sepolia fork.");
await provider.send("anvil_nodeInfo", []);
const owner = await provider.getSigner(0);
const agent = await provider.getSigner(1);
const recipient = await provider.getSigner(2);
const issuer = Wallet.createRandom();
const ownerAddress = await owner.getAddress();
const artifact = JSON.parse(readFileSync(new URL("../contracts/out/ProofGuardSafe.sol/ProofGuardSafe.json", import.meta.url), "utf8"));
const { safe, guardAddress, guard, account, ownerArgs } = await setupSafe({ owner, agent: await agent.getAddress(),
  issuer: issuer.address, artifact, saltNonce: Date.now() });
const safeRecipient = await recipient.getAddress();
async function expectsRevert(attempt, type) {
  try {
    await attempt();
  } catch (error) {
    if (error.data?.slice(0, 10) !== guard.interface.getError(type).selector) throw error;
    return;
  }
  throw new Error(`Expected ${type}`);
}
await expectsRevert(() => account.execTransaction.staticCall(...ownerArgs(safeRecipient, "0x")), "MissingPermit");
const tx = { chainId: 84532, from: safe, to: safeRecipient, value: "1", data: "0x" };
const permit = { expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "bb".repeat(12), permitHash: `0x${"ab".repeat(32)}` };
const typed = permitTypedData(permit, tx, guardAddress);
const signature = await issuer.signTypedData(typed.domain, typed.types, typed.message);
const asAgent = await guardedSafeSigner(guardAddress, agent, safe);
await provider.send("anvil_setBalance", [safe, "0x100000"]);
const call = await asAgent.executeGuarded.populateTransaction(tx.to, tx.value, tx.data, typed.message, signature);
const simulation = await provider.send("eth_simulateV1", [{ blockStateCalls: [{ calls: [{ from: await agent.getAddress(),
  to: guardAddress, data: call.data, value: toQuantity(0) }] }], traceTransfers: true, validation: false }, "latest"]);
const result = simulation[0].calls[0];
if (BigInt(result.status) !== 1n) throw new Error("Guarded execution simulation failed");
const emitted = result.logs.filter((log) => log.address.toLowerCase() === guardAddress.toLowerCase())
  .some((log) => guard.interface.parseLog(log)?.args.permitHash === permit.permitHash);
if (!emitted) throw new Error("Simulation did not emit the PermitConsumed event");
const execution = await (await asAgent.executeGuarded(tx.to, tx.value, tx.data, typed.message, signature)).wait();
if (execution.status !== 1n && execution.status !== 1) throw new Error("Local guarded execution failed");
await expectsRevert(() => asAgent.executeGuarded.staticCall(tx.to, tx.value, tx.data, typed.message, signature), "ReplayedPermit");
console.log(`Safe 1.5.0 Base Sepolia fork accepted a matching EIP-712 permit and rejected missing and replayed permits. Local transaction ${execution.hash}.`);

const offlineRouter = "https://router-api.0g.ai/v1/chat/completions";
const actualFetch = globalThis.fetch;
const generatedProofRequests = [];
const priorEnv = Object.fromEntries(["ZERO_G_API_KEY", "ZERO_G_FORCE_DEMO", "ZERO_G_BASE_URL", "ZERO_G_MODEL",
  "ZERO_G_CRITIC_MODEL", "ZERO_G_ENABLE_COMMITTEE", "ZERO_G_TRUST_MODE"].map((name) => [name, process.env[name]]));
for (const name of Object.keys(priorEnv)) delete process.env[name];
process.env.ZERO_G_API_KEY = "fork-fixture-only";
globalThis.fetch = async (url, options) => {
  if (url !== offlineRouter) return actualFetch(url, options);
  const { model } = JSON.parse(options.body);
  generatedProofRequests.push(model);
  return Response.json({ id: `fork-${model}`, model,
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision: "ALLOW", riskScore: 5,
      summary: "Controlled local acceptance fixture", threats: [], confidence: 0.99 }) } }],
    x_0g_trace: { request_id: `fixture-${model}`, provider: issuer.address, tee_verified: true } });
};
const apiKey = "fork-acceptance-fixture-key-00001";
const app = createApp({ owner: ownerAddress, wallet: safe, database: ":memory:", issuerKey: issuer.privateKey, guardAddress,
  keyHashes: [createHash("sha256").update(apiKey).digest("hex")],
  marketFor: async () => ({ source: "fork-fixture", usdMicros: { [baseSepolia.usdc]: "1000000" } }),
});
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const client = createProofGuardClient({ apiUrl: `http://127.0.0.1:${server.address().port}`, apiKey });
  const token = new Contract(baseSepolia.usdc, ["function approve(address spender,uint256 amount)",
    "function allowance(address owner,address spender) view returns(uint256)"], provider);
  const approval = { chainId: baseSepolia.chainId, from: safe, to: baseSepolia.usdc, value: "0",
    data: token.interface.encodeFunctionData("approve", [baseSepolia.permit2, 1_000_000n]) };
  let approvalPermit;
  const outcome = await client.guardedSend(approval, async ({ transaction, result, typedData }) => {
    approvalPermit = result.permit.permitHash;
    const sent = await asAgent.executeGuarded(transaction.to, transaction.value, transaction.data, typedData.message, result.onchainPermit.signature);
    return sent.wait();
  }, { verifyingContract: guardAddress, inspect: async ({ result, typedData }) => {
    const calldata = (await asAgent.executeGuarded.populateTransaction(approval.to, approval.value, approval.data,
      typedData.message, result.onchainPermit.signature)).data;
    const simulated = await provider.send("eth_simulateV1", [{ blockStateCalls: [{ calls: [{ from: await agent.getAddress(),
      to: guardAddress, data: calldata }] }], traceTransfers: true, validation: false }, "latest"]);
    if (BigInt(simulated[0].calls[0].status) !== 1n) throw new Error("API-issued permit simulation reverted");
  } });
  if (outcome.status !== 1 || await token.allowance(safe, baseSepolia.permit2) !== 1_000_000n || new Set(generatedProofRequests).size !== 2) {
    throw new Error("Guarded API and SDK integration failed");
  }
  const audit = await client.audit(approvalPermit);
  if (audit.permit?.permitHash !== approvalPermit || audit.reviews?.length !== 2
    || audit.reviews.some(({ requestId, verification }) => !requestId || verification !== "router-verified")) {
    throw new Error("The fork approval is missing its audit evidence");
  }
  const unauthorized = new Interface(["function transfer(address recipient,uint256 amount)"]);
  const unacceptable = { ...approval, data: unauthorized.encodeFunctionData("transfer", [safeRecipient, 1n]) };
  let submitted = false;
  try {
    await client.guardedSend(unacceptable, () => { submitted = true; });
  } catch (error) {
    if (error.message !== "ProofGuard did not grant a live permit.") throw error;
  }
  if (submitted || generatedProofRequests.length !== 4) throw new Error("Rejected trade reached the signer");
  console.log(`A two-reviewer fixture went through HTTP, SQLite, the SDK and Safe Guard. Local approval ${outcome.hash}. The policy veto prevented an unapproved recipient from reaching the signer.`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  app.locals.closeReviewStore();
  globalThis.fetch = actualFetch;
  for (const [name, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
