import { Interface } from "ethers";
import { baseSepolia } from "../../sdk/network.js";
import { stableHash } from "../../sdk/commitment.js";
import { hasVerifiedReviewers, RULES_ONLY, RULES_PLUS_MODELS } from "../../sdk/review.js";

export { hasVerifiedReviewers } from "../../sdk/review.js";

const token = new Interface(["function transfer(address recipient,uint256 amount)"]);
const foreignRecipient = "0x000000000000000000000000000000000000dead";
const data = token.encodeFunctionData("transfer", [foreignRecipient, 0n]);

export function isRecipientRejection(entry, safe, { requireModels = true } = {}) {
  const tx = entry?.transaction;
  const validReview = entry?.reviewMode === RULES_ONLY
    ? !requireModels && Array.isArray(entry.reviews) && entry.reviews.length === 0
    : (entry?.reviewMode === undefined || entry.reviewMode === RULES_PLUS_MODELS) && hasVerifiedReviewers(entry?.reviews);
  return entry?.event === "recipient-rejected" && entry.decision === "BLOCK" && entry.permit === null
    && tx?.chainId === baseSepolia.chainId && typeof tx.from === "string" && tx.from.toLowerCase() === safe.toLowerCase()
    && tx.to === baseSepolia.usdc && tx.value === "0" && tx.data === data
    && Array.isArray(entry.blockers) && entry.blockers.includes("recipient") && entry.transactionHash === stableHash(tx)
    && validReview;
}

export async function checkRecipientRejection(client, safe, { requireModels = true } = {}) {
  const proposed = recipientRejectionProposal(safe);
  const result = await client.review(proposed);
  const entry = { event: "recipient-rejected", decision: result.decision, permit: result.permit,
    ...(result.reviewMode && { reviewMode: result.reviewMode }),
    transaction: result.transaction, blockers: result.deterministic?.blockers, transactionHash: result.evidence?.transactionHash,
    reviews: result.inference?.committee?.map(({ role, model, decision, receipt }) => ({ role, model, decision,
      verification: receipt?.verification, requestId: receipt?.requestId })) ?? [] };
  const liveReview = result.reviewMode === RULES_ONLY
    ? result.simulation === false && result.inference === null
    : result.simulation !== true && result.inference?.mode === "live";
  if (!liveReview || result.onchainPermit || !isRecipientRejection(entry, safe, { requireModels })) {
    throw new Error("The recipient acceptance check did not produce a verified policy rejection.");
  }
  return entry;
}

export function recipientRejectionProposal(safe) {
  return { chainId: baseSepolia.chainId, from: safe, to: baseSepolia.usdc, value: "0", data };
}
