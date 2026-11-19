import "dotenv/config";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { getAddress, Wallet } from "ethers";
import { permitTypedData, recoverPermitSigner } from "../sdk/permit.js";
import { agentAccess } from "./access.js";
import { openReviewStore } from "./reviewStore.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agent, demoMarket, policy as demoPolicy, scenarios, testnetPolicy } from "./demoData.js";
import { evaluatePolicy, isTransactionProposal, issuePermit, stableHash } from "./policyEngine.js";
import { decodeTransaction } from "./decoder.js";
import { chainlinkMarket } from "./market.js";
import { getZeroGConfig, reviewWithZeroG, ZeroGReviewError } from "./zeroGAdapter.js";
import { approvalWindowSeconds } from "../examples/rebalancer/short-acceptance.js";
import { hasVerifiedReviewers } from "../examples/rebalancer/rejection.js";
import { LiveBudgetError, openLiveBudget } from "./liveAcceptanceBudget.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ owner = process.env.PROOFGUARD_OWNER_ADDRESS, now = Date.now,
  marketFor = chainlinkMarket({ rpc: process.env.PROOFGUARD_RPC_URL, ethFeed: process.env.PROOFGUARD_ETH_USD_FEED,
    usdcFeed: process.env.PROOFGUARD_USDC_USD_FEED, now }), wallet = process.env.PROOFGUARD_AGENT_WALLET,
  keyHashes = (process.env.PROOFGUARD_API_KEY_HASHES || "").split(",").map((hash) => hash.trim()).filter(Boolean),
  frontendOrigins = (process.env.PROOFGUARD_FRONTEND_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean),
  issuerKey = process.env.PROOFGUARD_TESTNET_ISSUER_KEY, guardAddress = process.env.PROOFGUARD_TESTNET_GUARD_ADDRESS,
  routerBudgetLimit = process.env.PROOFGUARD_ROUTER_REQUEST_LIMIT, routerBudgetId = process.env.PROOFGUARD_ROUTER_BUDGET_ID,
  rateOptions, shortAcceptance, liveAcceptance, database = process.env.PROOFGUARD_DATABASE_PATH || "var/proofguard.sqlite" } = {}) {
  const policy = { ...demoPolicy, owner: owner ? getAddress(owner) : null };
  const livePolicy = testnetPolicy(policy.owner, wallet ? getAddress(wallet).toLowerCase() : null);
  const shortHashes = shortAcceptance?.transactions.map(stableHash);
  let shortStep = 0;
  let shortHalted = false;
  let shortReviewActive = false;
  const issuer = issuerKey && guardAddress ? new Wallet(issuerKey) : null;
  const verifyingContract = issuer ? getAddress(guardAddress) : null;
  const requestLimit = routerBudgetLimit === undefined || routerBudgetLimit === "" ? null : Number(routerBudgetLimit);
  if (requestLimit !== null && (!Number.isSafeInteger(requestLimit) || requestLimit < 0 || !routerBudgetId?.trim())) {
    throw new Error("Set a nonnegative Router request cap with its persistent budget ID.");
  }
  const app = express();
  const { authenticate, throttle } = agentAccess(keyHashes, rateOptions);
  const store = openReviewStore(database);
  const liveBudget = liveAcceptance ? openLiveBudget(database) : null;
  app.locals.closeReviewStore = () => {
    liveBudget?.close();
    store.close();
  };

  app.use("/api", (req, res, next) => {
    const origin = req.get("Origin");
    if (origin && !frontendOrigins.includes(origin) && origin !== `${req.protocol}://${req.get("Host")}`) {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    next();
  });
  app.use("/api", cors({ origin: (origin, callback) => callback(null, Boolean(origin)),
    methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type"] }));
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/health", (_req, res) => {
    const zeroG = getZeroGConfig();
    res.json({
      ok: true,
      service: "proofguard",
      ...zeroG,
      executionConfigured: Boolean(policy.owner),
    });
  });

  app.get("/api/demo", (_req, res) => {
    const zeroG = getZeroGConfig();
    res.json({
      status: {
        ...zeroG,
        mode: "demo",
        agentReviewMode: zeroG.mode,
        network: "0G Private Computer",
        model: zeroG.models[0],
        executionConfigured: Boolean(policy.owner),
      },
      agent,
      policy,
      policyHash: stableHash(policy),
      scenarios,
    });
  });

  async function review(req, res, next, publicDemo) {
    const scenario = scenarios.find((item) => item.id === req.body?.scenarioId);
    const hasTransaction = !publicDemo && Object.hasOwn(req.body ?? {}, "transaction");
    const transaction = hasTransaction ? req.body.transaction : scenario?.transaction;
    if (!isTransactionProposal(transaction)) {
      res.status(400).json({ error: "Provide a valid EVM transaction proposal or scenarioId." });
      return;
    }

    const transactionHash = stableHash(transaction);
    const isShort = Boolean(shortAcceptance && !publicDemo);
    const isLiveAcceptance = Boolean(liveBudget && !publicDemo);
    let reserved = false;
    if (isShort && (shortHalted || shortReviewActive || shortHashes[shortStep] !== transactionHash)) {
      shortHalted = true;
      return res.status(409).json({ decision: "BLOCK", permit: null, error: "The committed short acceptance is stopped or out of order." });
    }
    if (isShort) shortReviewActive = true;
    const shortEvidence = isShort ? { acceptance: { commit: shortAcceptance.commit, runId: shortAcceptance.runId, step: shortStep + 1, memo: transaction.memo } } : {};
    const reviewPolicy = isShort && shortStep === 0 ? { ...livePolicy, shortPermit2ApprovalSeconds: approvalWindowSeconds,
      mandate: `${livePolicy.mandate} For this operator-approved Base Sepolia acceptance renewal only, the exact allowance for the planned swap may last 48 hours plus up to ten minutes for settlement. The approved scope is the registered Permit2 contract and registered testnet router.` }
      : hasTransaction ? livePolicy : policy;
    const policyHash = stableHash(reviewPolicy);
    let deterministic;
    try {
      let decoded;
      try {
        decoded = decodeTransaction(transaction, reviewPolicy);
      } catch {
        // The policy records decode failures as a BLOCK with an explanation.
      }
      const recognized = decoded && livePolicy.agentWallet === decoded.tx.from && livePolicy.allowedChains.includes(decoded.tx.chainId);
      const market = hasTransaction ? (recognized ? await marketFor(decoded) : null) : demoMarket;
      deterministic = evaluatePolicy(transaction, reviewPolicy, { market, now: now(), decoded });
      if (isShort && (getZeroGConfig().mode !== "live" || (shortStep < 2 ? !deterministic.passed : !deterministic.blockers.includes("recipient")))) {
        shortHalted = true;
        store.record(transactionHash, { decision: "BLOCK", deterministic, policyHash, ...shortEvidence, permit: null }, null, now());
        return res.status(409).json({ decision: "BLOCK", permit: null, error: "The short acceptance failed deterministic preflight." });
      }
      if (!publicDemo && requestLimit !== null && getZeroGConfig().mode === "live"
        && !store.reserveRouterRequests(routerBudgetId, 2, requestLimit)) {
        if (isShort) shortHalted = true;
        store.record(transactionHash, { decision: "BLOCK", deterministic, policyHash, ...shortEvidence, inferenceError: "Router budget exhausted", permit: null }, null, now());
        res.status(429).json({ error: "Router budget exhausted for this run.", code: "ROUTER_BUDGET_EXHAUSTED", decision: "BLOCK", permit: null });
        return;
      }
      let reservation;
      if (isLiveAcceptance) {
        if (getZeroGConfig().mode !== "live" || !issuer || !hasTransaction) throw new LiveBudgetError("Only configured live testnet proposals are permitted.");
        const bounds = liveAcceptance.bounds;
        if (getZeroGConfig().models.some((model, index) => model !== bounds[index].model)) {
          throw new LiveBudgetError("Router model configuration changed after preflight.");
        }
        liveBudget.reserve(transactionHash, bounds, liveAcceptance.usdLimit());
        reserved = true;
        reservation = { bounds, settle: (model, charge) => liveBudget.settle(transactionHash, model, charge) };
      }
      const inference = await reviewWithZeroG({ transaction, policy: reviewPolicy, deterministic, forceDemo: publicDemo, reservation });
      const verified = !(isShort || isLiveAcceptance) || hasVerifiedReviewers(inference.committee.map(({ role, model, decision, receipt }) => ({
        role, model, decision, requestId: receipt.requestId, verification: receipt.verification,
      })));
      const permit = verified ? issuePermit({ transaction, policy: reviewPolicy, inference, deterministic, now: now() }) : null;
      const evidence = { transactionHash, policyHash, responseCommitment: stableHash(inference.rawDecision) };
      let onchainPermit;
      if (permit && issuer && hasTransaction && inference.mode === "live") {
        const { domain, types, message } = permitTypedData(permit, transaction, verifyingContract);
        onchainPermit = { verifyingContract, issuer: issuer.address, signature: await issuer.signTypedData(domain, types, message) };
      }
      const response = { decision: permit ? "ALLOW" : "BLOCK", transaction, deterministic, inference, permit, evidence, onchainPermit };
      if (!publicDemo || permit?.owner) store.record(transactionHash, {
        decision: response.decision, deterministic, evidence, ...shortEvidence,
        reviews: inference.committee.map(({ role, model, decision, receipt, summary, threats, charge }) => ({
          role, model, decision, requestId: receipt.requestId ?? null, verification: receipt.verification,
          ...(charge && { charge }),
          ...((isShort || response.decision === "BLOCK") && {
            summary: summary.slice(0, 400),
            threats: threats.slice(0, 3).map((threat) => threat.slice(0, 160)),
          }),
        })),
        permit, onchainPermit: onchainPermit ? { verifyingContract, issuer: issuer.address } : null,
      }, permit, now());
      if (isShort) {
        if (verified && (shortStep < 2 ? Boolean(onchainPermit) : !permit)) shortStep++;
        else shortHalted = true;
      }
      res.json(response);
    } catch (error) {
      if (isShort) shortHalted = true;
      const stoppedLive = isLiveAcceptance && (reserved || error.code === "LIVE_BUDGET_INTEGRITY");
      if (stoppedLive) liveBudget.stop(error.message);
      if (error instanceof ZeroGReviewError || error instanceof LiveBudgetError) {
        try {
          if (!publicDemo) store.record(transactionHash, {
            decision: "BLOCK", deterministic, policyHash, ...shortEvidence, inferenceError: error.message, permit: null,
          }, null, now());
        } catch (storageError) {
          next(storageError);
          return;
        }
        res.status(error.status).json({ decision: "BLOCK", permit: null, error: error.message,
          ...(stoppedLive ? { code: "LIVE_BUDGET_INTEGRITY" } : error.code && { code: error.code }) });
        return;
      }
      next(error);
    } finally {
      if (isShort) shortReviewActive = false;
    }
  }

  app.post("/api/review", authenticate, throttle, (req, res, next) => review(req, res, next, false));
  app.post("/api/demo/review", rateLimit({ windowMs: 60_000, limit: 30 }), (req, res, next) => review(req, res, next, true));
  app.get("/api/audit/:hash", authenticate, (req, res) => {
    const audit = store.getAudit(req.params.hash);
    if (!audit) return res.status(404).json({ error: "Unknown permit." });
    return res.json(audit);
  });

  app.post("/api/execute", (req, res) => {
    try {
      const { permitHash, transaction, signature } = req.body || {};
      if (!policy.owner) throw new Error("Set PROOFGUARD_OWNER_ADDRESS to enable simulated execution.");
      if (typeof permitHash !== "string" || !/^0x[\da-f]{64}$/.test(permitHash)) throw new Error("Invalid permit hash");
      const stored = store.getPermit(permitHash);
      if (!stored || stored.permit.owner !== policy.owner) throw new Error("Unknown or blocked permit");
      if (stored.used) throw new Error("Permit nonce already consumed");
      if (Date.parse(stored.permit.expiresAt) <= now()) throw new Error("Permit expired");
      if (!isTransactionProposal(transaction) || stableHash(transaction) !== stored.permit.transactionHash) throw new Error("Transaction commitment mismatch");
      let recovered;
      try {
        recovered = recoverPermitSigner(stored.permit, transaction, signature);
      } catch {
        throw new Error("Invalid permit signature.");
      }
      if (recovered !== stored.permit.owner) throw new Error("Owner signature mismatch");

      const consumedAt = now();
      if (!store.consume(permitHash, consumedAt)) throw new Error("Permit is no longer available");
      const txHash = stableHash({ permitHash, owner: recovered, executedAt: new Date(consumedAt).toISOString() });
      res.json({
        status: "simulated",
        txHash,
        network: "ProofGuard simulation",
        owner: recovered,
        permitHash,
        note: "Signature and one-time permit verified. Demo adapter does not broadcast or move funds.",
      });
    } catch (error) {
      res.status(422).json({ error: error.message });
    }
  });

  app.post("/api/verify-commitment", (req, res) => {
    const { value, expectedHash } = req.body || {};
    if (value === undefined || typeof expectedHash !== "string" || !/^0x[0-9a-f]{64}$/.test(expectedHash)) {
      res.status(400).json({ error: "A JSON value and SHA-256 commitment are required." });
      return;
    }
    const actualHash = stableHash(value);
    res.json({ valid: actualHash === expectedHash, expectedHash, actualHash });
  });

  const distPath = path.resolve(__dirname, "..", "dist");
  app.use(express.static(distPath));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API endpoint." }));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(distPath, "index.html")));

  app.use((error, _req, res, _next) => {
    if (error.status === 400 || error.status === 413) {
      res.status(error.status).json({ error: "Invalid or oversized JSON request." });
      return;
    }
    console.error(error.name);
    res.status(500).json({ error: "Unexpected server error." });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8787);
  createApp().listen(port, () => {
    console.log(`ProofGuard listening on http://localhost:${port} (${getZeroGConfig().mode} mode)`);
  });
}
