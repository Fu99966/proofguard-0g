import { Interface, keccak256 } from "ethers";
import { guardAbi } from "../../sdk/guard.js";
import { baseSepolia } from "../../sdk/network.js";
import { hasVerifiedReviewers, isRecipientRejection } from "./rejection.js";

const guard = new Interface(guardAbi);
const daySeconds = 24 * 60 * 60;
const maxJournalGapMs = 10 * 60_000;
const sameHex = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function requireEvidence(assertion, message) {
  if (!assertion) throw new Error(message);
}

async function readBoundary(provider, entry) {
  const block = await provider.getBlock(entry.blockTag);
  requireEvidence(block && sameHex(block.hash, entry.blockHash), "An observation boundary is missing from the canonical chain.");
  const nonce = await provider.getTransactionCount(entry.agent, entry.blockTag);
  requireEvidence(nonce === entry.nonce, "An observation boundary does not match the Agent's on-chain nonce.");
  return { block, nonce };
}

function verifyDecision(audit, submitted, tx, permit, start) {
  const facts = audit?.deterministic?.facts;
  requireEvidence(audit?.decision === "ALLOW" && audit.deterministic?.passed === true && audit.permit?.permitHash === submitted.permitHash
    && sameHex(audit.onchainPermit?.verifyingContract, start.guard), "The server audit does not record an approved on-chain permit.");
  requireEvidence(facts?.tx?.chainId === baseSepolia.chainId && sameHex(facts.tx.from, start.safe) && sameHex(facts.tx.to, tx[0])
    && BigInt(facts.tx.value) === tx[1] && sameHex(facts.tx.data, tx[2]) && sameHex(permit.dataHash, keccak256(tx[2]))
    && sameHex(permit.from, start.safe) && sameHex(permit.to, tx[0]) && permit.value === tx[1]
    && sameHex(permit.nonce, `0x${audit.permit.nonce}`) && permit.deadline === BigInt(Math.floor(Date.parse(audit.permit.expiresAt) / 1000)),
  "The audited transaction differs from the transaction executed through the guard.");
  const reviews = audit.reviews;
  requireEvidence(hasVerifiedReviewers(reviews) && reviews.every(({ decision }) => decision === "ALLOW"),
  "The audit is missing the two distinct Router-verified approvals.");
  return facts.effects.some(({ kind }) => kind === "swap");
}

export async function verifyAgentRun(entries, { provider, readAudit }) {
  const start = entries[0];
  const finish = entries.at(-1);
  requireEvidence(start?.event === "run-started" && finish?.event === "run-finished" && start.runId
    && entries.every((entry) => entry.runId === start.runId && entry.mode === "testnet"), "Select one completed live testnet run.");
  requireEvidence(start.chainId === baseSepolia.chainId && finish.chainId === start.chainId && sameHex(finish.agent, start.agent)
    && sameHex(finish.safe, start.safe) && sameHex(finish.guard, start.guard), "The deployment changed during observation.");
  requireEvidence((await provider.getNetwork()).chainId === BigInt(baseSepolia.chainId), "The verification RPC must be Base Sepolia.");
  const [opening, closing] = await Promise.all([readBoundary(provider, start), readBoundary(provider, finish)]);
  requireEvidence(closing.block.timestamp - opening.block.timestamp >= daySeconds, "The canonical chain boundaries cover less than 24 hours.");
  const positions = entries.filter(({ event }) => event === "position");
  const ticks = [start, ...positions, finish].map(({ at }) => Date.parse(at));
  requireEvidence(positions.length > 0 && ticks.every((at, index) => Number.isFinite(at)
    && (index === 0 || (at >= ticks[index - 1] && at - ticks[index - 1] <= maxJournalGapMs))), "The Agent journal has an observation gap.");
  requireEvidence(!entries.some(({ event, reason }) => event === "run-submissions-paused" && reason === "three-consecutive-review-cycles"),
    "Agent submissions paused because three consecutive cycles triggered review.");

  const submitted = entries.filter(({ event }) => event === "submitted");
  const confirmed = entries.filter(({ event }) => event === "confirmed");
  const confirmedByHash = new Map(confirmed.map((entry) => [entry.txHash, entry]));
  requireEvidence(submitted.length === closing.nonce - opening.nonce && submitted.length === confirmed.length
    && new Set(submitted.map(({ txHash }) => txHash)).size === submitted.length && confirmedByHash.size === confirmed.length,
  "Journal transactions do not account for every on-chain Agent nonce in the window.");
  const nonces = new Set();
  let swaps = 0;
  for (const entry of submitted) {
    requireEvidence(confirmedByHash.get(entry.txHash)?.permitHash === entry.permitHash, "A submission lacks its matching confirmation.");
    const [transaction, receipt, audit] = await Promise.all([
      provider.getTransaction(entry.txHash), provider.getTransactionReceipt(entry.txHash), readAudit(entry.permitHash),
    ]);
    requireEvidence(transaction && receipt?.status === 1 && sameHex(transaction.from, start.agent) && sameHex(transaction.to, start.guard)
      && transaction.value === 0n && receipt.blockNumber > opening.block.number && receipt.blockNumber <= closing.block.number
      && transaction.nonce >= opening.nonce && transaction.nonce < closing.nonce && !nonces.has(transaction.nonce),
    "A submission is missing, failed, outside the run or did not originate from the Agent through the guard.");
    nonces.add(transaction.nonce);
    const call = guard.parseTransaction(transaction);
    const permit = call?.args[3];
    requireEvidence(call?.name === "executeGuarded" && sameHex(permit?.permitHash, entry.permitHash), "The submitted guard call has the wrong Permit.");
    const consumed = receipt.logs.filter((log) => sameHex(log.address, start.guard)).map((log) => guard.parseLog(log))
      .filter((log) => log?.name === "PermitConsumed");
    requireEvidence(consumed.length === 1 && sameHex(consumed[0].args.permitHash, entry.permitHash)
      && sameHex(consumed[0].args.nonce, permit.nonce) && sameHex(consumed[0].args.target, call.args[0]),
    "The on-chain receipt does not match the consumed Permit.");
    if (verifyDecision(audit, entry, call.args, permit, start)) swaps++;
  }
  requireEvidence(swaps > 0, "The run contains no successful guarded rebalance.");
  const rejections = entries.filter(({ event }) => event === "recipient-rejected");
  requireEvidence(rejections.length === 1 && isRecipientRejection(rejections[0], start.safe)
    && Date.parse(rejections[0].at) >= ticks[0] && Date.parse(rejections[0].at) <= ticks.at(-1),
  "The run does not prove a verified recipient rejection within the observation window.");
  return { runId: start.runId, startBlock: opening.block.number, endBlock: closing.block.number,
    elapsedOnChainSeconds: closing.block.timestamp - opening.block.timestamp, observations: positions.length, guardedTransactions: submitted.length,
    swaps, recipientRejections: rejections.length, renewalAnomalies: entries.filter(({ event }) => event === "allowance-renewal-anomaly").length };
}
