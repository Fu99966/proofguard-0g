import { baseSepolia } from "./network.js";
import { permitTypedData } from "./permit.js";

export function createProofGuardClient({ apiUrl, apiKey, now = Date.now }) {
  const url = new URL(apiUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use HTTPS for remote ProofGuard clients.");
  }
  if (!apiKey) throw new Error("A ProofGuard Agent key is required.");

  async function review(transaction) {
    const response = await fetch(new URL("/api/review", url), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ transaction }), signal: AbortSignal.timeout(100_000), redirect: "error",
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || `ProofGuard returned ${response.status}`);
      error.code = payload.code;
      throw error;
    }
    return payload;
  }

  async function guardedSend(transaction, submit, { inspect = async () => {}, verifyingContract } = {}) {
    if (transaction.chainId !== baseSepolia.chainId) throw new Error("Guarded submission is limited to Base Sepolia.");
    const snapshot = Object.freeze({ ...transaction });
    const result = await review(snapshot);
    const { permit, inference } = result;
    if (result.decision !== "ALLOW" || !permit || inference?.mode !== "live") throw new Error("ProofGuard did not grant a live permit.");
    const returned = result.transaction;
    const expires = Date.parse(permit.expiresAt);
    if (!returned || returned.from !== snapshot.from || returned.to !== snapshot.to || returned.data !== snapshot.data
      || returned.value !== snapshot.value || returned.chainId !== snapshot.chainId
      || !Number.isFinite(expires) || expires <= now()) throw new Error("ProofGuard returned an invalid transaction binding.");
    const typedData = permitTypedData(permit, snapshot, verifyingContract);
    await inspect({ transaction: snapshot, result, typedData });
    if (Number(typedData.message.deadline) * 1000 <= now()) throw new Error("Permit expired before submission.");
    return submit({ transaction: snapshot, result, typedData });
  }
  return { review, guardedSend };
}
