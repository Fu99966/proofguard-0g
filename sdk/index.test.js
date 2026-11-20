import { afterEach, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { createProofGuardClient } from "./index.js";
import { stableHash } from "./commitment.js";
import { permitTypedData } from "./permit.js";
import { RULES_ONLY, RULES_PLUS_MODELS } from "./review.js";

const [from, to] = [Wallet.createRandom().address, Wallet.createRandom().address];
const transaction = { chainId: 84532, from, to, value: "0", data: "0x" };
const apiKey = "local-key-012345678abcdef";
const now = 1_799_000_000_000;
const issuer = Wallet.createRandom();
const guard = Wallet.createRandom().address;
const responseValue = JSON.stringify({ decision: "ALLOW", checks: [] });
const evidenceHash = stableHash(responseValue);
const metadata = { version: "proofguard-permit/3", decision: "ALLOW", owner: from, transactionHash: stableHash(transaction),
  policyHash: stableHash({}), reviewMode: RULES_ONLY, simulation: false, evidenceHash, model: null, models: [], trustMode: null,
  issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), nonce: "11".repeat(12) };
const permit = { ...metadata, permitHash: stableHash(metadata) };
const { domain, types, message } = permitTypedData(permit, transaction, guard);
const signature = await issuer.signTypedData(domain, types, message);
const allowed = { decision: "ALLOW", reviewMode: RULES_ONLY, simulation: false, inference: null, permit, transaction,
  evidence: { responseValue, responseCommitment: evidenceHash },
  onchainPermit: { verifyingContract: guard, issuer: issuer.address, signature } };
const client = createProofGuardClient({ apiUrl: "https://example.com", apiKey, now: () => now });

afterEach(() => vi.unstubAllGlobals());

it("passes the same reviewed transaction to simulation and submission in order", async () => {
  const send = vi.fn().mockResolvedValue("submitted");
  const inspect = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockResolvedValue(Response.json(allowed));
  vi.stubGlobal("fetch", fetch);
  expect(await client.guardedSend(transaction, send, { inspect })).toBe("submitted");
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${apiKey}`);
  expect(inspect.mock.calls[0][0].transaction).toEqual(transaction);
  expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
});

it.each([
  { ...allowed, decision: "BLOCK", permit: null },
  { ...allowed, inference: { mode: "demo" } },
  { ...allowed, simulation: true },
  { ...allowed, onchainPermit: undefined },
  { ...allowed, reviewMode: RULES_PLUS_MODELS },
  { ...allowed, permit: { ...permit, reviewMode: RULES_PLUS_MODELS } },
  { ...allowed, evidence: { ...allowed.evidence, responseValue: "changed content" } },
  { ...allowed, transaction: { ...transaction, to: from } },
])("does not reach the signer for denied, simulated, mismatched or expired reviews", async (payload) => {
  const send = vi.fn();
  vi.stubGlobal("fetch", async () => Response.json(payload));
  await expect(client.guardedSend(transaction, send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it("rejects a recomputed mode commitment when the original issuer signature is retained", async () => {
  const receipt = { verification: "router-verified", verified: true };
  const dualValue = JSON.stringify({ primary: "ALLOW", critic: "ALLOW" });
  const dualHash = stableHash(dualValue);
  const tampered = { ...metadata, reviewMode: RULES_PLUS_MODELS, model: "primary-fixture",
    models: ["primary-fixture", "critic-fixture"], trustMode: "private", evidenceHash: dualHash };
  const committee = tampered.models.map((model, index) => ({
    role: index === 0 ? "primary" : "critic", model, decision: "ALLOW", receipt: { ...receipt, requestId: model },
  }));
  vi.stubGlobal("fetch", async () => Response.json({ ...allowed, reviewMode: RULES_PLUS_MODELS,
    permit: { ...tampered, permitHash: stableHash(tampered) },
    inference: { mode: "live", decision: "ALLOW", receipt, committee },
    evidence: { responseValue: dualValue, responseCommitment: dualHash } }));
  const send = vi.fn();
  await expect(client.guardedSend(transaction, send, { verifyingContract: guard })).rejects.toThrow("Permit signature");
  expect(send).not.toHaveBeenCalled();
});

it("rejects an expired permit and a proof for a different Safe Guard", async () => {
  vi.stubGlobal("fetch", async () => Response.json(allowed));
  const expired = createProofGuardClient({ apiUrl: "https://example.com", apiKey, now: () => now + 60_000 });
  const send = vi.fn();
  await expect(expired.guardedSend(transaction, send)).rejects.toThrow("transaction binding");
  await expect(client.guardedSend(transaction, send, { verifyingContract: to })).rejects.toThrow("Permit signature");
  expect(send).not.toHaveBeenCalled();
});

it("verifies a recovery-epoch signature and rejects a changed epoch", async () => {
  const issuerEpoch = "1";
  const recovered = permitTypedData(permit, transaction, guard, issuerEpoch);
  const proof = { ...allowed.onchainPermit, issuerEpoch,
    signature: await issuer.signTypedData(recovered.domain, recovered.types, recovered.message) };
  vi.stubGlobal("fetch", async () => Response.json({ ...allowed, onchainPermit: proof }));
  await expect(client.guardedSend(transaction, () => "new epoch")).resolves.toBe("new epoch");
  proof.issuerEpoch = "2";
  const send = vi.fn();
  await expect(client.guardedSend(transaction, send)).rejects.toThrow("Permit signature");
  expect(send).not.toHaveBeenCalled();
});

it("verifies a legitimate legacy permit without admitting invented mode metadata", async () => {
  const { reviewMode: _mode, simulation: _simulation, evidenceHash: _evidence, ...legacyPayload } = metadata;
  Object.assign(legacyPayload, { version: "proofguard-permit/2", inferenceHash: stableHash("legacy-verdict"),
    model: "primary", models: ["primary", "critic"], trustMode: "private" });
  const legacyPermit = { ...legacyPayload, permitHash: stableHash(legacyPayload) };
  const response = { decision: "ALLOW", inference: { mode: "live" }, permit: legacyPermit, transaction };
  vi.stubGlobal("fetch", async () => Response.json(response));
  expect(await client.guardedSend(transaction, () => "legacy accepted")).toBe("legacy accepted");
  response.permit = { ...legacyPermit, reviewMode: RULES_ONLY };
  const send = vi.fn();
  await expect(client.guardedSend(transaction, send)).rejects.toThrow("metadata");
  expect(send).not.toHaveBeenCalled();
});

it("blocks submission after an unsuccessful simulation", async () => {
  vi.stubGlobal("fetch", async () => Response.json(allowed));
  const send = vi.fn();
  const inspect = () => { throw new Error("Bad simulated balance"); };
  await expect(client.guardedSend(transaction, send, { inspect })).rejects.toThrow("Bad simulated balance");
  expect(send).not.toHaveBeenCalled();
});
