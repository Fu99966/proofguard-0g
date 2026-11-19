import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { openReviewStore, readRouterRequestsUsed } from "../server/reviewStore.js";
import { getZeroGConfig } from "../server/zeroGAdapter.js";
import { verifyAgentRun } from "../examples/rebalancer/verify-run.js";
import { planShortAcceptance } from "../examples/rebalancer/short-acceptance.js";

const options = process.argv.slice(2);
if (options.length > 1 || options.some((option) => !["--start", "--short"].includes(option))) {
  throw new Error("Use --short for the approved short run or --start for the separately authorized 24-hour run.");
}
const short = options.includes("--short");
const start = short || options.includes("--start");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "var/testnet-acceptance");
const routerRequestLimit = short ? 18 : 12;
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
const minimumRouterRequests = (short ? 3 : 2) * getZeroGConfig().models.length;
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

function cleanCommit() {
  const options = { cwd: root, encoding: "utf8" };
  if (execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], options).trim()) {
    throw new Error("Commit the acceptance worktree before opening the Router.");
  }
  return execFileSync("git", ["rev-parse", "HEAD"], options).trim();
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
    if (short && routerRequestsUsed !== 10) throw new Error("This one-time short authorization starts at ten existing requests.");
    if (routerRequestsRemaining < minimumRouterRequests) {
      throw new Error(`The acceptance run needs at least ${minimumRouterRequests} Router requests. ${routerRequestsRemaining} remain in the authorized budget.`);
    }
    process.env.ZERO_G_FORCE_DEMO = "false";
    if (getZeroGConfig().mode !== "live") throw new Error("The private 0G two-model committee must be configured before starting.");

    const commit = short ? cleanCommit() : null;
    const runId = short ? randomUUID() : null;
    let deployment = existing;
    const seeded = deployment?.safe && await token.balanceOf(deployment.safe) > 0n;
    if (!deployment?.noPermitReverts || !seeded) {
      if (short) throw new Error("The short run needs the existing verified and funded Safe.");
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
    const journal = join(directory, short ? `short-${runId}.jsonl` : `observation-${randomBytes(8).toString("hex")}.jsonl`);
    const agentEnv = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: join(directory, "agent.env"),
      PROOFGUARD_RPC_URL: rpc, PROOFGUARD_SIMULATION_RPC_URL: process.env.PROOFGUARD_SIMULATION_RPC_URL || rpc,
      PROOFGUARD_ETH_USD_FEED: ethFeed, ...(usdcFeed && { PROOFGUARD_USDC_USD_FEED: usdcFeed }), PROOFGUARD_AGENT_WALLET: deployment.safe };
    let plan;
    if (short) {
      Object.assign(agentEnv, { PROOFGUARD_ACCEPTANCE_COMMIT: commit, PROOFGUARD_ACCEPTANCE_RUN_ID: runId });
      const preflight = join(directory, `short-preflight-${runId}.jsonl`);
      await runChild("examples/rebalancer/run.js", [], { ...agentEnv, PROOFGUARD_AGENT_LOG: preflight });
      const quote = (await readFile(preflight, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find(({ event }) => event === "quote");
      if (!quote || cleanCommit() !== commit) throw new Error("The approved short run requires a fresh quote and the same clean commit.");
      plan = planShortAcceptance(deployment.safe.toLowerCase(), quote, Math.floor(Date.now() / 1000));
      const store = openReviewStore(database);
      try {
        store.recordAcceptanceStart(`base-sepolia-short-18:${owner.address}`, runId, commit, Date.now());
      } finally {
        store.close();
      }
      console.log(JSON.stringify({ event: "short-committed", runId, commit, journal, preflight, routerRequestLimit }));
    }
    const app = createApp({ owner: owner.address, wallet: deployment.safe, guardAddress: deployment.guard, issuerKey: keys.issuer,
      keyHashes: [createHash("sha256").update(apiKey).digest("hex")], marketFor: chainlinkMarket({ rpc, ethFeed, usdcFeed }),
      database, routerBudgetLimit: routerRequestLimit, routerBudgetId,
      ...(plan && { shortAcceptance: { commit, runId, transactions: plan.transactions } }) });
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      await runChild("examples/rebalancer/run.js", ["--send", short ? "--short-acceptance" : "--observe-24h"], {
        ...agentEnv, ...(plan && { PROOFGUARD_SHORT_PLAN: JSON.stringify(plan) }), PROOFGUARD_TESTNET_GUARD_ADDRESS: deployment.guard,
        PROOFGUARD_TESTNET_AGENT_KEY: keys.agent, PROOFGUARD_AGENT_API_KEY: apiKey, PROOFGUARD_API_URL: apiUrl, PROOFGUARD_AGENT_LOG: journal,
      });
      if (short) returnShortResult(await readFile(journal, "utf8"), commit, runId);
      else {
        const entries = (await readFile(journal, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const client = createProofGuardClient({ apiUrl, apiKey });
        const result = await verifyAgentRun(entries, { provider, readAudit: client.audit });
        console.log(JSON.stringify(result, null, 2));
      }
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      app.locals.closeReviewStore();
    }
  }
} finally {
  provider.destroy();
}

function returnShortResult(log, commit, runId) {
  const entries = log.trim().split("\n").map((line) => JSON.parse(line));
  if (entries.at(-1)?.event !== "short-finished" || entries.some((entry) => entry.commit !== commit || entry.runId !== runId)
    || entries.filter(({ event }) => event === "confirmed").length !== 2) throw new Error("The committed short run journal is incomplete.");
  console.log(JSON.stringify({ event: "short-verified", commit, runId, routerRequestsUsed: readRouterRequestsUsed(database, routerBudgetId) }));
}
