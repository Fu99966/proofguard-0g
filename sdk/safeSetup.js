import { Contract, ContractFactory, Interface, ZeroAddress, getAddress, getCreate2Address, id, keccak256, solidityPacked, zeroPadValue } from "ethers";

const singleton = "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e";
const factoryAddress = "0x14F2982D601c9458F93bd70B218933A6f8165e7b";
const safeAbi = new Interface([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function setGuard(address guard)", "function setModuleGuard(address guard)", "function enableModule(address module)",
  "function isModuleEnabled(address module) view returns(bool)", "function getOwners() view returns(address[])",
  "function getThreshold() view returns(uint256)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)",
]);

export async function setupSafe({ owner, agent, issuer, artifact, saltNonce, knownGuard, onDeployed = () => {} }) {
  const provider = owner.provider;
  if ((await provider.getNetwork()).chainId !== 84532n) throw new Error("Safe setup is restricted to Base Sepolia.");
  if (keccak256(await provider.getCode(singleton)) !== "0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc"
    || keccak256(await provider.getCode(factoryAddress)) !== "0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529") {
    throw new Error("Canonical Safe 1.5.0 deployment code hash mismatch.");
  }
  const factory = new Contract(factoryAddress, [
    "function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns(address proxy)",
    "function proxyCreationCode() view returns(bytes data)",
  ], owner);
  const ownerAddress = await owner.getAddress();
  const initializer = safeAbi.encodeFunctionData("setup", [[ownerAddress], 1, ZeroAddress, "0x", ZeroAddress, ZeroAddress, 0, ZeroAddress]);
  const salt = keccak256(solidityPacked(["bytes32", "uint256"], [keccak256(initializer), saltNonce]));
  const initCode = solidityPacked(["bytes", "bytes32"], [await factory.proxyCreationCode(), zeroPadValue(singleton, 32)]);
  const safe = getCreate2Address(factoryAddress, salt, keccak256(initCode));
  if (await provider.getCode(safe) === "0x") await (await factory.createProxyWithNonce(singleton, initializer, saltNonce)).wait();
  const account = new Contract(safe, safeAbi, owner);
  const owners = await account.getOwners();
  if (owners.length !== 1 || owners[0] !== ownerAddress || await account.getThreshold() !== 1n) throw new Error("Unexpected Safe owners or threshold.");

  let guard;
  if (knownGuard) {
    guard = new Contract(knownGuard, artifact.abi, owner);
    if (await guard.safe() !== safe || await guard.agent() !== getAddress(agent) || await guard.issuer() !== getAddress(issuer)) {
      throw new Error("The existing guard does not match this Safe and its roles.");
    }
  } else {
    guard = await new ContractFactory(artifact.abi, artifact.bytecode.object, owner).deploy(safe, agent, issuer);
    await guard.waitForDeployment();
    await onDeployed({ safe, guard: await guard.getAddress() });
  }
  const guardAddress = await guard.getAddress();
  const ownerSignature = `0x${ownerAddress.slice(2).padStart(64, "0")}${"0".repeat(64)}01`;
  const ownerArgs = (to, data) => [to, 0, data, 0, 0, 0, 0, ZeroAddress, ZeroAddress, ownerSignature];
  const change = async (name) => {
    const data = safeAbi.encodeFunctionData(name, [guardAddress]);
    const mined = await (await account.execTransaction(...ownerArgs(safe, data))).wait();
    if (mined.status !== 1) throw new Error(`Safe setup failed at ${name}.`);
  };
  const active = async (slot) => getAddress(`0x${(await provider.getStorage(safe, id(slot))).slice(-40)}`);
  const txSlot = "guard_manager.guard.address";
  const moduleSlot = "module_manager.module_guard.address";
  const [txGuard, moduleGuard] = await Promise.all([active(txSlot), active(moduleSlot)]);
  if ([txGuard, moduleGuard].some((item) => item !== ZeroAddress && item !== guardAddress)) {
    throw new Error("The Safe is already bound to another guard.");
  }
  if (!await account.isModuleEnabled(guardAddress)) await change("enableModule");
  if (moduleGuard !== guardAddress) await change("setModuleGuard");
  if (txGuard !== guardAddress) await change("setGuard");
  return { account, ownerArgs, guard, guardAddress, safe };
}
