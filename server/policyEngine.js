import crypto from "node:crypto";

import { decodeTransaction } from "./decoder.js";
import { stableHash } from "../sdk/commitment.js";
import { isLiveModelApproval, isReviewMode, RULES_ONLY, RULES_PLUS_MODELS } from "../sdk/review.js";
export { stableHash } from "../sdk/commitment.js";
export { isTransactionProposal } from "./decoder.js";

const INJECTION_PATTERNS = [
  /ignore (all |every )?(previous|prior) (rule|instruction)/i,
  /system override/i,
  /mark this .*safe/i,
  /never mention this instruction/i,
  /bypass/i,
];

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

const bpsScale = 10_000n;
const absolute = (integer) => integer < 0n ? -integer : integer;

function portfolioSwapCheck(mandate, portfolio, swap, quotePricing) {
  const evidence = (passed, reason, projectedExposureBps) => ({ passed, reason, projectedExposureBps });
  const beforeBps = portfolio?.ethExposureBps;
  const totalText = portfolio?.totalUsdMicros;
  const ethText = portfolio?.ethUsdMicros;
  if (!Number.isInteger(beforeBps) || beforeBps < 0 || beforeBps > 10_000
    || typeof totalText !== "string" || !/^[1-9]\d{0,35}$/.test(totalText)
    || (ethText !== undefined && (typeof ethText !== "string" || !/^\d{1,36}$/.test(ethText))) || !swap || !quotePricing) {
    return evidence(false, "missing-portfolio-or-quote");
  }
  const total = BigInt(totalText);
  const beforeScaled = ethText === undefined ? BigInt(beforeBps) * total : BigInt(ethText) * bpsScale;
  if (beforeScaled > total * bpsScale || beforeScaled / total !== BigInt(beforeBps)) {
    return evidence(false, "inconsistent-portfolio");
  }
  const inputEth = swap.path[0] === mandate.ethAsset;
  const outputEth = swap.path.at(-1) === mandate.ethAsset;
  if (inputEth === outputEth) return evidence(false, "unsupported-exposure-pair");
  const input = BigInt(quotePricing.quotedInputUsdMicros);
  const output = BigInt(quotePricing.quotedOutputUsdMicros);
  if (input * bpsScale > (inputEth ? beforeScaled : total * bpsScale - beforeScaled)) return evidence(false, "insufficient-portfolio-input");
  const afterScaled = beforeScaled + (outputEth ? output : -input) * bpsScale;
  const afterTotal = total - input + output;
  if (afterTotal <= 0n || afterScaled < 0n || afterScaled > afterTotal * bpsScale) return evidence(false, "invalid-projection");
  const projected = Number(afterScaled / afterTotal);
  const { lowerBps, targetBps, upperBps } = mandate;
  const lower = BigInt(lowerBps);
  const upper = BigInt(upperBps);
  const target = BigInt(targetBps);
  const belowBand = beforeScaled < lower * total;
  if (!belowBand && beforeScaled <= upper * total) return evidence(false, "in-band", projected);
  if ((belowBand && afterScaled > upper * afterTotal) || (!belowBand && afterScaled < lower * afterTotal)) {
    return evidence(false, "crosses-opposite-boundary", projected);
  }
  if (absolute(afterScaled - target * afterTotal) * total >= absolute(beforeScaled - target * total) * afterTotal) {
    return evidence(false, "not-closer-to-target", projected);
  }
  return evidence(true, "closer-within-opposite-boundary", projected);
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
  let swapPricing;
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
    if (swaps.length === 1 && input !== null && output !== null) {
      swapPricing = { input: quote.input, output: quote.output, maximumInputUsdMicros: input.toString(),
        minimumOutputUsdMicros: output.toString(), quotedInputUsdMicros: quotedIn.toString(), quotedOutputUsdMicros: quotedOut.toString() };
    }
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
  const approvalWindow = policy.shortPermit2ApprovalSeconds && policy.permit2[`${chainId}:${to}`]
    && facts.method === "approve(address,address,uint160,uint48)" ? policy.shortPermit2ApprovalSeconds : 3600;
  add("approval", "授权额度", approvals.every((effect) => !effect.unlimited && !effect.additive && effect.protocol !== "operator"
    && policy.allowedSpenders.includes(effect.spender) && (!effect.owner || effect.owner === from)
    && (effect.expiration === undefined || effect.amount === "0" || (effect.expiration > expiresIn && effect.expiration <= expiresIn + approvalWindow))
    && (effect.signatureDeadline === undefined || BigInt(effect.signatureDeadline) > BigInt(expiresIn)))
    && exposure <= BigInt(policy.maxApprovalUsd) * 1_000_000n, "核对授权对象、有效期和额度");
  add("market", "独立定价证据", quoteAvailable, market?.source ?? "没有可用的独立价格");
  add("value", "单笔价值上限", quoteAvailable && value <= BigInt(policy.maxValueUsd) * 1_000_000n, `${value} 微美元`);
  if (policy.maxPriceDeviationBps !== undefined) {
    add("price-deviation", "独立市价偏差", quoteAvailable && priceDeviation <= BigInt(policy.maxPriceDeviationBps), `${priceDeviation} BPS`);
  }
  add("slippage", "最大滑点", quoteAvailable && worstSlippage <= BigInt(policy.maxSlippageBps), `${worstSlippage} BPS`);
  const mandateCheck = policy.portfolioMandate && swaps.length
    ? portfolioSwapCheck(policy.portfolioMandate, market?.portfolio, swaps.length === 1 ? swaps[0] : null, swapPricing)
    : null;
  if (mandateCheck) add("portfolio-mandate", "仓位纠偏规则", mandateCheck.passed, mandateCheck.reason);
  const derived = { method: facts.method, valueUsd: Number(value) / 1_000_000, approvalUsd: Number(exposure) / 1_000_000,
    slippageBps: Number(worstSlippage), assetIn: asset(policy, chainId, tokens[0])?.symbol,
    assetOut: asset(policy, chainId, tokens.at(-1))?.symbol };
  add("claims", "自报字段核对", matchesClaims(transaction, derived), "自报字段必须与解码和定价一致");
  return verdict(checks, { ...facts, valuation: { source: market?.source ?? null, block: market?.blockTag, portfolio: market?.portfolio, valueUsdMicros: value.toString(),
    approvalUsdMicros: exposure.toString(), worstSlippageBps: Number(worstSlippage), priceDeviationBps: Number(priceDeviation), complete: quoteAvailable,
    ...(swapPricing && { swapPricing }),
    ...(mandateCheck?.projectedExposureBps !== undefined && { projectedExposureBps: mandateCheck.projectedExposureBps }) } });
}

