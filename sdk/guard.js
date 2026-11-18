import { Contract, id } from "ethers";

export const guardAbi = [
  "function safe() view returns(address)",
  "function agent() view returns(address)",
  "function issuer() view returns(address)",
  "function used(bytes12 nonce) view returns(bool)",
  "function executeGuarded(address to,uint256 value,bytes data,(address from,address to,uint256 value,bytes32 dataHash,uint256 deadline,bytes12 nonce,bytes32 permitHash) permit,bytes signature)",
  "event PermitConsumed(bytes32 indexed permitHash,bytes12 indexed nonce,address indexed target)",
];

export async function guardedSafeSigner(address, signer, safeAddress) {
  const guard = new Contract(address, guardAbi, signer);
  const [safe, agent] = await Promise.all([guard.safe(), guard.agent()]);
  if (safe.toLowerCase() !== safeAddress.toLowerCase() || agent.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error("The signer is not the configured ProofGuard Safe Agent.");
  }
  const account = new Contract(safeAddress, ["function getOwners() view returns(address[])",
    "function isModuleEnabled(address module) view returns(bool)"], signer);
  const [owners, moduleEnabled, txnGuard, moduleGuard] = await Promise.all([
    account.getOwners(), account.isModuleEnabled(address),
    signer.provider.getStorage(safeAddress, id("guard_manager.guard.address")),
    signer.provider.getStorage(safeAddress, id("module_manager.module_guard.address")),
  ]);
  const expected = address.toLowerCase();
  if (!moduleEnabled || owners.some((owner) => owner.toLowerCase() === agent.toLowerCase())
    || `0x${txnGuard.slice(-40)}` !== expected || `0x${moduleGuard.slice(-40)}` !== expected) {
    throw new Error("The Safe must enforce both guards and keep the Agent outside its owners.");
  }
  return guard;
}
