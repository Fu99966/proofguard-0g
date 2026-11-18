import { AbiCoder, Interface, MaxUint256 } from "ethers";

const erc20 = new Interface([
  "function transfer(address to,uint256 amount)",
  "function transferFrom(address from,address to,uint256 amount)",
  "function approve(address spender,uint256 amount)",
  "function increaseAllowance(address spender,uint256 amount)",
  "function setApprovalForAll(address operator,bool approved)",
]);
const router = new Interface([
  "function execute(bytes commands,bytes[] inputs)",
  "function execute(bytes commands,bytes[] inputs,uint256 deadline)",
]);
const permitSingle = "((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)";
const permit2 = new Interface([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function transferFrom(address from,address to,uint160 amount,address token)",
  `function permit(address owner,${permitSingle} permitSingle,bytes signature)`,
  "function allowance(address owner,address token,address spender) view returns (uint160,uint48,uint48)",
]);
const abi = AbiCoder.defaultAbiCoder();
const actorRecipient = "0x0000000000000000000000000000000000000001";
const routerRecipient = "0x0000000000000000000000000000000000000002";
const maxPermit2 = (1n << 160n) - 1n;
const contractBalance = 1n << 255n;
const address = (value) => typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
const hex = (value) => typeof value === "string" && /^0x(?:[\da-f]{2})*$/i.test(value);

export function isTransactionProposal(tx) {
  return tx != null && typeof tx === "object" && !Array.isArray(tx)
    && Number.isSafeInteger(tx.chainId) && tx.chainId > 0
    && address(tx.from) && address(tx.to) && hex(tx.data)
    && typeof tx.value === "string" && /^(?:0|[1-9]\d{0,77}|0x[\da-f]{1,64})$/i.test(tx.value)
    && BigInt(tx.value) <= MaxUint256
    && (tx.memo === undefined || (typeof tx.memo === "string" && tx.memo.length <= 4096));
}

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function parseCall(contract, data) {
  const call = contract.parseTransaction({ data });
  requireValid(call, "Unsupported selector");
  const canonical = contract.encodeFunctionData(call.fragment, call.args).toLowerCase();
  const trailingData = data.startsWith(canonical) ? data.slice(canonical.length) : null;
  requireValid(trailingData !== null && (trailingData === "" || (contract === router && trailingData.length <= 256)),
    "Noncanonical calldata");
  return { ...call, trailingData: `0x${trailingData}` };
}

function routerInput(types, data) {
  const args = abi.decode(types, data);
  requireValid(abi.encode(types, args).toLowerCase() === data, "Noncanonical Router command input");
  return args;
}

function transfer(asset, from, recipient, amount) {
  return { kind: "transfer", asset, from: from.toLowerCase(), recipient: recipient.toLowerCase(), amount: amount.toString() };
}

function approval(asset, spender, amount, protocol, metadata = {}) {
  const max = protocol === "permit2" ? maxPermit2 : MaxUint256;
  return { kind: "approval", asset, spender: spender.toLowerCase(), amount: amount.toString(),
    unlimited: amount === max, protocol, ...metadata };
}

function erc20Effects(call, tx) {
  const [first, second, third] = call.args;
  switch (call.name) {
    case "transfer": return [transfer(tx.to, tx.from, first, second)];
    case "transferFrom": return [transfer(tx.to, first, second, third)];
    case "approve": return [approval(tx.to, first, second, "erc20")];
    case "increaseAllowance": return [approval(tx.to, first, second, "erc20", { additive: true })];
    case "setApprovalForAll": return [approval(tx.to, first, second ? MaxUint256 : 0n, "operator")];
    default: throw new Error("Unsupported token method");
  }
}

function signedPermit(owner, details) {
  return approval(details.details.token.toLowerCase(), details.spender, details.details.amount, "permit2", {
    owner: owner.toLowerCase(), expiration: Number(details.details.expiration), signatureDeadline: details.sigDeadline.toString(),
  });
}

function permit2Effects(call) {
  const [first, second, third, fourth] = call.args;
  switch (call.name) {
    case "transferFrom": return [transfer(fourth.toLowerCase(), first, second, third)];
    case "approve": return [approval(first.toLowerCase(), second, third, "permit2", { expiration: Number(fourth) })];
    case "permit": return [signedPermit(first, second)];
    default: throw new Error("Unsupported Permit2 method");
  }
}