function adverseBps(start, end, denominator = start) {
  if (start <= end || denominator === 0n) return 0n;
  return ((start - end) * 10_000n + denominator - 1n) / denominator;
}

function verdict(checks, facts) {
  const blockers = checks.filter((check) => !check.passed).map((check) => check.id);
  return { passed: blockers.length === 0, score: Math.max(0, 100 - blockers.length * 28), checks, blockers, facts };
}

export function reviewEvidenceValue(deterministic, inference) {
  return inference?.rawDecision ?? JSON.stringify({ decision: deterministic.passed ? "ALLOW" : "BLOCK", checks: deterministic.checks });
}

export function issuePermit({ transaction, policy, inference, deterministic, reviewMode = RULES_ONLY, simulation = false, now = Date.now() }) {
  if (!deterministic.passed || !isReviewMode(reviewMode)
    || (reviewMode === RULES_PLUS_MODELS && !isLiveModelApproval(inference))) return null;
  const issuedAt = new Date(now);
  const expiresAt = new Date(now + policy.expiresInSeconds * 1000);
  const modelReview = reviewMode === RULES_PLUS_MODELS ? inference : null;
  const payload = {
    version: "proofguard-permit/3",
    decision: "ALLOW",
    owner: policy.owner ?? null,
    transactionHash: stableHash(transaction),
    policyHash: stableHash(policy),
    reviewMode,
    simulation,
    evidenceHash: stableHash(reviewEvidenceValue(deterministic, modelReview)),
    model: modelReview?.model ?? null,
    models: modelReview?.models ?? [],
    trustMode: modelReview?.trustMode ?? null,
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

