import { keccak256, toBeHex, verifyTypedData, zeroPadValue } from "ethers";
import { stableHash } from "./commitment.js";
import { isReviewMode } from "./review.js";

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

const permitFields = ["version", "decision", "owner", "transactionHash", "policyHash", "model",
  "models", "trustMode", "issuedAt", "expiresAt", "nonce"];
const modeFields = ["reviewMode", "simulation", "evidenceHash"];

export function assertPermitCommitment(permit, tx) {
  const current = permit.version === "proofguard-permit/3";
  if (current ? !isReviewMode(permit.reviewMode) || typeof permit.simulation !== "boolean"
    : permit.version !== "proofguard-permit/2" || modeFields.some((field) => Object.hasOwn(permit, field))) {
    throw new Error("ProofGuard returned unsupported permit metadata.");
  }
  const fields = [...permitFields, ...(current ? modeFields : ["inferenceHash"])];
  if (fields.some((field) => !Object.hasOwn(permit, field))) throw new Error("ProofGuard returned incomplete permit metadata.");
  const payload = Object.fromEntries(fields.map((field) => [field, permit[field]]));
  if (stableHash(payload) !== permit.permitHash || (tx && stableHash(tx) !== permit.transactionHash)) {
    throw new Error("ProofGuard returned an invalid permit commitment.");
  }
}

export function permitTypedData(permit, tx, verifyingContract, issuerEpoch = "0") {
  if (permit.version !== undefined || permit.transactionHash !== undefined || permit.reviewMode !== undefined) assertPermitCommitment(permit, tx);
  const domain = { name: "ProofGuard", version: "1", chainId: tx.chainId };
  if (verifyingContract) domain.verifyingContract = verifyingContract;
  if (typeof issuerEpoch !== "string" || !/^(0|[1-9]\d{0,77})$/.test(issuerEpoch)) throw new Error("Invalid Permit issuer epoch.");
  if (issuerEpoch !== "0") {
    if (!verifyingContract) throw new Error("An issuer epoch requires a Safe Guard address.");
    domain.salt = zeroPadValue(toBeHex(BigInt(issuerEpoch)), 32);
  }
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