function parseV3Path(path) {
  const payload = path.slice(2);
  requireValid(payload.length >= 86 && (payload.length - 40) % 46 === 0, "Invalid V3 swap path");
  const tokens = [`0x${payload.slice(0, 40)}`];
  const fees = [];
  for (let i = 40; i < payload.length; i += 46) {
    fees.push(Number.parseInt(payload.slice(i, i + 6), 16));
    tokens.push(`0x${payload.slice(i + 6, i + 46)}`);
  }
  return { tokens, fees };
}

function decodeSwap(command, input, tx) {
  const v3 = command < 2;
  const exactOut = command === 1 || command === 9;
  const [recipient, amount, limit, path, payerIsUser] = routerInput(
    ["address", "uint256", "uint256", v3 ? "bytes" : "address[]", "bool"], input,
  );
  const parsed = v3 ? parseV3Path(path) : { tokens: path.map((token) => token.toLowerCase()), fees: [] };
  if (v3 && exactOut) {
    parsed.tokens.reverse();
    parsed.fees.reverse();
  }
  requireValid(parsed.tokens.length >= 2 && amount > 0n && limit > 0n, "Swap has no path or amount bound");
  const maxIn = exactOut ? limit : amount;
  requireValid(maxIn !== contractBalance && maxIn !== MaxUint256, "Unbounded Router input");
  return { kind: "swap", protocol: v3 ? "uniswap-v3" : "uniswap-v2",
    path: parsed.tokens, fees: parsed.fees, from: payerIsUser ? tx.from : tx.to,
    recipient: resolveRecipient(recipient, tx), maxIn: maxIn.toString(), minOut: (exactOut ? amount : limit).toString(), exactOut };
}

function resolveRecipient(recipient, tx) {
  const normalized = recipient.toLowerCase();
  if (normalized === actorRecipient) return tx.from;
  if (normalized === routerRecipient) return tx.to;
  return normalized;
}

function routerEffects(call, tx) {
  const [commands, inputs, deadline] = call.args;
  const bytes = commands.slice(2).match(/../g) || [];
  requireValid(bytes.length > 0 && bytes.length === inputs.length && bytes.length <= 16, "Invalid Router bundle");
  return { deadline: deadline?.toString(), effects: bytes.map((byte, index) => {
    const command = Number.parseInt(byte, 16);
    const input = inputs[index];
    switch (command) {
      case 0: case 1: case 8: case 9: return decodeSwap(command, input, tx);
      case 2: {
        const [asset, recipient, amount] = routerInput(["address", "address", "uint160"], input);
        return transfer(asset.toLowerCase(), tx.from, resolveRecipient(recipient, tx), amount);
      }
      case 10: {
        const [details] = routerInput([permitSingle, "bytes"], input);
        return signedPermit(tx.from, details);
      }
      default: throw new Error("Unsupported Router command or flags");
    }
  }) };
}

export function decodeTransaction(transaction, policy) {
  if (!isTransactionProposal(transaction)) throw new Error("Invalid EVM transaction envelope");
  const tx = { chainId: transaction.chainId, from: transaction.from.toLowerCase(), to: transaction.to.toLowerCase(),
    value: BigInt(transaction.value).toString(), data: transaction.data.toLowerCase() };
  const target = `${tx.chainId}:${tx.to}`;
  if (tx.data === "0x") {
    requireValid(BigInt(tx.value) > 0n, "Empty transaction");
    return { tx, method: "nativeTransfer", effects: [transfer("native", tx.from, tx.to, BigInt(tx.value))] };
  }
  requireValid(tx.value === "0", "Native value is unsupported for this call");
  if (policy.routers[target]) {
    const call = parseCall(router, tx.data);
    return { tx, method: call.signature, trailingData: call.trailingData, ...routerEffects(call, tx) };
  }
  if (policy.permit2[target]) {
    const call = parseCall(permit2, tx.data);
    return { tx, method: call.signature, effects: permit2Effects(call) };
  }
  requireValid(policy.allowedAssets[target], "Unknown target contract");
  const call = parseCall(erc20, tx.data);
  return { tx, method: call.signature, effects: erc20Effects(call, tx) };
}
