import { createHash, timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit";

export function agentAccess(hashes, { limit = 30, auditLimit = 60, windowMs = 60_000 } = {}) {
  const configured = hashes.map((hash) => {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid ProofGuard API key hash");
    return Buffer.from(hash, "hex");
  });
  function authenticate(req, res, next) {
    const match = /^Bearer ([A-Za-z0-9_\-.~]{16,256})$/i.exec(req.get("Authorization") || "");
    if (match) {
      const digest = createHash("sha256").update(match[1], "utf8").digest();
      if (configured.some((hash) => timingSafeEqual(hash, digest))) {
        req.keyFingerprint = digest.toString("hex");
        next();
        return;
      }
    }
    res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "A valid ProofGuard API key is required." });
  }
  const limitPerKey = (maxRequests, error) => rateLimit({ windowMs, limit: maxRequests, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (req) => req.keyFingerprint, message: { error } });
  return {
    authenticate,
    throttle: limitPerKey(limit, "ProofGuard review rate limit exceeded."),
    auditThrottle: limitPerKey(auditLimit, "ProofGuard audit rate limit exceeded."),
  };
}
