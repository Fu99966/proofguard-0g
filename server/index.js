import "dotenv/config";
import cors from "cors";
import express from "express";
import { getAddress, getBytes, verifyMessage } from "ethers";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agent, policy as demoPolicy, scenarios } from "./demoData.js";
import { evaluatePolicy, isTransactionProposal, issuePermit, stableHash } from "./policyEngine.js";
import { getZeroGConfig, reviewWithZeroG, ZeroGReviewError } from "./zeroGAdapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ owner = process.env.PROOFGUARD_OWNER_ADDRESS, now = Date.now } = {}) {
  const policy = { ...demoPolicy, owner: owner ? getAddress(owner) : null };
  const app = express();
  const activePermits = new Map();

  app.use(cors());
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

  app.post("/api/review", async (req, res, next) => {
    try {
      const scenario = scenarios.find((item) => item.id === req.body?.scenarioId);
      const hasTransaction = Object.hasOwn(req.body ?? {}, "transaction");
      const transaction = hasTransaction ? req.body.transaction : scenario?.transaction;
      if (!isTransactionProposal(transaction)) {
        res.status(400).json({ error: "Provide a valid transaction proposal or scenarioId." });
        return;
      }

      const deterministic = evaluatePolicy(transaction, policy);
      const inference = await reviewWithZeroG({ transaction, policy, deterministic });
      const permit = issuePermit({ transaction, policy, inference, deterministic, now: now() });
      for (const [hash, entry] of activePermits) {
        if (Date.parse(entry.permit.expiresAt) <= now()) activePermits.delete(hash);
      }
      if (permit?.owner) activePermits.set(permit.permitHash, { permit, used: false });

      res.json({
        decision: permit ? "ALLOW" : "BLOCK",
        transaction,
        deterministic,
        inference,
        permit,
        evidence: {
          transactionHash: stableHash(transaction),
          policyHash: stableHash(policy),
          responseCommitment: stableHash(inference.rawDecision),
        },
      });
    } catch (error) {
      if (error instanceof ZeroGReviewError) {
        res.status(error.status).json({ decision: "BLOCK", permit: null, error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post("/api/execute", (req, res) => {
    try {
      const { permitHash, transaction, signature } = req.body || {};
      if (!policy.owner) throw new Error("Set PROOFGUARD_OWNER_ADDRESS to enable simulated execution.");
      const stored = activePermits.get(permitHash);
      if (!stored) throw new Error("Unknown or blocked permit");
      if (stored.used) throw new Error("Permit nonce already consumed");
      if (Date.parse(stored.permit.expiresAt) <= now()) throw new Error("Permit expired");
      if (!isTransactionProposal(transaction) || stableHash(transaction) !== stored.permit.transactionHash) throw new Error("Transaction commitment mismatch");
      let recovered;
      try {
        recovered = verifyMessage(getBytes(permitHash), signature);
      } catch {
        throw new Error("Invalid permit signature.");
      }
      if (recovered !== stored.permit.owner) throw new Error("Owner signature mismatch");

      stored.used = true;
      const txHash = stableHash({ permitHash, owner: recovered, executedAt: new Date(now()).toISOString() });
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
