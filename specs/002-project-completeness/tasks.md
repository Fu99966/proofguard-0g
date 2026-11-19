# Implementation and verification tasks

- [x] T001 Decode EVM inputs, identity, recipients, addresses, integer amounts and bounded approvals (FR-001).
- [x] T002 Verify blind committee evidence, defensive refusal cases and three historical Base Router transactions (FR-001, FR-002).
- [x] T003 Deliver authenticated API, CORS, rate limiting and persistent audit and nonce state. Verify restart and 20 concurrent consumes (FR-003).
- [x] T004 Implement EIP-712 wallet and API signing, CI workflow and documentation (FR-003).
- [ ] T004A Verify the wallet's EIP-712 display with an interactive wallet (FR-003).
- [x] T004B Verify GitHub Actions on the open draft pull request (FR-003).
- [x] T005 Measure deterministic-policy recall and false-positive rate on the repeatable offline dataset (FR-006).
- [ ] T005A Measure the live committee on independent, labeled cases and compare results with external baselines (FR-006).
- [x] T006 Build the SDK, custom calldata UI and full Base Sepolia trading Agent (FR-004, operator choice B).
- [ ] T007 Observe 24 continuous hours of public Base Sepolia testing, including at least one normal rebalance and a rejected invalid recipient. Match every submitted action to a ProofGuard receipt (FR-004).
- [x] T008 Implement and verify the Safe Guard, restricted role, typed issuer and balance simulation on a local Base Sepolia fork (FR-005).
- [x] T008A Deploy an isolated public Base Sepolia Safe and check that a transaction missing a valid permit reverts there (FR-005).
- [ ] T009 Obtain an independent contract audit before any mainnet release (FR-005).

## Acceptance recorded 2026-11-18

The 24-hour run now logs canonical Base Sepolia boundaries and has a verifier for observation continuity, the full Agent nonce range, guard receipts, the matching audit decisions and a successful swap. Local fixture tests cover complete evidence, an unjournaled chain nonce, an observation gap or short window, and missing chain or Router evidence. The 24-hour runner also records a zero-value rejection through the same capped API after the first confirmed swap. The verifier requires its exact proposal hash and two Router-confirmed reviews. The public run is pending.


