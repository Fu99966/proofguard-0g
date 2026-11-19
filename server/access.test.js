import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Interface, Wallet } from "ethers";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import { liveModelBounds, openLiveBudget } from "./liveAcceptanceBudget.js";
import { readRouterRequestsUsed } from "./reviewStore.js";
import { baseSepolia } from "../sdk/network.js";
import { permitTypedData } from "../sdk/permit.js";
import { planShortAcceptance } from "../examples/rebalancer/short-acceptance.js";

const key = "test-access-0123456789abcdef";
const keyHash = createHash("sha256").update(key).digest("hex");
const signer = Wallet.createRandom();
const activeServers = new Set();
const folders = [];

async function start(options) {
  const app = createApp({ owner: signer.address, keyHashes: [keyHash], database: ":memory:", ...options });
  const server = app.listen(0, "127.0.0.1");
  server.once("close", app.locals.closeReviewStore);
  activeServers.add(server);
  await once(server, "listening");
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  if (!activeServers.delete(server)) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(async () => {
  await Promise.all([...activeServers].map(close));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function post(origin, route, body, headers) {
  return fetch(`${origin}/api/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

const authorized = { Authorization: `Bearer ${key}` };
const scenario = { scenarioId: "safe-swap" };

it("restricts paid reviews by key and browser origin while keeping the preset demo offline", async () => {
  vi.stubEnv("ZERO_G_API_KEY", "unused-test-router");
  const realFetch = globalThis.fetch;
  const fakeRouter = vi.fn(async (url, init) => {
    if (url.startsWith("https://router-api.0g.ai")) throw new Error("Router must not be called");
    return realFetch(url, init);
  });
  vi.stubGlobal("fetch", fakeRouter);
  const { origin } = await start({ frontendOrigins: ["https://proofguard.example"] });
  expect((await post(origin, "review", scenario)).status).toBe(401);
  expect((await post(origin, "review", scenario, { ...authorized, Origin: "https://other.example" })).status).toBe(403);
  const demo = await post(origin, "demo/review", scenario, { Origin: "https://proofguard.example" });
  expect(demo.headers.get("access-control-allow-origin")).toBe("https://proofguard.example");
  expect((await demo.json()).inference.mode).toBe("demo");
  expect(fakeRouter.mock.calls.every(([url]) => url.startsWith(origin))).toBe(true);
});

it("returns 429 after the configured authenticated review allowance", async () => {
  vi.stubEnv("ZERO_G_FORCE_DEMO", "true");
  const { origin } = await start({ rateOptions: { limit: 1 } });
  expect((await post(origin, "review", scenario, authorized)).status).toBe(200);
  expect((await post(origin, "review", scenario, authorized)).status).toBe(429);
});

it("keeps a typed permit and its audit record across an application restart", async () => {
  vi.stubEnv("ZERO_G_FORCE_DEMO", "true");
  const dir = mkdtempSync(path.join(tmpdir(), "proofguard-db-test-"));
  folders.push(dir);
  const database = path.join(dir, "db.sqlite");
  const first = await start({ database });
  const { permit, transaction } = await (await post(first.origin, "review", scenario, authorized)).json();
  const { domain, types, message } = permitTypedData(permit, transaction);
  const signature = await signer.signTypedData(domain, types, message);
  await close(first.server);

  const second = await start({ database });
  const result = await post(second.origin, "execute", { permitHash: permit.permitHash, transaction, signature });
  expect(result.status).toBe(200);
  const auditResponse = await fetch(`${second.origin}/api/audit/${permit.permitHash}`, { headers: authorized });
  expect(await auditResponse.json()).toMatchObject({ decision: "ALLOW", consumedAt: expect.any(Number),
    deterministic: { facts: { tx: { data: transaction.data } } }, reviews: [expect.any(Object), expect.any(Object)], permit });
  expect((await post(second.origin, "execute", { permitHash: permit.permitHash, transaction, signature })).status).toBe(422);
});

it("enforces a Router request cap across application restarts", async () => {
  vi.stubEnv("ZERO_G_FORCE_DEMO", "false");
  vi.stubEnv("ZERO_G_API_KEY", "unused-test-router");
  const realFetch = globalThis.fetch;
  let outbound = 0;
  vi.stubGlobal("fetch", async (url, init) => {
    if (url.startsWith("https://router-api.0g.ai")) {
      outbound++;
      return new Response(null, { status: 503 });
    }
    return realFetch(url, init);
  });
  const dir = mkdtempSync(path.join(tmpdir(), "proofguard-budget-test-"));
  folders.push(dir);
  const options = { routerBudgetId: "test-cap", routerBudgetLimit: 2, database: path.join(dir, "db.sqlite") };
  expect(readRouterRequestsUsed(options.database, options.routerBudgetId)).toBe(0);
  const first = await start(options);
  expect(readRouterRequestsUsed(options.database, options.routerBudgetId)).toBe(0);
  expect((await post(first.origin, "review", scenario, authorized)).status).toBe(502);
  await close(first.server);
  expect(readRouterRequestsUsed(options.database, options.routerBudgetId)).toBe(2);
  expect(readRouterRequestsUsed(options.database, "another-scope")).toBe(0);
  const second = await start(options);
  expect((await post(second.origin, "review", scenario, authorized)).status).toBe(429);
  expect(outbound).toBe(2);
  expect(readRouterRequestsUsed(options.database, options.routerBudgetId)).toBe(2);
});

it.each([true, false])("enforces an exact committed short run and halts on a veto (%s)", async (veto) => {
  vi.stubEnv("ZERO_G_FORCE_DEMO", "false");
  vi.stubEnv("ZERO_G_API_KEY", "short-run-offline-fixture");
  vi.stubEnv("ZERO_G_MODEL", "glm-5.3-flash");
  vi.stubEnv("ZERO_G_CRITIC_MODEL", "0gm-1.0-35b-a3b-sia");
  const realFetch = globalThis.fetch;
  let calls = 0;
  vi.stubGlobal("fetch", async (url, init) => {
    if (url !== "https://router-api.0g.ai/v1/chat/completions") return realFetch(url, init);
    const wave = Math.floor(calls++ / 2);
    const { model } = JSON.parse(init.body);
    const decision = veto && wave === 1 && model === "0gm-1.0-35b-a3b-sia" ? "BLOCK" : "ALLOW";
    return Response.json({ model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision, riskScore: 20,
      summary: "Short run offline fixture", threats: [], confidence: 1 }) } }],
    x_0g_trace: { request_id: `fixture-${calls}`, tee_verified: true } });
  });
  const blockTime = Date.now();
  const asset = baseSepolia;
  const plan = planShortAcceptance(signer.address.toLowerCase(), { tokenIn: asset.usdc, tokenOut: asset.weth, amount: "1000000",
    minOut: "499000000000000", fee: 100 }, Math.floor(blockTime / 1000));
  const dir = mkdtempSync(path.join(tmpdir(), "proofguard-short-test-"));
  folders.push(dir);
  const database = path.join(dir, "short.sqlite");
  const acceptance = { commit: "a".repeat(40), runId: "fixture-short", transactions: plan.transactions };
  const { server, origin } = await start({ database, shortAcceptance: acceptance, wallet: signer.address, now: () => blockTime,
    issuerKey: Wallet.createRandom().privateKey, guardAddress: signer.address, routerBudgetId: "fixture-short", routerBudgetLimit: 6,
    marketFor: async () => ({ source: "short-fixture", usdMicros: { [asset.usdc]: "1000000", [asset.weth]: "2000000000" },
      swapQuote: { input: "1000000", output: "500000000000000" } }) });
  const [renewal, swap, rejection] = plan.transactions;
  const reply = (transaction) => post(origin, "review", { transaction }, authorized);
  expect(await (await reply(renewal)).json()).toMatchObject({ decision: "ALLOW", onchainPermit: expect.any(Object) });
  expect(await (await reply(swap)).json()).toMatchObject({ decision: veto ? "BLOCK" : "ALLOW" });
  const result = await reply(rejection);
  expect(result.status).toBe(veto ? 409 : 200);
  expect(await result.json()).toMatchObject({ decision: "BLOCK", permit: null });
  expect(calls).toBe(veto ? 4 : 6);
  expect((await reply(renewal)).status).toBe(409);
  expect(calls).toBe(veto ? 4 : 6);
  await close(server);
  const db = new Database(database, { readonly: true });
  try {
    const evidence = db.prepare("SELECT decision_record FROM reviews ORDER BY id").all().map(({ decision_record }) => JSON.parse(decision_record));
    expect(evidence).toHaveLength(veto ? 2 : 3);
    expect(evidence[0].acceptance).toEqual({ commit: acceptance.commit, runId: acceptance.runId, step: 1, memo: renewal.memo });
    expect(evidence.every(({ acceptance: recorded }, index) => recorded.commit === acceptance.commit && recorded.step === index + 1)).toBe(true);
  } finally {
    db.close();
  }
});

it("retains reviewer explanations for a verified veto without persisting raw model output", async () => {
  const primary = "glm-5.3-flash";
  const critic = "0gm-1.0-35b-a3b-sia";
  vi.stubEnv("ZERO_G_FORCE_DEMO", "false");
  vi.stubEnv("ZERO_G_API_KEY", "unused-test-router");
  vi.stubEnv("ZERO_G_MODEL", primary);
  vi.stubEnv("ZERO_G_CRITIC_MODEL", critic);
  const realFetch = globalThis.fetch;
  const prompts = [];
  const privateReasoning = "This text is outside the final JSON verdict.";
  vi.stubGlobal("fetch", async (url, init) => {
    if (url !== "https://router-api.0g.ai/v1/chat/completions") return realFetch(url, init);
    const { model, messages } = JSON.parse(init.body);
    prompts.push(messages[1].content);
    const verdict = model === critic
      ? { decision: "BLOCK", summary: "The approval purpose is unclear.", threats: ["Unclear authorization scope"] }
      : { decision: "ALLOW", summary: "The proposal fits the mandate.", threats: [] };
    const content = `<think>${privateReasoning}</think>${JSON.stringify({ ...verdict, riskScore: 20, confidence: 0.9 })}`;
    return Response.json({ model, choices: [{ finish_reason: "stop", message: { content } }],
      x_0g_trace: { request_id: `fixture-${model}`, tee_verified: true, billing: { currency: "0g", total_cost: "123", total_cost_usd_micro: "7" } } });
  });
  const dir = mkdtempSync(path.join(tmpdir(), "proofguard-veto-test-"));
  folders.push(dir);
  const database = path.join(dir, "db.sqlite");
  const { server, origin } = await start({ database, wallet: signer.address, marketFor: async () => ({
    source: "independent-market-fixture", usdMicros: { [baseSepolia.usdc]: "1000000" },
    portfolio: { ethExposureBps: 3005, totalUsdMicros: "28571430" },
  }) });
  const token = new Interface(["function approve(address spender,uint256 amount)"]);
  const transaction = { chainId: baseSepolia.chainId, from: signer.address, to: baseSepolia.usdc,
    value: "0", data: token.encodeFunctionData("approve", [baseSepolia.permit2, 2_843_095]) };
  const response = await post(origin, "review", { transaction }, authorized);
  expect(await response.json()).toMatchObject({ decision: "BLOCK", permit: null });
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain("When verified exposure is outside the band");
    expect(prompt).toContain("may prepare a corrective swap");
    expect(prompt).toContain('"ethExposureBps":3005');
    expect(prompt).toContain('"approvalUsdMicros":"2843095"');
  }
  await close(server);
  const db = new Database(database, { readonly: true });
  try {
    const { decision_record } = db.prepare("SELECT decision_record FROM reviews").get();
    expect(JSON.parse(decision_record)).toMatchObject({ decision: "BLOCK", permit: null, reviews: [
      { role: "primary", decision: "ALLOW", summary: "The proposal fits the mandate.", charge: { currency: "0g", totalUnits: "123", usdMicros: "7" } },
      { role: "critic", decision: "BLOCK", summary: "The approval purpose is unclear.",
        threats: ["Unclear authorization scope"], verification: "router-verified" },
    ] });
    expect(decision_record).not.toContain(privateReasoning);
  } finally {
    db.close();
  }
});

it("blocks before Router fetch below the worst-case limit and stops before signing on inconsistent billing", async () => {
  const models = ["glm-5.3-flash", "0gm-1.0-35b-a3b-sia"];
  const bounds = liveModelBounds(models);
  const pair = bounds[0].usdMicros + bounds[1].usdMicros;
  const directory = mkdtempSync(path.join(tmpdir(), "proofguard-live-budget-test-"));
  folders.push(directory);
  const database = path.join(directory, "db.sqlite");
  const budget = openLiveBudget(database);
  budget.start("fixture-live", "commit");
  let limit = pair - 1;
  let inconsistent = false;
  let outbound = 0;
  vi.stubEnv("ZERO_G_FORCE_DEMO", "false");
  vi.stubEnv("ZERO_G_API_KEY", "unused-test-router");
  vi.stubEnv("ZERO_G_MODEL", models[0]);
  vi.stubEnv("ZERO_G_CRITIC_MODEL", models[1]);
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url, init) => {
    if (url !== "https://router-api.0g.ai/v1/chat/completions") return realFetch(url, init);
    outbound++;
    const { model, max_tokens } = JSON.parse(init.body);
    const bound = bounds.find((entry) => entry.model === model);
    expect(init.headers).toMatchObject(bound.headers);
    expect(max_tokens).toBe(bound.output);
    expect(budget.state().committedUsdMicros).toBeGreaterThanOrEqual(bound.usdMicros);
    return Response.json({ model, usage: { prompt_tokens: 1000, completion_tokens: 100 },
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision: "ALLOW", riskScore: 1, summary: "Offline test",
        threats: [], confidence: 1 }) } }],
      x_0g_trace: { request_id: `test-${outbound}`, tee_verified: true,
        billing: { currency: "usd", input_cost: "100", output_cost: "10", total_cost: inconsistent ? "111" : "110" } } },
    { headers: { "X-Request-ID": `transport-${outbound}` } });
  });
  try {
    const { server, origin } = await start({ database, wallet: signer.address, issuerKey: signer.privateKey, guardAddress: signer.address,
      liveAcceptance: { bounds, usdLimit: () => limit }, marketFor: async () => ({ source: "fixture", usdMicros: { [baseSepolia.usdc]: "1000000" } }) });
    const token = new Interface(["function approve(address spender,uint256 amount)"]);
    const proposal = { chainId: baseSepolia.chainId, from: signer.address, to: baseSepolia.usdc, value: "0",
      data: token.encodeFunctionData("approve", [baseSepolia.permit2, 2_000_000]) };
    const review = (transaction) => post(origin, "review", { transaction }, authorized);
    expect(await (await review(proposal)).json()).toMatchObject({ code: "ROUTER_BUDGET_EXHAUSTED", permit: null });
    expect(outbound).toBe(0);
    limit = 900_000;
    expect(await (await review(proposal)).json()).toMatchObject({ decision: "ALLOW", onchainPermit: expect.any(Object) });
    expect(budget.state()).toMatchObject({ billedUsdMicros: 220, unsettled: 0 });
    expect(budget.rows().map(({ request_id, billing }) => [request_id, JSON.parse(billing).transportRequestId]))
      .toEqual([["test-1", "transport-1"], ["test-2", "transport-2"]]);
    await close(server);
    const restarted = await start({ database, wallet: signer.address, issuerKey: signer.privateKey, guardAddress: signer.address,
      liveAcceptance: { bounds, usdLimit: () => limit }, marketFor: async () => ({ source: "fixture", usdMicros: { [baseSepolia.usdc]: "1000000" } }) });
    expect((await post(restarted.origin, "review", { transaction: proposal }, authorized)).status).toBe(409);
    expect(outbound).toBe(2);
    inconsistent = true;
    expect(await (await post(restarted.origin, "review", { transaction: { ...proposal, memo: "new proposal" } }, authorized)).json())
      .toMatchObject({ code: "LIVE_BUDGET_INTEGRITY", permit: null });
    expect(outbound).toBe(4);
    expect(budget.state()).toMatchObject({ billedUsdMicros: 220, unsettled: 2, fault: expect.any(String) });
  } finally { budget.close(); }
});
