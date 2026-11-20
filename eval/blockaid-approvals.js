import { Interface } from "ethers";

const endpoint = "https://api.blockaid.io/v0/evm/transaction/scan";
const approval = new Interface(["event Approval(address indexed owner,address indexed spender,uint256 value)"]);
const approvalTopic = approval.getEvent("Approval").topicHash;
const sameAddress = (first, second) => typeof first === "string" && first.toLowerCase() === second.toLowerCase();
const classifications = { Malicious: "FLAG", Warning: "FLAG", Benign: "CLEAR" };

export async function scanBlockaidApproval({ proposal, amount, spender, minedBlock, apiKey, fetchRequest = fetch }) {
  if (!apiKey?.trim() || proposal.chainId !== 8453 || proposal.value !== "0" || !Number.isSafeInteger(minedBlock) || minedBlock <= 1) {
    throw new Error("Blockaid approval scans require a credential and a verified Base benchmark proposal.");
  }
  const block = String(minedBlock - 1);
  const started = performance.now();
  let response;
  const result = (entry) => ({ ...entry, scanBlock: block, requestId: response?.headers.get("x-request-id") ?? null,
    latencyMs: Math.round(performance.now() - started) });
  try {
    response = await fetchRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey.trim() },
      body: JSON.stringify({ chain: "base", account_address: proposal.from, block,
        data: { from: proposal.from, to: proposal.to, data: proposal.data, value: "0x0" },
        metadata: { non_dapp: true }, options: ["simulation", "validation"] }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return result({ decision: "INCONCLUSIVE", httpStatus: response.status, reason: "Vendor request did not succeed." });
    const payload = await response.json();
    const { validation, simulation } = payload;
    const blockMatches = typeof payload.block === "string" && /^(?:\d+|0x[0-9a-f]+)$/i.test(payload.block) && BigInt(payload.block) === BigInt(block);
    if (payload.chain !== "base" || !blockMatches
      || (payload.account_address != null && !sameAddress(payload.account_address, proposal.from))
      || simulation?.status !== "Success" || validation?.status !== "Success"
      || !Object.hasOwn(classifications, validation.result_type)) {
      return result({ decision: "INCONCLUSIVE", reason: "Missing matching simulation or validation for the requested Base block." });
    }
    const matched = Array.isArray(payload.events) && payload.events.filter((event) => {
      if (!sameAddress(event?.emitter_address, proposal.to) || event.topics?.[0] !== approvalTopic) return false;
      try {
        const { owner, spender: approvedSpender, value } = approval.parseLog(event).args;
        return sameAddress(owner, proposal.from) && sameAddress(approvedSpender, spender) && value === BigInt(amount);
      } catch {
        return false;
      }
    }).length === 1;
    if (!matched) return result({ decision: "INCONCLUSIVE", vendorRisk: validation.result_type, reason: "Expected Approval event was absent or ambiguous." });
    return result({ decision: classifications[validation.result_type], vendorRisk: validation.result_type });
  } catch (error) {
    return result({ decision: "INCONCLUSIVE", reason: error.name });
  }
}
