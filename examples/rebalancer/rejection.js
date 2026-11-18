import { Interface } from "ethers";
import { baseSepolia } from "../../sdk/network.js";
import { stableHash } from "../../server/policyEngine.js";

const token = new Interface(["function transfer(address recipient,uint256 amount)"]);
const foreignRecipient = "0x000000000000000000000000000000000000dead";
const data = token.encodeFunctionData("transfer", [foreignRecipient, 0n]);

export function hasVerifiedReviewers(reviews) {
  return Array.isArray(reviews) && reviews.length === 2 && reviews.some(({ role }) => role === "primary") && reviews.some(({ role }) => role === "critic")
    && new Set(reviews.map(({ model }) => model)).size === 2 && new Set(reviews.map(({ requestId }) => requestId)).size === 2
    && reviews.every(({ model, decision, requestId, verification }) => model && (decision === "ALLOW" || decision === "BLOCK")
      && requestId && verification === "router-verified");
}

export function isRecipientRejection(entry, safe) {
  const tx = entry?.transaction;
  return entry?.event === "recipient-rejected" && entry.decision === "BLOCK" && entry.permit === null
    && tx?.chainId === baseSepolia.chainId && typeof tx.from === "string" && tx.from.toLowerCase() === safe.toLowerCase()
    && tx.to === baseSepolia.usdc && tx.value === "0" && tx.data === data
    && Array.isArray(entry.blockers) && entry.blockers.includes("recipient") && entry.transactionHash === stableHash(tx)
    && hasVerifiedReviewers(entry.reviews);
}

export async function checkRecipientRejection(client, safe) {
  const proposed = { chainId: baseSepolia.chainId, from: safe, to: baseSepolia.usdc, value: "0", data };
  const result = await client.review(proposed);
  const entry = { event: "recipient-rejected", decision: result.decision, permit: result.permit,
    transaction: result.transaction, blockers: result.deterministic?.blockers, transactionHash: result.evidence?.transactionHash,
    reviews: result.inference?.committee?.map(({ role, model, decision, receipt }) => ({ role, model, decision,
      verification: receipt?.verification, requestId: receipt?.requestId })) };
  if (result.inference?.mode !== "live" || result.onchainPermit || !isRecipientRejection(entry, safe)) {
    throw new Error("The recipient acceptance check did not produce a verified policy rejection.");
  }
  return entry;
}
