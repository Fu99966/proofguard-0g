import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSampler, stringifyEvidence } from "../examples/rebalancer/sampler.js";
import { baseSepolia } from "../sdk/network.js";

const directory = "var/testnet-acceptance";
const { safe, chainId } = JSON.parse(await readFile(join(directory, "deployment.json"), "utf8"));
if (chainId !== baseSepolia.chainId || !safe) throw new Error("Base Sepolia deployment required.");
const runId = randomUUID();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const journal = join(directory, `stability-${runId}.jsonl`);
const report = join(directory, `stability-${runId}.md`);
const interval = 300_000;
const count = 288;
const rpc = process.env.PROOFGUARD_RPC_URL || "https://base-sepolia-rpc.publicnode.com";
const options = { safe, ethFeed: process.env.PROOFGUARD_ETH_USD_FEED, usdcFeed: process.env.PROOFGUARD_USDC_USD_FEED };
const sampler = createSampler({ ...options, rpc });
const memory = [];
const completed = new Set();
const failures = [];
let wouldReview = 0;

await mkdir(directory, { recursive: true, mode: 0o700 });
const record = (entry) => appendFile(journal, stringifyEvidence({ runId, commit, at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
const start = Date.now();
const target = (slot) => start + slot * interval;
await record({ event: "started", safe, chainId, interval, slots: count, routerRequests: 0, transactions: 0 });
console.log(stringifyEvidence({ event: "started", runId, journal, report, finishesAt: new Date(target(count)).toISOString() }));

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarizeMemory(key, hourlyThreshold) {
  const readings = memory.slice(12);
  const window = Math.floor(readings.length / 3);
  if (!window) return { sufficient: false };
  const first = readings.slice(0, window);
  const last = readings.slice(-window);
  const lower = median(first.map((entry) => entry[key]));
  const upper = median(last.map((entry) => entry[key]));
  const hours = (median(last.map(({ at }) => at)) - median(first.map(({ at }) => at))) / 3_600_000;
  const mib = 2 ** 20;
  return { sufficient: true, firstMiB: lower / mib, lastMiB: upper / mib,
    medianMiBPerHour: (upper - lower) / mib / hours, peakMiB: Math.max(...memory.map((entry) => entry[key])) / mib,
    withinThreshold: (upper - lower) / mib / hours <= hourlyThreshold, hourlyThreshold };
}

try {
  for (let slot = 0; slot < count; slot++) {
    await sleep(Math.max(0, target(slot) - Date.now()));
    const fault = slot === 4 ? "rpc" : slot === 7 ? "quote" : null;
    if (Date.now() >= target(slot + 1)) {
      failures.push({ slot, issue: "missed-schedule", fault });
      await record({ event: "skipped", slot, scheduledAt: new Date(target(slot)).toISOString(), fault });
      continue;
    }
    const active = fault === "rpc" ? createSampler({ ...options, rpc: "http://127.0.0.1:1" }) : sampler;
    try {
      const data = await active.sample({ quoteHealthCheck: true, rejectQuote: fault === "quote" });
      if (data.issue) throw Object.assign(new Error(data.issue), { code: data.issue });
      completed.add(slot);
      const reviewNeeded = Boolean(data.position.tokenIn && data.quote?.minOut > 0n);
      if (reviewNeeded) wouldReview++;
      await record({ event: "sample", slot, scheduledAt: new Date(target(slot)).toISOString(), fault, ...data, wouldReview: reviewNeeded });
    } catch (error) {
      const issue = error.code || error.name;
      failures.push({ slot, issue, fault });
      await record({ event: "sample-failed", slot, scheduledAt: new Date(target(slot)).toISOString(), issue, fault });
    } finally {
      if (active !== sampler) active.close();
      const measured = process.memoryUsage();
      const reading = { slot, at: Date.now(), rss: measured.rss, heapUsed: measured.heapUsed };
      memory.push(reading);
      await record({ event: "memory", slot, rss: reading.rss, heapUsed: reading.heapUsed });
    }
  }
  await sleep(Math.max(0, target(count) - Date.now()));
  const rpcRecovery = failures.some(({ slot, fault }) => slot === 4 && fault === "rpc") && completed.has(5);
  const quoteRecovery = failures.some(({ slot, fault, issue }) => slot === 7 && fault === "quote" && issue === "quote-unavailable") && completed.has(8);
  const continuity = completed.size / count;
  const rss = summarizeMemory("rss", 4);
  const heap = summarizeMemory("heapUsed", 1);
  const pass = continuity >= .95 && rpcRecovery && quoteRecovery && rss.withinThreshold && heap.withinThreshold;
  const result = { event: "finished", pass, completed: completed.size, count, continuity, failures, rpcRecovery, quoteRecovery,
    rss, heap, wouldReview, durationMs: Date.now() - start, routerRequests: 0, transactions: 0 };
  await record(result);
  await writeFile(report, `# Base Sepolia 24-hour read-only stability report\n\nStatus **${pass ? "passed" : "failed"}**. Run \`${runId}\` used commit \`${commit}\` and covered ${(result.durationMs / 3600000).toFixed(3)} hours.\n\n- Scheduled samples ${completed.size}/${count} (${(100 * continuity).toFixed(2)}%). Planned faults remain in the denominator.\n- RPC fault and next-slot recovery ${rpcRecovery ? "verified" : "failed"}. Quote fault and next-slot recovery ${quoteRecovery ? "verified" : "failed"}.\n- RSS trend ${rss.medianMiBPerHour?.toFixed(2)} MiB/h and heap trend ${heap.medianMiBPerHour?.toFixed(2)} MiB/h. The first hour is excluded from the trend. Limits are +4 MiB/h RSS and +1 MiB/h heap, based on medians of the first and last thirds of the remaining measurements.\n- ${wouldReview} observations would have required a review. Zero Router requests and zero transactions.\n\n[Sample journal](./${journal.split("/").at(-1)})\n`, { mode: 0o600 });
  console.log(stringifyEvidence(result));
  if (!pass) process.exitCode = 1;
} finally {
  sampler.close();
}
