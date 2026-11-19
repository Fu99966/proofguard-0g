import { AbiCoder, Interface, MaxUint256, solidityPacked } from "ethers";
import { policy, scenarios } from "../server/demoData.js";

const reference = scenarios[0].transaction;
const assets = Object.fromEntries(Object.entries(policy.allowedAssets).map(([name, asset]) => [asset.symbol, name.split(":")[1]]));
const rpcInterface = new Interface(["function execute(bytes,bytes[])"]);
const token = new Interface(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const abi = AbiCoder.defaultAbiCoder();
const unknownAddress = "0x1111111111111111111111111111111111111111";

function swap(amount, minimum, { from = reference.from, chainId = reference.chainId, command = "0x00" } = {}) {
  const path = solidityPacked(["address", "uint24", "address"], [assets.USDC, 500, assets.WETH]);
  const config = abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [from, amount, minimum, path, true]);
  return { ...reference, chainId, from, data: rpcInterface.encodeFunctionData("execute", [command, [config]]) };
}

function action(method, account, amount) {
  return { ...reference, to: assets.USDC, data: token.encodeFunctionData(method, [account, amount]) };
}

export const cases = scenarios.map(({ id, transaction, description }) => ({
  id, transaction, expected: id === "safe-swap" ? "ALLOW" : "BLOCK", reason: description, source: "server/demoData.js",
}));
function sample(family, count, expected, reason, build) {
  for (let i = 1; i <= count; i++) cases.push({ id: `${family}-${i}`, expected, reason, transaction: build(BigInt(i)), source: "eval/cases.js" });
}

sample("bounded-swap", 30, "ALLOW", "Known token pair and minimum output within the fixture's quote bounds.",
  (i) => swap(i * 240_000_000n, i * 99_600_000_000_000_000n));
sample("bounded-approval", 10, "ALLOW", "Registered spender and bounded ERC-20 allowance.",
  (i) => action("approve", reference.to, 1_000_000n * i));
sample("foreign-spender", 10, "BLOCK", "Spender is outside the account policy.",
  (i) => action("approve", unknownAddress, 3_000_000n * i));
sample("unbounded-approval", 5, "BLOCK", "Allowance exceeds the policy cap.",
  (i) => action("approve", reference.to, MaxUint256 - i + 1n));
sample("foreign-recipient", 10, "BLOCK", "Token recipient is outside the account policy.",
  (i) => action("transfer", unknownAddress, i * 7_000_000n));
sample("high-slippage", 10, "BLOCK", "Minimum output is below the floor implied by the independent quote.",
  (i) => swap(i * 240_000_000n, i * 90_000_000_000_000_000n));
sample("unsupported-command", 5, "BLOCK", "Router command has no reviewed execution semantics.",
  (i) => swap(i * 240_000_000n, i * 99_600_000_000_000_000n, { command: "0x3f" }));
sample("sender-mismatch", 10, "BLOCK", "The input identifies a wallet outside the account policy.",
  (i) => swap(i * 240_000_000n, i * 99_600_000_000_000_000n, { from: unknownAddress }));
sample("legacy-claim-mismatch", 10, "BLOCK", "A legacy value claim conflicts with decoded and independently priced effects.",
  (i) => ({ ...reference, valueUsd: Number(i) }));
