import crypto from "node:crypto";

import { decodeTransaction } from "./decoder.js";
export { isTransactionProposal } from "./decoder.js";

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

function asset(policy, chainId, address) {
  return policy.allowedAssets[`${chainId}:${address}`];
}

function usdMicros(amount, token, chainId, policy, market, roundUp = true) {
  if (amount === "0") return 0n;
  const details = asset(policy, chainId, token);
  const price = market?.usdMicros?.[token];
  if (!details || typeof price !== "string" || !/^[1-9]\d{0,17}$/.test(price)) return null;
  const units = 10n ** BigInt(details.decimals);
  return (BigInt(amount) * BigInt(price) + (roundUp ? units - 1n : 0n)) / units;
}

function matchesClaims(transaction, derived) {
  return Object.entries(derived).every(([key, actual]) => !Object.hasOwn(transaction, key) || transaction[key] === actual)
    && (!Object.hasOwn(transaction, "target") || String(transaction.target).toLowerCase() === transaction.to.toLowerCase())
    && (!Object.hasOwn(transaction, "calldata") || String(transaction.calldata).toLowerCase() === transaction.data.toLowerCase());
}

export function evaluatePolicy(transaction, policy, { market, now = Date.now(), decoded } = {}) {
  const checks = [];
  const add = (id, label, passed, detail) => checks.push({ id, label, passed, severity: "critical", detail });
  add("chain", "允许的网络", policy.allowedChains.includes(transaction.chainId), String(transaction.chainId));
  add("sender", "Agent 钱包", transaction.from?.toLowerCase() === policy.agentWallet, "提交者必须匹配已登记钱包");
  const hostileMemo = INJECTION_PATTERNS.some((pattern) => pattern.test(String(transaction.memo || "")));
  add("injection", "提示词注入", !hostileMemo, hostileMemo ? "检测到操纵模式" : "未检测到操纵指令");

  let facts = decoded;
  try {
    facts ??= decodeTransaction(transaction, policy);
  } catch (error) {
    add("decode", "交易解码", false, error.message);
    return verdict(checks, null);
  }

  let value = 0n;
  let exposure = 0n;
  let quoteAvailable = true;
  let worstSlippage = 0n;
  let priceDeviation = 0n;
  const { chainId, from, to } = facts.tx;
  const swaps = facts.effects.filter(({ kind }) => kind === "swap");
  const transfers = facts.effects.filter(({ kind }) => kind === "transfer");
  const approvals = facts.effects.filter(({ kind }) => kind === "approval");
  const tokens = facts.effects.flatMap((effect) => effect.path ?? [effect.asset]);
  add("assets", "资产白名单", tokens.every((token) => Boolean(asset(policy, chainId, token))), tokens.join(" → "));
  add("recipient", "收款地址", [...swaps, ...transfers].every((effect) => effect.from === from
    && (effect.recipient === policy.agentWallet || policy.allowedRecipients.includes(effect.recipient))), "来源与收款地址匹配策略");
  add("deadline", "Router 截止时间", facts.deadline === undefined || BigInt(facts.deadline) > BigInt(Math.floor(now / 1000)), "以交易参数为准");
  const isRouter = Boolean(policy.routers[`${chainId}:${to}`]);
  add("calldata", "Calldata 编码", !facts.trailingData || facts.trailingData === "0x", "只为可完整审查的 ABI 数据发放许可");
  add("bundle", "命令组合", !isRouter || (swaps.length === 1 && transfers.length === 0 && approvals.length <= 1
    && (approvals.length === 0 || (facts.effects[0] === approvals[0] && approvals[0].spender === to
      && approvals[0].asset === swaps[0].path[0] && BigInt(approvals[0].amount) <= BigInt(swaps[0].maxIn)))),
  "Router 仅接受可完整归因的换仓组合");

  for (const effect of transfers) {
    const amount = usdMicros(effect.amount, effect.asset, chainId, policy, market);
    quoteAvailable &&= amount !== null;
    value += amount ?? 0n;
  }
  for (const effect of swaps) {
    const input = usdMicros(effect.maxIn, effect.path[0], chainId, policy, market);
    const output = usdMicros(effect.minOut, effect.path.at(-1), chainId, policy, market, false);
    quoteAvailable &&= input !== null && input > 0n && output !== null && output > 0n;
    value += input ?? 0n;
    if (policy.maxPriceDeviationBps === undefined) {
      // The four presets use a fixed market fixture with a synthetic fair price.
      if (input !== null && output !== null) worstSlippage = adverseBps(input, output);
      continue;
    }
    const quote = market?.swapQuote;
    const quotedIn = quote ? usdMicros(quote.input, effect.path[0], chainId, policy, market) : null;
    const quotedOut = quote ? usdMicros(quote.output, effect.path.at(-1), chainId, policy, market, false) : null;
    quoteAvailable &&= Boolean(quotedIn && quotedOut);
    if (!quotedIn || !quotedOut) continue;
    const delta = quotedIn > quotedOut ? quotedIn - quotedOut : quotedOut - quotedIn;
    priceDeviation = (delta * 10_000n + quotedIn - 1n) / quotedIn;
    worstSlippage = effect.exactOut
      ? adverseBps(BigInt(effect.maxIn), BigInt(quote.input), BigInt(quote.input))
      : adverseBps(BigInt(quote.output), BigInt(effect.minOut));
  }
  for (const effect of approvals) {
    const amount = usdMicros(effect.amount, effect.asset, chainId, policy, market);
    quoteAvailable &&= amount !== null;
    exposure += amount ?? 0n;
  }
  const expiresIn = Math.floor(now / 1000);
  add("approval", "授权额度", approvals.every((effect) => !effect.unlimited && !effect.additive && effect.protocol !== "operator"
    && policy.allowedSpenders.includes(effect.spender) && (!effect.owner || effect.owner === from)
    && (effect.expiration === undefined || effect.amount === "0" || (effect.expiration > expiresIn && effect.expiration <= expiresIn + 3600))
    && (effect.signatureDeadline === undefined || BigInt(effect.signatureDeadline) > BigInt(expiresIn)))
    && exposure <= BigInt(policy.maxApprovalUsd) * 1_000_000n, "核对授权对象、有效期和额度");
  add("market", "独立定价证据", quoteAvailable, market?.source ?? "没有可用的独立价格");
  add("value", "单笔价值上限", quoteAvailable && value <= BigInt(policy.maxValueUsd) * 1_000_000n, `${value} 微美元`);
  if (policy.maxPriceDeviationBps !== undefined) {
    add("price-deviation", "独立市价偏差", quoteAvailable && priceDeviation <= BigInt(policy.maxPriceDeviationBps), `${priceDeviation} BPS`);
  }
  add("slippage", "最大滑点", quoteAvailable && worstSlippage <= BigInt(policy.maxSlippageBps), `${worstSlippage} BPS`);
  const derived = { method: facts.method, valueUsd: Number(value) / 1_000_000, approvalUsd: Number(exposure) / 1_000_000,
    slippageBps: Number(worstSlippage), assetIn: asset(policy, chainId, tokens[0])?.symbol,
    assetOut: asset(policy, chainId, tokens.at(-1))?.symbol };
  add("claims", "自报字段核对", matchesClaims(transaction, derived), "自报字段必须与解码和定价一致");
  return verdict(checks, { ...facts, valuation: { source: market?.source ?? null, block: market?.blockTag, portfolio: market?.portfolio, valueUsdMicros: value.toString(),
    approvalUsdMicros: exposure.toString(), worstSlippageBps: Number(worstSlippage), priceDeviationBps: Number(priceDeviation), complete: quoteAvailable } });
}

function adverseBps(start, end, denominator = start) {
  if (start <= end || denominator === 0n) return 0n;
  return ((start - end) * 10_000n + denominator - 1n) / denominator;
}

function verdict(checks, facts) {
  const blockers = checks.filter((check) => !check.passed).map((check) => check.id);
  return { passed: blockers.length === 0, score: Math.max(0, 100 - blockers.length * 28), checks, blockers, facts };
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
      target: transaction.to,
      value: transaction.value,
      method: deterministic.facts.method,
      chainId: transaction.chainId,
    },
  };
}

