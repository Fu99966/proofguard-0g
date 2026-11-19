# Blocked committee review audit

- Slug `blocked-review-audit`
- Assessed 2026-11-19
- Verdict valid
- Severity medium

## Evidence and reproduction

The funded Base Sepolia acceptance run requested a bounded 2.848665 USDC approval to the registered Permit2 contract. The deterministic checks passed. Both 0G private responses were verified by the Router. The primary reviewer allowed the proposal and the critic blocked it. The Safe had no permit and the Agent broadcast zero transactions. Two Router requests were reserved.

The authenticated review HTTP response carries the final reviewer summaries and threats. The corresponding SQLite decision record stores the reviewers' IDs, verdicts and verification, with no explanation. The Agent's generic halt message therefore prevents retrospective diagnosis.

## Plan and verification

- Retain a bounded summary and up to three bounded threat descriptions for each reviewer on blocked authenticated decisions in `server/index.js`.
- Exercise a verified split committee over HTTP in `server/access.test.js`. Check the persisted decision, reviewer diagnosis, lack of a permit and exclusion of the raw model output after the server closes.
- Run the application suite, then proceed with a funded restart under the existing persistent cap. The previous critic's reason is unknown.
