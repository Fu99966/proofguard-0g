import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Contract, NonceManager, Wallet, formatEther, parseEther } from "ethers";
import { chainlinkMarket, rpcProvider } from "../server/market.js";
import { baseSepolia } from "../sdk/network.js";
import { setupSafe } from "../sdk/safeSetup.js";
import { guardedSafeSigner } from "../sdk/guard.js";

const folder = "var/testnet-acceptance";
const file = `${folder}/deployment.json`;
const keys = JSON.parse(readFileSync(`${folder}/wallets.json`, "utf8"));
const provider = rpcProvider(process.env.PROOFGUARD_RPC_URL || "https://base-sepolia-rpc.publicnode.com");
if ((await provider.getNetwork()).chainId !== BigInt(baseSepolia.chainId)) throw new Error("Base Sepolia only.");
const ownerWallet = new Wallet(keys.owner, provider);
const owner = new NonceManager(ownerWallet);
const agent = new Wallet(keys.agent, provider);
const issuer = new Wallet(keys.issuer).address;
const balance = await provider.getBalance(ownerWallet.address);
let state;
try {
  state = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  state = { chainId: baseSepolia.chainId, salt: String(Date.now()), owner: ownerWallet.address };
}
if (state.chainId !== baseSepolia.chainId || state.owner !== ownerWallet.address) throw new Error("Deployment record is for a different owner or network.");
if (!process.argv.includes("--send")) {
  console.log(JSON.stringify({ owner: ownerWallet.address, agent: agent.address, issuer,
    ownerTestEth: formatEther(balance), safe: state.safe || null, guard: state.guard || null }, null, 2));
  process.exit(0);
}
if (balance < parseEther("0.002")) throw new Error("The isolated Safe owner needs Base Sepolia test ETH for deployment.");
function save(update) {
  Object.assign(state, update);
  writeFileSync(`${file}.new`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.new`, file);
}
save({});
const artifact = JSON.parse(readFileSync(new URL("../contracts/out/ProofGuardSafe.sol/ProofGuardSafe.json", import.meta.url), "utf8"));
const { safe, guardAddress, account, ownerArgs, guard } = await setupSafe({ owner, agent: agent.address, issuer, artifact,
  saltNonce: BigInt(state.salt), knownGuard: state.guard, onDeployed: save });
await guardedSafeSigner(guardAddress, agent, safe);
try {
  await account.execTransaction.staticCall(...ownerArgs(ownerWallet.address, "0x"));
  throw new Error("The public testnet Safe accepted a transaction without a Permit.");
} catch (error) {
  if (error.data?.slice(0, 10) !== guard.interface.getError("MissingPermit").selector) throw error;
}
const gasTopUp = parseEther("0.001");
if (await provider.getBalance(agent.address) < gasTopUp) {
  await (await owner.sendTransaction({ to: agent.address, value: gasTopUp })).wait();
}
const usdc = new Contract(baseSepolia.usdc, ["function balanceOf(address owner) view returns(uint256)",
  "function transfer(address to,uint256 amount) returns(bool)"], owner);
const usdcFunding = await usdc.balanceOf(ownerWallet.address);
if (usdcFunding > 0n) {
  const market = await chainlinkMarket({ rpc: process.env.PROOFGUARD_RPC_URL || "https://base-sepolia-rpc.publicnode.com" })({
    tx: { chainId: baseSepolia.chainId },
  });
  if (!market) throw new Error("A trusted testnet price is required to seed the starting portfolio.");
  const [currentEth, currentUsdc] = await Promise.all([provider.getBalance(safe), usdc.balanceOf(safe)]);
  const safeEthTarget = (usdcFunding + currentUsdc) * 3n * 10n ** 18n / (7n * BigInt(market.usdMicros[baseSepolia.weth]));
  if (currentEth < safeEthTarget) {
    const funding = safeEthTarget - currentEth;
    if (await provider.getBalance(ownerWallet.address) < funding + parseEther("0.0003")) throw new Error("Testnet ETH seed balance is too low.");
    await (await owner.sendTransaction({ to: safe, value: funding })).wait();
  }
  await (await usdc.transfer(safe, usdcFunding)).wait();
}
save({ safe, guard: guardAddress, noPermitReverts: true });
console.log(JSON.stringify({ ...state, agent: agent.address, issuer }, null, 2));
