import { afterEach, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { createProofGuardClient } from "./index.js";

const [from, to] = [Wallet.createRandom().address, Wallet.createRandom().address];
const transaction = { chainId: 84532, from, to, value: "0", data: "0x" };
const apiKey = "local-key-012345678abcdef";
const now = 1_799_000_000_000;
const permit = { expiresAt: new Date(now + 60_000).toISOString(), nonce: "11".repeat(12), permitHash: `0x${"01".repeat(32)}` };
const allowed = { decision: "ALLOW", inference: { mode: "live" }, permit, transaction };
const client = createProofGuardClient({ apiUrl: "https://example.com", apiKey, now: () => now });

afterEach(() => vi.unstubAllGlobals());

it("passes the same reviewed transaction to simulation and submission in order", async () => {
  const send = vi.fn().mockResolvedValue("submitted");
  const inspect = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockResolvedValue(Response.json(allowed));
  vi.stubGlobal("fetch", fetch);
  expect(await client.guardedSend(transaction, send, { inspect })).toBe("submitted");
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${apiKey}`);
  expect(inspect.mock.calls[0][0].transaction).toEqual(transaction);
  expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
});

it.each([
  { ...allowed, decision: "BLOCK", permit: null },
  { ...allowed, inference: { mode: "demo" } },
  { ...allowed, transaction: { ...transaction, to: from } },
  { ...allowed, permit: { ...permit, expiresAt: new Date(now - 1).toISOString() } },
])("does not reach the signer for denied, simulated, mismatched or expired reviews", async (payload) => {
  const send = vi.fn();
  vi.stubGlobal("fetch", async () => Response.json(payload));
  await expect(client.guardedSend(transaction, send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it("blocks submission after an unsuccessful simulation", async () => {
  vi.stubGlobal("fetch", async () => Response.json(allowed));
  const send = vi.fn();
  const inspect = () => { throw new Error("Bad simulated balance"); };
  await expect(client.guardedSend(transaction, send, { inspect })).rejects.toThrow("Bad simulated balance");
  expect(send).not.toHaveBeenCalled();
});
