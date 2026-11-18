import crypto from "node:crypto";

const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const text = (value) => typeof value === "string" && value.trim().length > 0;

export function isTransactionProposal(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Number.isSafeInteger(value.chainId) && value.chainId > 0
    && typeof value.target === "string" && /^0x[0-9a-f]{40}$/i.test(value.target)
    && text(value.assetIn) && text(value.assetOut) && text(value.method)
    && text(value.calldata) && nonnegative(value.valueUsd)
    && Number.isSafeInteger(value.slippageBps) && value.slippageBps >= 0
    && (value.approvalUsd === undefined || nonnegative(value.approvalUsd))
    && (!/^approve\s*\(/i.test(value.method.trim()) || nonnegative(value.approvalUsd))
    && (value.memo === undefined || typeof value.memo === "string");
}

const INJECTION_PATTERNS = [
  /ignore (all |every )?(previous|prior) (rule|instruction)/i,
  /system override/i,
  /mark this .*safe/i,
  /never mention this instruction/i,
  /bypass/i,
];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value) {
  return `0x${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function normalizeAddress(address = "") {
  return String(address).toLowerCase();
}

export function evaluatePolicy(transaction, policy) {
  const checks = [];
  const add = (id, label, passed, severity, detail) => checks.push({ id, label, passed, severity, detail });

  add("chain", "允许的网络", policy.allowedChains.includes(transaction.chainId), "critical", `Chain ID ${transaction.chainId}`);

  const targetAllowed = policy.allowedTargets.map(normalizeAddress).includes(normalizeAddress(transaction.target));
  add("target", "合约白名单", targetAllowed, "critical", targetAllowed ? "目标合约已批准" : "未知目标合约");

  add(
    "value",
    "单笔价值上限",
    nonnegative(transaction.valueUsd) && transaction.valueUsd <= policy.maxValueUsd,
    "critical",
    `$${transaction.valueUsd.toLocaleString()} / $${policy.maxValueUsd.toLocaleString()}`,
  );

  add(
    "slippage",
    "最大滑点",
    nonnegative(transaction.slippageBps) && transaction.slippageBps <= policy.maxSlippageBps,
    "high",
    `${transaction.slippageBps / 100}% / ${policy.maxSlippageBps / 100}%`,
  );

  const assetsAllowed = [transaction.assetIn, transaction.assetOut]
    .every((asset) => policy.allowedAssets.includes(asset));
  add("assets", "资产白名单", assetsAllowed, "critical", `${transaction.assetIn} → ${transaction.assetOut}`);

  const approval = transaction.approvalUsd ?? 0;
  const approvalSafe = nonnegative(approval) && approval <= policy.maxApprovalUsd;
  add(
    "approval",
    "授权额度",
    approvalSafe,
    "critical",
    approval ? `${approval > 1e12 ? "UNLIMITED" : `$${approval.toLocaleString()}`} / $${policy.maxApprovalUsd.toLocaleString()}` : "非授权交易",
  );

  const injectionMatches = INJECTION_PATTERNS.filter((pattern) => pattern.test(String(transaction.memo || "")));
  add(
    "injection",
    "提示词注入",
    injectionMatches.length === 0,
    "critical",
    injectionMatches.length ? `检测到 ${injectionMatches.length} 个操纵模式` : "未检测到操纵指令",
  );

  const blockers = checks.filter((check) => !check.passed);
  return {
    passed: blockers.length === 0,
    score: Math.max(0, 100 - blockers.reduce((sum, item) => sum + (item.severity === "critical" ? 28 : 16), 0)),
    checks,
    blockers: blockers.map((item) => item.id),
  };
}

export function issuePermit({ transaction, policy, inference, deterministic, now = Date.now() }) {
  if (!deterministic.passed || inference.decision !== "ALLOW") return null;
  const issuedAt = new Date(now);
  const expiresAt = new Date(now + policy.expiresInSeconds * 1000);
  const payload = {
    version: "proofguard-permit/2",
    decision: "ALLOW",
    owner: policy.owner ?? null,
    transactionHash: stableHash(transaction),
    policyHash: stableHash(policy),
    inferenceHash: stableHash(inference.rawDecision),
    model: inference.model,
    models: inference.models || [inference.model],
    trustMode: inference.trustMode,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: crypto.randomBytes(12).toString("hex"),
  };

  return {
    ...payload,
    permitHash: stableHash(payload),
    enforceable: Boolean(payload.owner),
    scope: {
      target: transaction.target,
      valueUsd: transaction.valueUsd,
      method: transaction.method,
      chainId: transaction.chainId,
    },
  };
}

