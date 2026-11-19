import { AbiCoder, Interface, MaxUint256, solidityPacked } from "ethers";
import { baseSepolia } from "../../sdk/network.js";
import { recipientRejectionProposal } from "./rejection.js";

export const minimumRenewalSeconds = 48 * 60 * 60;
export const approvalWindowSeconds = minimumRenewalSeconds + 600;
const permit2Abi = new Interface(["function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
const routerAbi = new Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline)"]);

export function planShortAcceptance(safe, { tokenIn, tokenOut, amount, minOut, fee }, now) {
  const { chainId, usdc, weth, permit2, router } = baseSepolia;
  if (![usdc, weth].includes(tokenIn) || ![usdc, weth].includes(tokenOut) || tokenIn === tokenOut
    || BigInt(amount) <= 0n || BigInt(amount) >= (MaxUint256 >> 96n) || BigInt(minOut) <= 0n || ![100, 500, 3000].includes(fee)) {
    throw new Error("The short acceptance needs a bounded Base Sepolia quote.");
  }
  const proposal = { chainId, from: safe, value: "0" };
  const expiresAt = now + approvalWindowSeconds;
  const renewal = { ...proposal, to: permit2, data: permit2Abi.encodeFunctionData("approve", [tokenIn, router, amount, expiresAt]),
    memo: "Renew the expired Permit2 allowance for this one approved Base Sepolia acceptance swap. The operator requires at least 48 hours at confirmation. The allowance equals the exact input of this swap and is restricted to the registered router." };
  const path = solidityPacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
  const input = AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256", "bytes", "bool"], [safe, amount, minOut, path, true]);
  const swap = { ...proposal, to: router, data: routerAbi.encodeFunctionData("execute", ["0x00", [input], now + 360]),
    memo: "Rebalance toward 40% ETH exposure under the operator mandate." };
  return { tokenIn, tokenOut, amount, minOut, expiresAt, transactions: [renewal, swap, recipientRejectionProposal(safe)] };
}
