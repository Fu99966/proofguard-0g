import { Interface, MaxUint256 } from "ethers";
import { expect, it, vi } from "vitest";
import { scanBlockaidApproval } from "./blockaid-approvals.js";

const abi = new Interface([
  "function approve(address spender,uint256 amount)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
const owner = "0x0000000000000000000000000000000000000001";
const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const spender = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const scan = {
  proposal: { chainId: 8453, from: owner, to: token, value: "0", data: abi.encodeFunctionData("approve", [spender, MaxUint256]) },
  amount: MaxUint256.toString(), spender, minedBlock: 59_337_859, apiKey: "fixture-key",
};
const event = { emitter_address: token, ...abi.encodeEventLog(abi.getEvent("Approval"), [owner, spender, MaxUint256]) };

function payload(risk, additions = {}) {
  return { chain: "base", block: "59337858", account_address: owner,
    simulation: { status: "Success" }, validation: { status: "Success", result_type: risk }, events: [event], ...additions };
}

it.each([["Malicious", "FLAG"], ["Warning", "FLAG"], ["Benign", "CLEAR"]])(
  "records %s only after matching the exact uint256 authorization in the simulated parent block",
  async (vendorRisk, decision) => {
    const fetchRequest = vi.fn(async () => Response.json(payload(vendorRisk), { headers: { "x-request-id": "fixture-id" } }));
    await expect(scanBlockaidApproval({ ...scan, fetchRequest })).resolves.toMatchObject({ decision, vendorRisk,
      scanBlock: "59337858", requestId: "fixture-id" });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const [[url, request]] = fetchRequest.mock.calls;
    expect(url).toBe("https://api.blockaid.io/v0/evm/transaction/scan");
    expect(request).toMatchObject({ method: "POST", headers: { "X-API-Key": "fixture-key" }, redirect: "error" });
    expect(JSON.parse(request.body)).toEqual({ chain: "base", account_address: owner, block: "59337858",
      data: { from: owner, to: token, data: scan.proposal.data, value: "0x0" },
      metadata: { non_dapp: true }, options: ["simulation", "validation"] });
  },
);

it.each([
  payload("Benign", { block: "latest" }),
  payload("Benign", { simulation: { status: "Error" } }),
  payload("Benign", { events: [] }),
  payload("Benign", { events: [event, event] }),
  payload("Error"),
])("retains unverified findings as inconclusive", async (data) => {
  await expect(scanBlockaidApproval({ ...scan, fetchRequest: async () => Response.json(data) }))
    .resolves.toMatchObject({ decision: "INCONCLUSIVE" });
});

it("does not send a request for an unauthorized scan", async () => {
  const fetchRequest = vi.fn();
  await expect(scanBlockaidApproval({ ...scan, apiKey: "", fetchRequest })).rejects.toThrow("credential");
  expect(fetchRequest).not.toHaveBeenCalled();
});
