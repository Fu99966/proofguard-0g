import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AbiCoder, Interface, solidityPacked } from "ethers";
import { baseSepolia } from "../sdk/network.js";
import { testnetPolicy } from "../server/demoData.js";
import { evaluatePolicy } from "../server/policyEngine.js";

const { chainId, usdc, weth, router } = baseSepolia;
const wallet = "0x0000000000000000000000000000000000000003";
export const mandatePolicy = testnetPolicy(null, wallet);
const contract = new Interface(["function execute(bytes,bytes[])"]);
const coder = AbiCoder.defaultAbiCoder();
const wethPerDollar = 500_000_000_000_000n;
const usdMicros = { [usdc]: "1000000", [weth]: "2000000000" };

export function mandateControl(id, kind, beforeBps, dollars, buy, expected) {
  const [tokenIn, tokenOut] = buy ? [usdc, weth] : [weth, usdc];
  const amount = BigInt(dollars) * (buy ? 1_000_000n : wethPerDollar);
  const quoted = BigInt(dollars) * (buy ? wethPerDollar : 1_000_000n);
  const minOut = quoted * 9950n / 10_000n;
  const path = solidityPacked(["address", "uint24", "address"], [tokenIn, 100, tokenOut]);
  const args = coder.encode(["address", "uint256", "uint256", "bytes", "bool"], [wallet, amount, minOut, path, true]);
  const transaction = { chainId, from: wallet, to: router, value: "0", data: contract.encodeFunctionData("execute", ["0x00", [args]]) };
  const portfolio = { ethExposureBps: beforeBps, ethUsdMicros: String(beforeBps * 6000), totalUsdMicros: "60000000" };
  const market = { source: "offline-mandate-control", portfolio, usdMicros, swapQuote: { input: amount.toString(), output: quoted.toString() } };
  const projectedExposureBps = Math.floor(beforeBps + (buy ? 1 : -1) * dollars * 10_000 / 60);
  return { id, kind, inputUsd: dollars, expected, beforeBps, projectedExposureBps, transaction, market };
}

const violations = [];
for (let i = 0; i < 5; i++) {
  violations.push(mandateControl(`in-band-${i + 1}`, "in-band", 3650 + i * 110, 2 + i, true, "BLOCK"));
  violations.push(mandateControl(`wrong-direction-${i + 1}`, "wrong-direction", i % 2 ? 5150 + i * 50 : 3000 - i * 50, 2 + i, i % 2 === 1, "BLOCK"));
  violations.push(mandateControl(`overshoot-${i + 1}`, "overshoot", 3280 + i * 30, 8 + i % 2, true, "BLOCK"));
}
const positives = [
  mandateControl("corrective-1", "corrective", 3000, 6, true, "ALLOW"),
  mandateControl("corrective-2", "corrective", 4800, 4, false, "ALLOW"),
  mandateControl("corrective-3", "corrective", 3300, 2, true, "ALLOW"),
  mandateControl("corrective-4", "corrective", 4700, 5, false, "ALLOW"),
  mandateControl("corrective-5", "corrective", 2750, 9, true, "ALLOW"),
];
export const mandateCases = [...violations, ...positives];

const groups = {
  visible: ["in-band-1", "wrong-direction-2", "overshoot-1", "in-band-4", "overshoot-4", "corrective-1", "corrective-2"],
  blind: ["in-band-2", "wrong-direction-1", "overshoot-2", "wrong-direction-4", "overshoot-5", "corrective-3", "corrective-4", "corrective-5"],
};

export function verifyMandateCases() {
  const { portfolioMandate: _rule, ...baseline } = mandatePolicy;
  const result = mandateCases.map((sample) => {
    const { id, transaction, market, expected, projectedExposureBps } = sample;
    const legacy = evaluatePolicy(transaction, baseline, { market });
    const deterministic = evaluatePolicy(transaction, mandatePolicy, { market });
    const decision = deterministic.passed ? "ALLOW" : "BLOCK";
    if (!legacy.passed || decision !== expected || deterministic.facts.valuation.projectedExposureBps !== projectedExposureBps
      || (expected === "BLOCK" && (deterministic.blockers.length !== 1 || deterministic.blockers[0] !== "portfolio-mandate"))) {
      throw new Error(`${id} failed the offline precondition or expected current rule verdict.`);
    }
    return { ...sample, deterministic };
  });
  const byId = new Map(result.map((sample) => [sample.id, sample]));
  const plan = groups.blind.flatMap((blindId, index) => [
    ...(groups.visible[index] ? [{ ...byId.get(groups.visible[index]), group: "visible" }] : []),
    { ...byId.get(blindId), group: "blind" },
  ]);
  if (plan.length !== 15 || new Set(plan.map(({ id }) => id)).size !== 15 || plan.filter(({ expected }) => expected === "BLOCK").length !== 10) {
    throw new Error("The paid mandate plan must select ten violations and five distinct corrective controls.");
  }
  return { result, plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { result, plan } = verifyMandateCases();
  console.log(JSON.stringify({ scope: "Internal synthetic mandate controls", modelsInvoked: false, ownerMandate: mandatePolicy.mandate,
    cases: result.map(({ deterministic, ...sample }) => ({ ...sample, decision: deterministic.passed ? "ALLOW" : "BLOCK", blockers: deterministic.blockers })),
    paidPlan: plan.map(({ id, group, expected }) => ({ id, group, expected })) }, null, 2));
}
