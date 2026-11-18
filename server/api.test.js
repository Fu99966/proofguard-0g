import { createHash } from "node:crypto";
import { once } from "node:events";
import { getBytes, Wallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

const allow = JSON.stringify({ decision: "ALLOW", riskScore: 8, summary: "Within policy", threats: [], confidence: 0.95 });
const router = "https://router-api.0g.ai/v1/chat/completions";
const signer = Wallet.createRandom();

describe("ProofGuard HTTP API", () => {
  let server;
  let base;
  let clock;

  beforeEach(async () => {
    for (const name of ["API_KEY", "FORCE_DEMO", "BASE_URL", "MODEL", "CRITIC_MODEL", "TRUST_MODE", "ENABLE_COMMITTEE"]) {
      vi.stubEnv(`ZERO_G_${name}`, undefined);
    }
    clock = Date.now();
    server = createApp({ owner: signer.address, now: () => clock }).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const request = async (path, body) => {
    const response = await fetch(`${base}/api/${path}`, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  async function signedPermit() {
    const { data } = await request("review", { scenarioId: "safe-swap" });
    const { transaction, permit } = data;
    expect(permit.owner).toBe(signer.address);
    return { transaction, permitHash: permit.permitHash, signature: await signer.signMessage(getBytes(permit.permitHash)) };
  }

  it("issues one demo permit across the four scenarios and matches independent commitment vectors", async () => {
    const { data: { policy, scenarios } } = await request("demo");
    function normalize(value) {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, normalize(v)]));
      }
      return value;
    }
    const sha = (value) => `0x${createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex")}`;
    for (const scenario of scenarios) {
      const expected = scenario.id === "safe-swap" ? "ALLOW" : "BLOCK";
      const { status, data } = await request("review", { scenarioId: scenario.id });
      expect(status).toBe(200);
      expect(data.decision).toBe(expected);
      if (expected === "BLOCK") expect(data.permit).toBeNull();
      else expect(data.permit).toMatchObject({ decision: expected, owner: signer.address, enforceable: true });
      expect(data.inference.receipt).toMatchObject({ verification: "simulation", verified: false });
      expect(data.evidence).toEqual({
        transactionHash: sha(scenario.transaction),
        policyHash: sha(policy),
        responseCommitment: sha(data.inference.rawDecision),
      });
      const expectedHash = data.evidence.responseCommitment;
      expect((await request("verify-commitment", { value: data.inference.rawDecision, expectedHash })).data.valid).toBe(true);
      expect((await request("verify-commitment", { value: data.inference.rawDecision + " ", expectedHash })).data.valid).toBe(false);
    }
  });

  it("requires the configured signer and exact proposal; only one simultaneous consumption succeeds", async () => {
    const input = await signedPermit();
    const changed = { ...input.transaction, memo: "Different proposal" };
    const otherSignature = await Wallet.createRandom().signMessage(getBytes(input.permitHash));
    expect((await request("execute", { ...input, signature: otherSignature })).status).toBe(422);
    expect((await request("execute", { ...input, transaction: changed })).status).toBe(422);

    const consumed = await Promise.all([request("execute", input), request("execute", input)]);
    expect(consumed.map(({ status }) => status).sort()).toEqual([200, 422]);
    expect(consumed.find(({ status }) => status === 200).data).toMatchObject({ status: "simulated", owner: signer.address });
  });

  it("rejects a permit at its expiration time", async () => {
    const input = await signedPermit();
    clock += 300_000;
    expect(await request("execute", input)).toEqual({ status: 422, data: { error: "Permit expired" } });
  });

  function stubRouter(outcome = "verified") {
    vi.stubEnv("ZERO_G_API_KEY", "synthetic-key");
    const fetchLocal = globalThis.fetch;
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      if (url !== router) return fetchLocal(url, init);
      const body = JSON.parse(init.body);
      calls.push({ body, headers: init.headers });
      const critic = body.model.endsWith("-SIA");
      if (critic && outcome === "timeout") throw new DOMException("test timeout", "TimeoutError");
      if (critic && outcome === "http error") return new Response(null, { status: 503 });
      const decision = critic && outcome === "invalid" ? "{}" : critic && outcome === "veto" ? allow.replace("ALLOW", "BLOCK") : allow;
      const verification = critic && outcome !== "verified" && outcome !== "veto" ? (outcome === "failed" ? false : undefined) : true;
      return Response.json({
        id: body.model,
        model: body.model,
        choices: [{ finish_reason: "stop", message: { content: decision } }],
        x_0g_trace: { request_id: `request-${body.model}`, provider: signer.address, tee_verified: verification },
      }, { headers: { "x-0g-fixture": "metadata-only", "ZG-Res-Key": `chat-${body.model}` } });
    });
    return calls;
  }

  it("requests verification from both configured private model routes and returns their provenance", async () => {
    const calls = stubRouter();
    const { status, data } = await request("review", { scenarioId: "safe-swap" });
    expect(status).toBe(200);
    expect(data.permit).toMatchObject({ decision: "ALLOW", owner: signer.address });
    expect(calls.map(({ body }) => body.model).sort()).toEqual(["0GM-1.0-35B-A3B", "0GM-1.0-35B-A3B-SIA"]);
    for (const { body, headers } of calls) {
      expect(body.verify_tee).toBe(true);
      expect(headers["X-0G-Provider-Trust-Mode"]).toBe("private");
    }
    expect(data.inference.receipt.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "primary", chatId: "chat-0GM-1.0-35B-A3B", requestId: "request-0GM-1.0-35B-A3B", verification: "router-verified" }),
      expect.objectContaining({ role: "critic", chatId: "chat-0GM-1.0-35B-A3B-SIA", requestId: "request-0GM-1.0-35B-A3B-SIA", verification: "router-verified" }),
    ]));
    const blocked = await request("review", { scenarioId: "slippage-spike" });
    expect(blocked.data).toMatchObject({ decision: "BLOCK", permit: null });
    expect(blocked.data.inference.decision).toBe("ALLOW");
  });

  it.each(["failed", "missing", "veto", "invalid", "timeout", "http error"])("never issues a permit for reviewer outcome %s", async (outcome) => {
    stubRouter(outcome);
    const { data } = await request("review", { scenarioId: "safe-swap" });
    expect(data).toMatchObject({ decision: "BLOCK", permit: null });
  });

  it("validates input before calling the Router and rejects a disabled live committee", async () => {
    const calls = stubRouter();
    expect((await request("review", { transaction: { valueUsd: null } })).status).toBe(400);
    vi.stubEnv("ZERO_G_ENABLE_COMMITTEE", "false");
    expect((await request("review", { scenarioId: "safe-swap" })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
