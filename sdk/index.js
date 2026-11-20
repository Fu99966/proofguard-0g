import { getAddress, verifyTypedData } from "ethers";
import { baseSepolia } from "./network.js";
import { assertPermitCommitment, permitTypedData } from "./permit.js";
import { isLiveModelApproval, RULES_ONLY } from "./review.js";
import { stableHash } from "./commitment.js";

export function createProofGuardClient({ apiUrl, apiKey, now = Date.now }) {
  const url = new URL(apiUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use HTTPS for remote ProofGuard clients.");
  }
  if (!apiKey) throw new Error("A ProofGuard Agent key is required.");

  async function request(path, options) {
    const response = await fetch(new URL(path, url), {
      ...options, headers: { ...options?.headers, Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(100_000), redirect: "error",
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || `ProofGuard returned ${response.status}`);
      error.code = payload.code;
      throw error;
    }
    return payload;
  }

  function review(transaction) {
    return request("/api/review", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction }) });
  }

  function audit(permitHash) {
    if (!/^0x[0-9a-f]{64}$/i.test(permitHash)) throw new Error("Invalid permit hash.");
    return request(`/api/audit/${permitHash}`);
  }

  async function guardedSend(transaction, submit, { inspect = async () => {}, verifyingContract, onReview } = {}) {
    if (transaction.chainId !== baseSepolia.chainId) throw new Error("Guarded submission is limited to Base Sepolia.");
    const snapshot = Object.freeze({ ...transaction });
    const result = await review(snapshot);
    await onReview?.(result);
    const { permit, inference } = result;
    if (result.decision !== "ALLOW" || !permit) throw new Error("ProofGuard did not grant a live permit.");
    assertPermitCommitment(permit, snapshot);
    const current = permit.version === "proofguard-permit/3";
    if (current) {
      if (result.reviewMode !== permit.reviewMode || result.simulation !== false || permit.simulation
        || (permit.reviewMode === RULES_ONLY ? inference !== null : !isLiveModelApproval(inference))) {
        throw new Error("ProofGuard returned inconsistent review mode or evidence.");
      }
      const evidenceValue = result.evidence?.responseValue;
      if (typeof evidenceValue !== "string" || stableHash(evidenceValue) !== permit.evidenceHash
        || result.evidence.responseCommitment !== permit.evidenceHash) {
        throw new Error("ProofGuard returned an invalid evidence commitment.");
      }
    } else if (inference?.mode !== "live" || result.reviewMode !== undefined || result.simulation !== undefined) {
      throw new Error("ProofGuard did not grant a live permit.");
    }
    const returned = result.transaction;
    const expires = Date.parse(permit.expiresAt);
    if (!returned || returned.from !== snapshot.from || returned.to !== snapshot.to || returned.data !== snapshot.data
      || returned.value !== snapshot.value || returned.chainId !== snapshot.chainId
      || !Number.isFinite(expires) || expires <= now()) throw new Error("ProofGuard returned an invalid transaction binding.");
    const signerProof = result.onchainPermit;
    const typedData = permitTypedData(permit, snapshot, verifyingContract ?? signerProof?.verifyingContract);
    if (current) {
      if (!signerProof || !typedData.domain.verifyingContract
        || getAddress(signerProof.verifyingContract) !== getAddress(typedData.domain.verifyingContract)
        || verifyTypedData(typedData.domain, typedData.types, typedData.message, signerProof.signature) !== getAddress(signerProof.issuer)) {
        throw new Error("ProofGuard returned an invalid on-chain Permit signature.");
      }
    }
    await inspect({ transaction: snapshot, result, typedData });
    if (Number(typedData.message.deadline) * 1000 <= now()) throw new Error("Permit expired before submission.");
    return submit({ transaction: snapshot, result, typedData });
  }
  return { review, audit, guardedSend };
}
