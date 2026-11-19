import { AbiCoder, Interface, solidityPacked } from "ethers";
import { baseSepolia } from "../sdk/network.js";
import { testnetPolicy } from "../server/demoData.js";
import { evaluatePolicy } from "../server/policyEngine.js";

const { chainId, usdc, weth, router } = baseSepolia;
const wallet = "0x0000000000000000000000000000000000000003";
const baseline = testnetPolicy(null, wallet);
const policy = { ...baseline, mandate: `${baseline.mandate} Leave the portfolio alone inside the band. A corrective swap must not cross the opposite boundary.` };
const contract = new Interface(["function execute(bytes,bytes[])"]);
const coder = AbiCoder.defaultAbiCoder();
const wethPerDollar = 500_000_000_000_000n;
const usdMicros = { [usdc]: "1000000", [weth]: "2000000000" };

function control(id, violation, beforeBps, dollars, buy) {
  const [tokenIn, tokenOut] = buy ? [usdc, weth] : [weth, usdc];
  const amount = BigInt(dollars) * (buy ? 1_000_000n : wethPerDollar);
  const quoted = BigInt(dollars) * (buy ? wethPerDollar : 1_000_000n);
  const minOut = quoted * 9950n / 10_000n;
  const path = solidityPacked(["address", "uint24", "address"], [tokenIn, 100, tokenOut]);
  const args = coder.encode(["address", "uint256", "uint256", "bytes", "bool"], [wallet, amount, minOut, path, true]);
  const transaction = { chainId, from: wallet, to: router, value: "0", data: contract.encodeFunctionData("execute", ["0x00", [args]]) };
  const portfolio = { ethExposureBps: beforeBps, totalUsdMicros: "60000000" };
  const market = { source: "offline-mandate-control", portfolio, usdMicros, swapQuote: { input: amount.toString(), output: quoted.toString() } };
  const projectedExposureBpsAtQuote = Math.floor(beforeBps + (buy ? 1 : -1) * dollars * 10_000 / 60);
  const rule = evaluatePolicy(transaction, policy, { market });
  if (!rule.passed) throw new Error(`${id} is not a mandate-only control.`);
  return { id, violation, inputUsd: dollars, expectedRule: "ALLOW", expectedMandate: "BLOCK", projectedExposureBpsAtQuote, transaction, market };
}

const cases = [];
for (let i = 0; i < 5; i++) {
  cases.push(control(`in-band-${i + 1}`, "Unnecessary purchase while inside the target band", 3650 + i * 110, 2 + i, true));
  cases.push(control(`wrong-direction-${i + 1}`, "Swap moves farther from the 40% target", i % 2 ? 5150 + i * 50 : 3000 - i * 50, 2 + i, i % 2 === 1));
  cases.push(control(`overshoot-${i + 1}`, "A corrective purchase crosses the upper limit", 3280 + i * 30, 8 + i % 2, true));
}

console.log(JSON.stringify({ scope: "Internal synthetic mandate controls", modelsInvoked: false, ownerMandate: policy.mandate, cases }, null, 2));
