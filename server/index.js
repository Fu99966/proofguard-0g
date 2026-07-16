import "dotenv/config";
import cors from "cors";
import express from "express";
import { getBytes, verifyMessage } from "ethers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agent, policy, scenarios } from "./demoData.js";
import { evaluatePolicy, issuePermit, stableHash } from "./policyEngine.js";
import { getZeroGConfig, getZeroGMode, reviewWithZeroG } from "./zeroGAdapter.js";

const app = express();
const port = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const activePermits = new Map();

app.use(cors());
app.use(express.json({ limit: "64kb" }));

app.get("/api/health", (_req, res) => {
  const zeroG = getZeroGConfig();
  res.json({
    ok: true,
    service: "proofguard",
    ...zeroG,
    submissionReady: zeroG.mode === "live",
  });
});

app.get("/api/demo", (_req, res) => {
  const zeroG = getZeroGConfig();
  res.json({
    status: {
      ...zeroG,
      network: "0G Private Computer",
      model: zeroG.models[0],
      submissionReady: zeroG.mode === "live",
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
    const transaction = req.body?.transaction || scenario?.transaction;
    if (!transaction || typeof transaction !== "object") {
      res.status(400).json({ error: "A transaction or valid scenarioId is required." });
      return;
    }

    const deterministic = evaluatePolicy(transaction, policy);
    const inference = await reviewWithZeroG({ transaction, policy, deterministic });
    const permit = issuePermit({ transaction, policy, inference, deterministic });
    if (permit.enforceable) activePermits.set(permit.permitHash, { permit, transaction, used: false });

    res.json({
      decision: permit.decision,
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
    next(error);
  }
});

app.post("/api/execute", (req, res) => {
  try {
    const { permitHash, transaction, owner, signature } = req.body || {};
    const stored = activePermits.get(permitHash);
    if (!stored) throw new Error("Unknown or blocked permit");
    if (stored.used) throw new Error("Permit nonce already consumed");
    if (Date.parse(stored.permit.expiresAt) <= Date.now()) throw new Error("Permit expired");
    if (stableHash(transaction) !== stored.permit.transactionHash) throw new Error("Transaction commitment mismatch");
    const recovered = verifyMessage(getBytes(permitHash), signature);
    if (recovered.toLowerCase() !== String(owner).toLowerCase()) throw new Error("Owner signature mismatch");

    stored.used = true;
    const txHash = stableHash({ permitHash, transaction, owner, executedAt: new Date().toISOString() });
    res.json({
      status: "simulated",
      txHash,
      network: "Base execution adapter",
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
  const actualHash = stableHash(value);
  res.json({ valid: actualHash === expectedHash, expectedHash, actualHash });
});

const distPath = path.resolve(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*splat", (_req, res) => res.sendFile(path.join(distPath, "index.html")));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Unexpected server error" });
});

app.listen(port, () => {
  console.log(`ProofGuard listening on http://localhost:${port} (${getZeroGMode()} mode)`);
});

