import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnits } from "ethers";

export async function loadLiveCheckpoint(root, sourceRun) {
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(sourceRun)) throw new Error("Invalid paused live run ID.");
  const prefix = join(root, `live-${sourceRun}`);
  const [journal, original, control] = await Promise.all([
    readFile(`${prefix}.jsonl`, "utf8"), readFile(`${prefix}-billing.json`, "utf8"), readFile(`${prefix}-router-account.json`, "utf8"),
  ]);
  const entries = journal.trim().split("\n").map((line) => JSON.parse(line));
  const [start] = entries;
  const usage = JSON.parse(control);
  const { state, charges } = JSON.parse(original);
  const first = entries.find(({ event, number }) => event === "step-passed" && number === 1);
  const deposit = entries.find(({ event }) => event === "test-wallet-deposit-submitted");
  const stopped = entries.find(({ event }) => event === "failed");
  const reconciled = entries.find(({ event }) => event === "billing-reconciled-read-only");
  const check = (condition) => {
    if (!condition) throw new Error("The stopped run does not have a reconciled checkpoint before Permit issuance.");
  };
  check(start?.event === "started" && entries.every(({ runId, commit }) => runId === sourceRun && commit === start.commit)
    && state.runId === sourceRun && state.commitHash === start.commit && usage.runId === sourceRun && usage.commit === start.commit
    && first?.actual?.requests === 0 && first.actual.elapsedMs >= 1_200_000 && deposit?.amount === "5000000"
    && stopped?.step === 2 && stopped.code === "LIVE_BUDGET_INTEGRITY" && state.fault === stopped.reason
    && !entries.some(({ event }) => event === "submitted" || event === "confirmed")
    && reconciled?.permitsConsumed === 0 && reconciled.chainNonceBefore === start.startingNonce
    && reconciled.chainNonceAfter === start.startingNonce && state.requests === charges.length && charges.length === 2);
  const costs = usage.charges.map((row) => {
    const usd = Number(parseUnits(row.cost, 6));
    const reservation = charges.find((charge) => charge.model === row.model);
    check(row.currency === "USD" && reservation && usd <= reservation.reserved_usd_micros
      && row.time_utc >= deposit.at && row.time_utc <= stopped.at && row.trust_mode === "private");
    return { id: row.request_id, model: row.model, total: usd, sourceRun };
  });
  check(costs.length === charges.length && new Set(costs.map(({ model }) => model)).size === costs.length
    && new Set(costs.map(({ id }) => id)).size === costs.length
    && costs.reduce((sum, entry) => sum + entry.total, 0) === Number(parseUnits(usage.totalUsd, 6))
    && usage.totalUsd === reconciled.actualUsd);
  return { sourceRun, start, first, deposit, costs };
}
