# Implementation and verification tasks

- [x] T001 Decode EVM inputs, identity, recipients, addresses, integer amounts and bounded approvals (FR-001).
- [x] T002 Verify blind committee evidence, defensive refusal cases and three historical Base Router transactions (FR-001, FR-002).
- [x] T003 Deliver authenticated API, CORS, rate limiting and persistent audit and nonce state. Verify restart and 20 concurrent consumes (FR-003).
- [x] T004 Implement EIP-712 wallet and API signing, CI workflow and documentation (FR-003).
- [ ] T004A Verify the wallet's EIP-712 display with an interactive wallet and observe the workflow on a GitHub PR (FR-003).
- [x] T005 Measure deterministic-policy recall and false-positive rate on the repeatable offline dataset (FR-006).
- [ ] T005A Measure the live committee on independent, labeled cases and compare results with external baselines (FR-006).
- [x] T006 Build the SDK, custom calldata UI and full Base Sepolia trading Agent (FR-004, operator choice B).
- [ ] T007 Observe 24 continuous hours of public Base Sepolia testing, including at least one normal rebalance and a rejected invalid recipient. Match every submitted action to a ProofGuard receipt (FR-004).
- [x] T008 Implement and verify the Safe Guard, restricted role, typed issuer and balance simulation on a local Base Sepolia fork (FR-005).
- [ ] T008A Deploy an isolated public Base Sepolia Safe and check that a transaction missing a valid permit reverts there (FR-005).
- [ ] T009 Obtain an independent contract audit before any mainnet release (FR-005).

## Acceptance recorded 2026-11-18

| Scope | Evidence | Status |
| --- | --- | --- |
| Defensive checks | `server/bypass.test.js` exercises conflicting or invalid self-reports, unknown contract operations, unknown Router commands, foreign sender and receiver, out-of-list assets, unbounded allowances, quote deviation and slippage. The refusal cases run against the corrected implementation. The original vulnerable revision was not replayed. | Verified on corrected build |
| Address and Router fixtures | [USDC](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) and [WETH](https://basescan.org/token/0x4200000000000000000000000000000000000006) were checked on BaseScan and are corroborated by [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses) and [Base](https://docs.base.org/specifications/reference/base-contracts). Router ABIs match the configured [Uniswap deployments](https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/base.json). Three [first](https://basescan.org/tx/0xa6993143d4423c25d21b116d85314c320857197f1499978ab8278aa99c50c9bf), [second](https://basescan.org/tx/0xf8e12f663db178f368276c17b9c1e12ab9164c3a08e8dd2963feed8d922c7c1d) and [third](https://basescan.org/tx/0xd20fc8ce9dd3f66d1e5ebdd0dee18034ebb309b88faa12355133bcdba1dfb6cf) Base transaction inputs and first/final pool logs are saved in `server/fixtures/base-router-swaps.json`. Assertions compare the decoded path start, final recipient and amount bounds with the logs. Two fixture envelopes included trailing data and are decoded for auditing while blocked for permits. | Verified against Base RPC logs |
| Blind 0G input | HTTP tests capture both request bodies and check owner mandate, decoded amounts, final untrusted memo and absence of rule verdicts. Live model decisions for the new prompt require a fresh acceptance run. | Verified with fixtures |
| Authentication, rate limiting and persistence | HTTP tests exercise 401, denied and configured CORS origins, 429, a zero-0G public demo, SQLite HTTP restart and audit lookup, plus exactly 1 success and 19 refused repeats in a concurrent 20-consumption run. A persistent request-budget test prevents additional Router calls after simulated failure and API restart. | Verified locally |
| Evaluation | `npm run eval` runs 104 labeled synthetic cases. It blocked 63/63 expected denials and allowed 41/41 expected approvals. No paid model or third-party calls were made. Outputs are `eval/report.md` and `eval/report.json`. | Verified for the offline deterministic layer |
| Browser | Embedded Chromium rendered the production build. An authenticated Base Sepolia calldata fixture yielded a simulated ALLOW, and the preset rejection displayed BLOCK with no permit. | Verified locally |
| Safe and Agent | Foundry covers missing, expired, changed and replayed permits, authorized consumption and restricted caller. Anvil used the canonical Safe 1.5.0 singleton and factory on a Base Sepolia fork. The guarded SDK path exercised authenticated HTTP, controlled two-reviewer responses, SQLite, typed permit issuance, simulation, ERC-20 allowance change and the on-chain guard. A foreign-recipient proposal never reached the signer. | Verified on local fork |
| Public testnet and CI | Base Sepolia RPC answered `eth_simulateV1` and supplied historical and live read-only data. At preflight the dedicated testnet owner had 0 test ETH, with no ProofGuard Safe or Guard deployed. The 24-hour run also needs a scene with test liquidity and authorization for billable 0G. The existing GitHub PR has not received this working tree. | Pending |

The existing Cloud Run service URL and deployment credentials were unavailable in this workspace. No deployment action was recorded. The public demo route in the new implementation uses local simulated reviews even when the authenticated Agent route is configured with a 0G key.

A clean Node 22.23.5 install passed 51 JavaScript and HTTP tests, seven Foundry tests, and the production build. The production dependency audit reported zero findings. The full development dependency audit still reports findings.
