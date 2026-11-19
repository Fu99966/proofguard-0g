import "dotenv/config";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Wallet, formatEther, formatUnits, parseEther } from "ethers";
import { guardedSafeSigner } from "../sdk/guard.js";
import { createProofGuardClient } from "../sdk/index.js";
import { baseSepolia } from "../sdk/network.js";
import { createApp } from "../server/index.js";
import { chainlinkMarket, rpcProvider } from "../server/market.js";
import { readRouterRequestsUsed } from "../server/reviewStore.js";
import { getZeroGConfig } from "../server/zeroGAdapter.js";
import { verifyAgentRun } from "../examples/rebalancer/verify-run.js";

const options = process.argv.slice(2);
if (options.some((option) => option !== "--start")) throw new Error("Use --start to begin the funded testnet acceptance run.");
const start = options.includes("--start");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "var/testnet-acceptance");
const routerRequestLimit = 12;
const rpc = process.env.PROOFGUARD_RPC_URL || "https://base-sepolia-rpc.publicnode.com";
const ethFeed = process.env.PROOFGUARD_ETH_USD_FEED || baseSepolia.ethUsdFeed;
const usdcFeed = process.env.PROOFGUARD_USDC_USD_FEED || undefined;
const keys = JSON.parse(await readFile(join(directory, "wallets.json"), "utf8"));
const provider = rpcProvider(rpc);
const owner = new Wallet(keys.owner, provider);
const agent = new Wallet(keys.agent, provider);
const issuer = new Wallet(keys.issuer);
const database = join(directory, "reviews.sqlite");
const routerBudgetId = `base-sepolia-acceptance:${owner.address}`;
// A fresh passing run needs one reviewed rebalance and one reviewed recipient rejection.
const minimumRouterRequests = 2 * getZeroGConfig().models.length;
const token = new Contract(baseSepolia.usdc, ["function balanceOf(address) view returns(uint256)"], provider);

async function readDeployment() {
  try {
    const state = JSON.parse(await readFile(join(directory, "deployment.json"), "utf8"));
    if (state.chainId !== baseSepolia.chainId || state.owner !== owner.address) throw new Error("Testnet deployment is for a different owner or network.");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function runChild(script, args, env) {
  const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, env, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const [code, signal] = await once(child, "exit");
    if (code !== 0) throw new Error(`${script} stopped with ${signal ?? `exit code ${code}`}.`);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

try {
  if ((await provider.getNetwork()).chainId !== BigInt(baseSepolia.chainId)) throw new Error("Acceptance is restricted to Base Sepolia.");
  const [eth, usdc, existing] = await Promise.all([provider.getBalance(owner.address), token.balanceOf(owner.address), readDeployment()]);
  const routerRequestsUsed = readRouterRequestsUsed(database, routerBudgetId);
  const routerRequestsRemaining = Math.max(0, routerRequestLimit - routerRequestsUsed);
  console.log(JSON.stringify({ owner: owner.address, ownerTestEth: formatEther(eth), ownerTestUsdc: formatUnits(usdc, 6),
    safe: existing?.safe ?? null, guard: existing?.guard ?? null,
    routerRequestLimit, routerRequestsUsed, routerRequestsRemaining, minimumRouterRequests }, null, 2));
  if (start) {
    if (routerRequestsRemaining < minimumRouterRequests) {
      throw new Error(`The acceptance run needs at least ${minimumRouterRequests} Router requests. ${routerRequestsRemaining} remain in the authorized budget.`);
    }
    process.env.ZERO_G_FORCE_DEMO = "false";
    if (getZeroGConfig().mode !== "live") throw new Error("The private 0G two-model committee must be configured before starting.");

    let deployment = existing;
    const seeded = deployment?.safe && await token.balanceOf(deployment.safe) > 0n;
    if (!deployment?.noPermitReverts || !seeded) {
      if ((!seeded && usdc === 0n) || eth < parseEther("0.002")) throw new Error("Base Sepolia test ETH and test USDC are needed to deploy and seed the Safe.");
      await runChild("scripts/deploy-testnet-safe.js", ["--send"], { PATH: process.env.PATH, PROOFGUARD_RPC_URL: rpc });
      deployment = await readDeployment();
    }
    if (!deployment?.noPermitReverts || !deployment.safe || !deployment.guard) throw new Error("A verified Safe Guard deployment is required.");
    const [guard, gasBalance, safeUsdc] = await Promise.all([
      guardedSafeSigner(deployment.guard, agent, deployment.safe), provider.getBalance(agent.address), token.balanceOf(deployment.safe),
    ]);
    if (await guard.issuer() !== issuer.address) throw new Error("The testnet Guard has a different Permit issuer.");
    if (gasBalance === 0n || safeUsdc === 0n) throw new Error("Fund both the Agent and the Safe before starting observation.");

    const apiKey = randomBytes(32).toString("hex");
    const journal = join(directory, `observation-${randomBytes(8).toString("hex")}.jsonl`);
    const app = createApp({ owner: owner.address, wallet: deployment.safe, guardAddress: deployment.guard, issuerKey: keys.issuer,
      keyHashes: [createHash("sha256").update(apiKey).digest("hex")], marketFor: chainlinkMarket({ rpc, ethFeed, usdcFeed }),
      database, routerBudgetLimit: routerRequestLimit, routerBudgetId });
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      await runChild("examples/rebalancer/run.js", ["--send", "--observe-24h"], {
        PATH: process.env.PATH,
        DOTENV_CONFIG_PATH: join(directory, "agent.env"),
        PROOFGUARD_RPC_URL: rpc, PROOFGUARD_SIMULATION_RPC_URL: process.env.PROOFGUARD_SIMULATION_RPC_URL || rpc,
        PROOFGUARD_ETH_USD_FEED: ethFeed, ...(usdcFeed && { PROOFGUARD_USDC_USD_FEED: usdcFeed }),
        PROOFGUARD_AGENT_WALLET: deployment.safe, PROOFGUARD_TESTNET_GUARD_ADDRESS: deployment.guard,
        PROOFGUARD_TESTNET_AGENT_KEY: keys.agent, PROOFGUARD_AGENT_API_KEY: apiKey, PROOFGUARD_API_URL: apiUrl, PROOFGUARD_AGENT_LOG: journal,
      });
      const entries = (await readFile(journal, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const client = createProofGuardClient({ apiUrl, apiKey });
      const result = await verifyAgentRun(entries, { provider, readAudit: client.audit });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      app.locals.closeReviewStore();
    }
  }
} finally {
  provider.destroy();
}