| Scope | Evidence | Status |
| --- | --- | --- |
| Defensive checks | `server/bypass.test.js` exercises conflicting or invalid self-reports, unknown contract operations, unknown Router commands, foreign sender and receiver, out-of-list assets, unbounded allowances, quote deviation and slippage. The refusal cases run against the corrected implementation. The original vulnerable revision was not replayed. | Verified on corrected build |
| Address and Router fixtures | [USDC](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) and [WETH](https://basescan.org/token/0x4200000000000000000000000000000000000006) were checked on BaseScan and are corroborated by [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses) and [Base](https://docs.base.org/specifications/reference/base-contracts). Router ABIs match the configured [Uniswap deployments](https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/base.json). Three [first](https://basescan.org/tx/0xa6993143d4423c25d21b116d85314c320857197f1499978ab8278aa99c50c9bf), [second](https://basescan.org/tx/0xf8e12f663db178f368276c17b9c1e12ab9164c3a08e8dd2963feed8d922c7c1d) and [third](https://basescan.org/tx/0xd20fc8ce9dd3f66d1e5ebdd0dee18034ebb309b88faa12355133bcdba1dfb6cf) Base transaction inputs and first/final pool logs are saved in `server/fixtures/base-router-swaps.json`. Assertions compare the decoded path start, final recipient and amount bounds with the logs. Two fixture envelopes included trailing data and are decoded for auditing while blocked for permits. | Verified against Base RPC logs |
| Blind 0G input | HTTP tests capture both request bodies and check owner mandate, decoded amounts, final untrusted memo and absence of rule verdicts. Live model decisions for the new prompt require a fresh acceptance run. | Verified with fixtures |
| Authentication, rate limiting and persistence | HTTP tests exercise 401, denied and configured CORS origins, 429, a zero-0G public demo, SQLite HTTP restart and audit lookup, plus exactly 1 success and 19 refused repeats in a concurrent 20-consumption run. A persistent request-budget test prevents additional Router calls after simulated failure and API restart. | Verified locally |
| Evaluation | `npm run eval` runs 104 labeled synthetic cases. It blocked 63/63 expected denials and allowed 41/41 expected approvals. No paid model or third-party calls were made. Outputs are `eval/report.md` and `eval/report.json`. | Verified for the offline deterministic layer |
| Browser | Embedded Chromium rendered the production build. An authenticated Base Sepolia calldata fixture yielded a simulated ALLOW, and the preset rejection displayed BLOCK with no permit. | Verified locally |
| Safe and Agent | Foundry covers missing, expired, changed and replayed permits, authorized consumption and restricted caller. Anvil used the canonical Safe 1.5.0 singleton and factory on a Base Sepolia fork. The guarded SDK path exercised authenticated HTTP, controlled two-reviewer responses, SQLite, typed permit issuance, simulation, ERC-20 allowance change and the on-chain guard. A foreign-recipient proposal never reached the signer. | Verified on local fork |
| GitHub Actions | The `verify` job triggered on [draft PR #2](https://github.com/Fu99966/proofguard-0g/pull/2) at `f82c851` and passed the clean install, application tests, Foundry tests, and production build. [CI run](https://github.com/Fu99966/proofguard-0g/actions/runs/44324144888) | Verified on GitHub |
| Public testnet | Base Sepolia RPC answered `eth_simulateV1` and supplied market data. The operator authorized up to 12 billable 0G Router requests for the 24-hour run. The public Safe and Guard are deployed. | Guard verified. Continuous observation is pending. |

A read-only Base Sepolia preflight at block `60453350` used a hypothetical seed of 20 test USDC and roughly 0.00482 test ETH. The proposed 2.857143 USDC buy passed the deterministic gate through the 100-fee Uniswap V3 pool. Its quote was approximately 0.00156264 WETH, with 274 bps reference price deviation and 26 bps worst slippage. The 500- and 3000-fee pools failed the price-deviation check. This checks current route availability at the planned order size. Refresh the quote after actual funding. No on-chain submission or Router review was made.

The funding transaction `0xe76612a56bde3148249a2753bddbeda54d15187c896bb9d450c9adf95729d5bd` successfully transferred 20 test USDC to the dedicated address on Ethereum Sepolia (11155111). A later [Base Sepolia transfer](https://sepolia.basescan.org/tx/0x6bd8633e807100a19c81cbcc0fed3c73b1f10fefd92cd90fa584a5a71453f4db) credited 20 test USDC to the same address at block `60480328`. The Base Sepolia balance was 20 test USDC and zero test ETH at block `60481459`. The acceptance launcher defaults to a read-only check, starts only with Base Sepolia funding, and uses a persistent 12-request cap for this test run.

The existing Cloud Run service URL and deployment credentials were unavailable in this workspace. No deployment action was recorded. The public demo route in the new implementation uses local simulated reviews even when the authenticated Agent route is configured with a 0G key.

A clean Node 22.23.5 install passed 51 JavaScript and HTTP tests, seven Foundry tests, and the production build. The production dependency audit reported zero findings. The full development dependency audit still reports findings.

## Public testnet evidence recorded 2026-11-19

[Safe](https://sepolia.basescan.org/address/0xCa9668a104C1c4c3Fb8224cCdAB230DBd95949dF) and [Guard](https://sepolia.basescan.org/address/0xF8969fd65bDBb525d66B5e191759fcB59034310C) were deployed on Base Sepolia. At block `60669271`, the Safe had one owner and held 20 test USDC and 0.004835190896099889 test ETH. The expected Guard was enabled as the execution module and installed in both Safe guard slots. A read-only simulation against the public Safe reverted with `MissingPermit` for an owner transaction without a permit.

The first funded observation stopped when the best quote deviated from the independent price by 306 bps at block `60666975`. It used zero Router requests. A second attempt obtained an in-policy quote. The rule checks passed for the bounded USDC allowance, and both 0G responses carried Router verification. The primary allowed the action and the critic vetoed it. ProofGuard withheld the permit, and the Agent broadcast no transaction. The persistent budget recorded two requests. [The audit fix](../../.specify/bugs/blocked-review-audit/fix.md) now retains the final reviewer explanations for blocked decisions. That change passed 58 application tests.

The current live observation opened at block `60670757` with Agent nonce zero on 2026-11-19 at 10:40 China Standard Time. The Agent recorded its first position and [skipped the out-of-policy quote](../../.specify/bugs/no-quote-observation/fix.md) at block `60670764`. A completed 24-hour window, a confirmed rebalance and a verified recipient rejection remain required.
