import { Interface, toQuantity, verifyTypedData } from "ethers";
import { baseSepolia } from "../../sdk/network.js";

const tokenInterface = new Interface(["function balanceOf(address account) view returns(uint256)"]);

async function simulate(simulationProvider, signer, guardAddress, safe, signedCall, expected) {
  const tracked = [baseSepolia.usdc, baseSepolia.weth];
  const balanceCalls = tracked.map((asset) => ({ to: asset, data: tokenInterface.encodeFunctionData("balanceOf", [safe]) }));
  const simulated = await simulationProvider.send("eth_simulateV1", [{ blockStateCalls: [{ calls: [
    ...balanceCalls, { from: signer.address, to: guardAddress, data: signedCall, value: toQuantity(0) }, ...balanceCalls,
  ] }], traceTransfers: true, validation: false }, "latest"]);
  const calls = simulated[0]?.calls;
  if (calls?.length !== 5 || calls.some(({ status }) => BigInt(status ?? 0) !== 1n)) throw new Error("Guarded transaction simulation failed.");
  for (const [index, asset] of tracked.entries()) {
    const [before] = tokenInterface.decodeFunctionResult("balanceOf", calls[index].returnData);
    const [after] = tokenInterface.decodeFunctionResult("balanceOf", calls[index + 3].returnData);
    if (!expected && after !== before) throw new Error("An approval unexpectedly changed asset balances.");
    if (expected && asset === expected.tokenIn && before - after !== expected.amount) throw new Error("Unexpected simulated input balance change.");
    if (expected && asset === expected.tokenOut && after - before < expected.minOut) throw new Error("Simulated output is below the reviewed minimum.");
  }
  if (calls[2].logs?.some((log) => log.address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")) {
    throw new Error("Simulation detected an unexpected native balance transfer.");
  }
}

export async function submitGuarded({ client, signer, guard, safe, guardAddress, issuer, simulationProvider, record, onReview }, tx, expected) {
  let signedCall;
  return client.guardedSend(tx, async ({ result }) => {
    const sent = await signer.sendTransaction({ to: guardAddress, data: signedCall, chainId: baseSepolia.chainId });
    await record({ event: "submitted", txHash: sent.hash, permitHash: result.permit.permitHash, target: tx.to });
    const receipt = await sent.wait(2, 100_000);
    if (receipt?.status !== 1) throw new Error("Base Sepolia execution did not confirm.");
    const consumed = receipt.logs.filter((log) => log.address.toLowerCase() === guardAddress.toLowerCase())
      .map((log) => guard.interface.parseLog(log)).some((log) => log?.name === "PermitConsumed" && log.args.permitHash === result.permit.permitHash);
    if (!consumed) throw Object.assign(new Error("The chain receipt did not record the reviewed permit."), { code: "MISSING_CHAIN_PERMIT" });
    await record({ event: "confirmed", txHash: receipt.hash, permitHash: result.permit.permitHash });
    return receipt;
  }, { verifyingContract: guardAddress, onReview, inspect: async ({ result, typedData }) => {
    const proof = result.onchainPermit;
    if (proof?.verifyingContract !== guardAddress || proof.issuer !== issuer
      || verifyTypedData(typedData.domain, typedData.types, typedData.message, proof.signature) !== issuer) {
      throw new Error("Missing or invalid Safe Guard issuer signature.");
    }
    const args = await guard.executeGuarded.populateTransaction(tx.to, tx.value, tx.data, typedData.message, proof.signature);
    signedCall = args.data;
    await simulate(simulationProvider, signer, guardAddress, safe, signedCall, expected);
  } });
}

