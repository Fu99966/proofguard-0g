import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Contract, Wallet, formatEther, formatUnits } from "ethers";
import { baseSepolia } from "../sdk/network.js";
import { rpcProvider } from "../server/market.js";
import { readRouterRequestsUsed } from "../server/reviewStore.js";

if (process.argv.length > 2) {
  throw new Error("The short ledger is closed. The two-hour run and 24-hour read-only sampler use their own launchers.");
}

const directory = new URL("../var/testnet-acceptance/", import.meta.url);
const deployed = JSON.parse(await readFile(new URL("deployment.json", directory), "utf8"));
const keys = JSON.parse(await readFile(new URL("wallets.json", directory), "utf8"));
const owner = new Wallet(keys.owner).address;
const provider = rpcProvider(process.env.PROOFGUARD_RPC_URL || "https://base-sepolia-rpc.publicnode.com");
try {
  if ((await provider.getNetwork()).chainId !== BigInt(baseSepolia.chainId)) throw new Error("Base Sepolia is required.");
  const token = new Contract(baseSepolia.usdc, ["function balanceOf(address) view returns(uint256)"], provider);
  const [eth, usdc] = await Promise.all([provider.getBalance(owner), token.balanceOf(owner)]);
  console.log(JSON.stringify({ owner, ownerTestEth: formatEther(eth), ownerTestUsdc: formatUnits(usdc, 6),
    safe: deployed.safe, guard: deployed.guard, routerRequestsUsed: readRouterRequestsUsed(fileURLToPath(new URL("reviews.sqlite", directory)),
      `base-sepolia-acceptance:${owner}`), formerRouterRequestLimit: 18, remainingAuthorizedRequests: 0, shortLedger: "closed" }, null, 2));
} finally {
  provider.destroy();
}
