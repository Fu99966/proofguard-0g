import { Interface, keccak256 } from "ethers";
import { expect, it } from "vitest";
import { guardAbi } from "../../sdk/guard.js";
import { verifyAgentRun } from "./verify-run.js";

const address = (digit) => `0x${digit.repeat(40)}`;
const hash = (digit) => `0x${digit.repeat(64)}`;
const guard = new Interface(guardAbi);
const startingTime = 1_800_000_000;
const duration = 24 * 60 * 60;
const agent = address("1");
const safe = address("2");
const guardAddress = address("3");
const target = address("4");
const txHash = hash("5");
const permitHash = hash("6");
const nonce = "01".repeat(12);
const expires = startingTime + 360;
const data = "0x12345678";
const scope = { runId: "fixture", mode: "testnet" };
const boundary = { ...scope, chainId: 84532, agent, guard: guardAddress, safe };
const at = (offset) => new Date((startingTime + offset) * 1_000).toISOString();

function fixture() {
  const logs = [{ address: guardAddress, ...guard.encodeEventLog("PermitConsumed", [permitHash, `0x${nonce}`, target]) }];
  const audit = { decision: "ALLOW", onchainPermit: { verifyingContract: guardAddress },
    permit: { permitHash, nonce, expiresAt: at(expires - startingTime) },
    deterministic: { passed: true, facts: { tx: { chainId: 84532, from: safe, to: target, value: "0", data }, effects: [{ kind: "swap" }] } },
    reviews: ["primary", "critic"].map((role) => ({ role, model: `model-${role}`, decision: "ALLOW", requestId: `router-${role}`, verification: "router-verified" })) };
  const blocks = {
    10: { number: 10, hash: hash("a"), timestamp: startingTime, nonce: 4 },
    20: { number: 20, hash: hash("b"), timestamp: startingTime + duration, nonce: 5 },
  };
  const entries = [
    { ...boundary, event: "run-started", at: at(0), blockTag: 10, blockHash: blocks[10].hash, nonce: 4 },
    ...Array.from({ length: 288 }, (_, index) => ({ ...scope, event: "position", at: at(index * 300) })),
    { ...scope, event: "submitted", at: at(310), txHash, permitHash },
    { ...scope, event: "confirmed", at: at(320), txHash, permitHash },
    { ...boundary, event: "run-finished", at: at(duration), blockTag: 20, blockHash: blocks[20].hash, nonce: 5 },
  ].sort((a, b) => a.at.localeCompare(b.at));
  const transaction = { nonce: 4, from: agent, to: guardAddress, value: 0n,
    data: guard.encodeFunctionData("executeGuarded", [target, 0, data,
      [safe, target, 0, keccak256(data), expires, `0x${nonce}`, permitHash], "0x"]) };
  const receipt = { blockNumber: 11, status: 1, logs };
  const provider = {
    getNetwork: async () => ({ chainId: 84532n }),
    getBlock: async (block) => blocks[block],
    getTransactionCount: async (_agent, block) => blocks[block].nonce,
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
  };
  return { entries, audit, provider, receipt, blocks, readAudit: async () => audit };
}

it("reconciles a complete 24-hour journal against all Agent nonces and the guarded swap", async () => {
  const evidence = fixture();
  await expect(verifyAgentRun(evidence.entries, evidence)).resolves.toMatchObject({ observations: 288, guardedTransactions: 1, swaps: 1 });
});

it("rejects an unjournaled on-chain transaction in the Agent nonce range", async () => {
  const evidence = fixture();
  evidence.blocks[20].nonce = evidence.entries.at(-1).nonce = 6;
  await expect(verifyAgentRun(evidence.entries, evidence)).rejects.toThrow("every on-chain Agent nonce");
});

it("rejects an observation gap or a truncated run", async () => {
  const evidence = fixture();
  const gap = evidence.entries.filter(({ event, at: timestamp }) => event !== "position" || timestamp < at(3600) || timestamp > at(5400));
  await expect(verifyAgentRun(gap, evidence)).rejects.toThrow("observation gap");
  evidence.blocks[20].timestamp--;
  await expect(verifyAgentRun(evidence.entries, evidence)).rejects.toThrow("less than 24 hours");
});

it("rejects a journal entry without a matching chain Permit or Router verification", async () => {
  const evidence = fixture();
  const logs = evidence.receipt.logs;
  evidence.receipt.logs = [];
  await expect(verifyAgentRun(evidence.entries, evidence)).rejects.toThrow("receipt does not match");
  evidence.receipt.logs = logs;
  evidence.audit.reviews[1].verification = "simulation";
  await expect(verifyAgentRun(evidence.entries, evidence)).rejects.toThrow("Router-verified approvals");
});
