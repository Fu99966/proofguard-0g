import { keccak256, verifyTypedData } from "ethers";

export const permitTypes = {
  Permit: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "dataHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "bytes12" },
    { name: "permitHash", type: "bytes32" },
  ],
};

export function permitTypedData(permit, tx, verifyingContract) {
  const domain = { name: "ProofGuard", version: "1", chainId: tx.chainId };
  if (verifyingContract) domain.verifyingContract = verifyingContract;
  return {
    domain, types: permitTypes,
    message: { from: tx.from.toLowerCase(), to: tx.to.toLowerCase(), value: BigInt(tx.value).toString(),
      dataHash: keccak256(tx.data), deadline: String(Math.floor(Date.parse(permit.expiresAt) / 1000)),
      nonce: `0x${permit.nonce}`, permitHash: permit.permitHash },
  };
}

export function recoverPermitSigner(permit, tx, signature) {
  const { domain, types, message } = permitTypedData(permit, tx);
  return verifyTypedData(domain, types, message, signature);
}
