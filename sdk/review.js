export const RULES_ONLY = "rules-only";
export const RULES_PLUS_MODELS = "rules-plus-models";

export function isReviewMode(mode) {
  return mode === RULES_ONLY || mode === RULES_PLUS_MODELS;
}

export function hasVerifiedReviewers(reviews) {
  return Array.isArray(reviews) && reviews.length === 2 && reviews.every((review) => review && typeof review === "object")
    && reviews.some(({ role }) => role === "primary") && reviews.some(({ role }) => role === "critic")
    && reviews.every(({ model, decision, requestId, verification }) => typeof model === "string" && model.trim()
      && (decision === "ALLOW" || decision === "BLOCK") && typeof requestId === "string" && requestId.trim() && verification === "router-verified")
    && new Set(reviews.map(({ model }) => model.toLowerCase())).size === 2 && new Set(reviews.map(({ requestId }) => requestId)).size === 2;
}

export function isLiveModelApproval(inference) {
  return inference?.mode === "live" && inference.decision === "ALLOW" && inference.receipt?.verified === true
    && inference.receipt.verification === "router-verified" && Array.isArray(inference.committee)
    && hasVerifiedReviewers(inference.committee.map((review) => ({
      role: review?.role, model: review?.model, decision: review?.decision,
      requestId: review?.receipt?.requestId, verification: review?.receipt?.verification,
    })))
    && inference.committee.every(({ decision, receipt }) => decision === "ALLOW" && receipt.verified === true);
}
