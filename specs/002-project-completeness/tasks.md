# Implementation and verification tasks

- [x] T001 Decode EVM inputs, identity, recipients, addresses, integer amounts and bounded approvals (FR-001).
- [x] T002 Verify blind committee evidence, defensive refusal cases and three historical Base Router transactions (FR-001, FR-002).
- [x] T003 Deliver authenticated API, CORS, rate limiting and persistent audit and nonce state. Verify restart and 20 concurrent consumes (FR-003).
- [x] T004 Implement EIP-712 wallet and API signing, CI workflow and documentation (FR-003).
- [x] T004A Verify the wallet's EIP-712 display with an interactive wallet (FR-003).
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
| Evaluation | `npm run eval -- --demo` runs the internal synthetic controls and writes local per-case results to `eval/report.md` and `eval/report.json`. | Verified for the offline deterministic layer |
| Browser | Embedded Chromium rendered the production build. An authenticated Base Sepolia calldata fixture yielded a simulated ALLOW, and the preset rejection displayed BLOCK with no permit. | Verified locally |
| Safe and Agent | Foundry covers missing, expired, changed and replayed permits, authorized consumption and restricted caller. Anvil used the canonical Safe 1.5.0 singleton and factory on a Base Sepolia fork. The guarded SDK path exercised authenticated HTTP, controlled two-reviewer responses, SQLite, typed permit issuance, simulation, ERC-20 allowance change and the on-chain guard. A foreign-recipient proposal never reached the signer. | Verified on local fork |
| GitHub Actions | The `verify` job triggered on [draft PR #2](https://github.com/Fu99966/proofguard-0g/pull/2) at `f82c851` and passed the clean install, application tests, Foundry tests, and production build. [CI run](https://github.com/Fu99966/proofguard-0g/actions/runs/44324144888) | Verified on GitHub |
| Public testnet | Base Sepolia RPC answered `eth_simulateV1` and supplied market data. The operator authorized up to 12 billable 0G Router requests for the 24-hour run. The public Safe and Guard are deployed. | Guard verified. Continuous observation is pending. |

A read-only Base Sepolia preflight at block `60453350` used a hypothetical seed of 20 test USDC and roughly 0.00482 test ETH. The proposed 2.857143 USDC buy passed the deterministic gate through the 100-fee Uniswap V3 pool. Its quote was approximately 0.00156264 WETH, with 274 bps reference price deviation and 26 bps worst slippage. The 500- and 3000-fee pools failed the price-deviation check. This checks current route availability at the planned order size. Refresh the quote after actual funding. No on-chain submission or Router review was made.

The funding transaction `0xe76612a56bde3148249a2753bddbeda54d15187c896bb9d450c9adf95729d5bd` successfully transferred 20 test USDC to the dedicated address on Ethereum Sepolia (11155111). A later [Base Sepolia transfer](https://sepolia.basescan.org/tx/0x6bd8633e807100a19c81cbcc0fed3c73b1f10fefd92cd90fa584a5a71453f4db) credited 20 test USDC to the same address at block `60480328`. The Base Sepolia balance was 20 test USDC and zero test ETH at block `60481459`. The acceptance launcher defaults to a read-only check, starts only with Base Sepolia funding, and uses a persistent 12-request cap for this test run.

The existing Cloud Run service URL and deployment credentials were unavailable in this workspace. No deployment action was recorded. The public demo route in the new implementation uses local simulated reviews even when the authenticated Agent route is configured with a 0G key.

A clean Node 22.23.5 install passed 51 JavaScript and HTTP tests, seven Foundry tests, and the production build. The production dependency audit reported zero findings. The full development dependency audit still reports findings.

## Interactive EIP-712 wallet verification recorded 2026-11-19

The production browser build connected to [Enkrypt 2.19.0](https://github.com/enkryptcom/enKrypt/releases/tag/v2.19.0) in an isolated Chromium profile with a temporary wallet. A loopback API issued a demo permit and used an in-memory audit store. The extension received `eth_signTypedData_v4` and its signing popup showed the ProofGuard domain, Base chain ID `8453`, and the exact `to`, `value`, and `deadline` from the permit. Enkrypt labeled this request `Token Approval Signature`. The detailed view showed the ProofGuard payload. The temporary wallet signed it, `/api/execute` verified and consumed the expected permit with status `simulated`, and a second submission returned HTTP `422` with `Permit nonce already consumed`. This browser check used zero Router calls and broadcast zero transactions.

## Public testnet evidence recorded 2026-11-19

[Safe](https://sepolia.basescan.org/address/0xCa9668a104C1c4c3Fb8224cCdAB230DBd95949dF) and [Guard](https://sepolia.basescan.org/address/0xF8969fd65bDBb525d66B5e191759fcB59034310C) were deployed on Base Sepolia. At block `60669271`, the Safe had one owner and held 20 test USDC and 0.004835190896099889 test ETH. The expected Guard was enabled as the execution module and installed in both Safe guard slots. A read-only simulation against the public Safe reverted with `MissingPermit` for an owner transaction without a permit.

The first funded observation stopped when the best quote deviated from the independent price by 306 bps at block `60666975`. It used zero Router requests. A second attempt obtained an in-policy quote. The rule checks passed for the bounded USDC allowance, and both 0G responses carried Router verification. The primary allowed the action and the critic vetoed it. ProofGuard withheld the permit, and the Agent broadcast no transaction. The persistent budget recorded two requests. [The audit fix](../../.specify/bugs/blocked-review-audit/fix.md) now retains the final reviewer explanations for blocked decisions. That change passed 58 application tests.

On 2026-11-19 at 10:40 China Standard Time, an observation opened at block `60670757` with Agent nonce zero. It [skipped out-of-policy quotes](../../.specify/bugs/no-quote-observation/fix.md) until a valid quote became available. At 11:31 it stopped after the reviewer vetoed the first bounded approval, citing the 30.05% starting exposure against the 35–45% target band. No transaction was broadcast. The persistent budget recorded four requests in total.

An 11:33 observation started at block `60686792` with the [clarified corrective mandate](../../.specify/bugs/testnet-recovery-mandate/fix.md). The two limited approvals confirmed at blocks `60686975` and `60687111`, each with a matching Guard receipt. The swap review passed its deterministic checks and the primary model allowed it. The critic vetoed the swap, citing the output amount. The observation stopped at 11:35 without a swap. The [review prompt now includes decimal token amounts](../../.specify/bugs/swap-review-amount-units/fix.md), with 58 local tests and the production build passing. Ten of 12 Router requests were used in total. A fresh 24-hour window, a confirmed rebalance and a verified recipient rejection remain required.

At block `60704274`, a read-only Agent tick found an in-policy quote for a 2.791863-USDC rebalance. The existing ERC-20 allowance covered the input. The Permit2 allowance expired, which made six requests the expected minimum under that snapshot. The [launcher now checks the budget ledger before startup](../../.specify/bugs/testnet-budget-preflight/fix.md). With two of twelve requests remaining it refuses before any paid call, since even a run with live allowances requires both a swap review and a recipient-rejection review.

A feasibility check for the proposed split on 2026-11-19 used a read-only Agent tick at Base Sepolia block `60726179` and the authenticated loopback API in Demo mode. The real quote supplied a normal rebalance proposal, which the local Demo returned as `ALLOW` with a simulated permit. The zero-value invalid recipient returned `BLOCK` with no permit. Both reviews used current chain data and made zero Router calls. The public budget remained at ten reservations. The operator subsequently required live dual-model review for all transactions during the separate 24-hour run.

The [authorized Base Sepolia short run](../../.specify/bugs/swap-review-amount-units/fix.md#public-short-run) passed in the committed three-step sequence. There are six new requests and $0.023095 in actual charges. The cumulative short-acceptance ledger is at 16 of 18. The 24-hour criterion stays live-only and has a separate budget request. The short results do not complete the 24-hour window.

For the 24-hour run, the Agent observes about every five minutes. A position within 35–45% ETH triggers zero requests. A cycle requiring two approval transactions records an anomaly and skips both. Three consecutive cycles with review attempts pause new submissions as a bug while observations continue. The verifier fails this trading check even if observations completed. Offline tests cover the cycle and verifier behavior. The proposed separate ceiling is 100 new Router requests or $1.50, whichever is reached first. Before starting, verify a pre-request dollar limit that covers both members of each review, including calls with incomplete receipts. The short-run authorization does not carry over.

## External evaluation access recorded 2026-11-19

The [GoPlus transaction simulation API](https://docs.gopluslabs.io/reference/gettransactionsecurityinfousingpost) returned a result for an unsigned zero-value Base mainnet control and rejected the same control on Base Sepolia with API code `400`. Its application response listed only Base mainnet, Ethereum mainnet and BNB Smart Chain. The [Blockaid transaction scanner](https://github.com/blockaid-official/blockaid-client-node/blob/main/api.md) requires an API key, which is absent from the workspace runtime. These checks establish access and chain coverage. The live labeled evaluation and comparable vendor metrics are still pending.

The [USDC approval fixture](../../eval/cases/base-usdc-approvals.json) pins 20 successful Base mainnet transactions from distinct senders to the same allowlisted Permit2 contract. The two control groups have ten direct approvals of at most 1,000 USDC and ten direct approvals of the maximum uint256 allowance. Every case has zero native value and a matching canonical receipt event. The allowance cap in the benchmark mandate determines the label. Run `node eval/base-approval-baseline.js` from the repository root to verify the case sources, apply the ProofGuard rule layer, and simulate the same unsigned public inputs with [GoPlus](https://docs.gopluslabs.io/reference/gettransactionsecurityinfousingpost).

| Approval group | ProofGuard deterministic policy | GoPlus public risk flags |
| --- | --- | --- |
| Bounded, `ALLOW` | 0/10 blocked (0% false positives) | 0/10 flagged |
| Unlimited, `BLOCK` | 10/10 blocked by the approval rule (100% recall) | 0/10 flagged |

On 2026-11-19 at 04:02 UTC, GoPlus returned all 20 expected allowances in successful simulations. ProofGuard valued USDC at one dollar and GoPlus simulated current chain state. The source fixture SHA-256 was `e3beb3d704839161bab1eb8c66b10ec1c7bb329f19fd901773f81c5b61179f64`. The GoPlus flag counts reflect the vendor's public risk signals. The ProofGuard counts measure enforcement of the benchmark's private spending cap. General performance, the live committee, additional transaction classes, and the Blockaid baseline require additional evidence.

The exact historical swap veto has a separate [offline regression](../../.specify/bugs/swap-review-amount-units/fix.md). The operator since approved a one-time three-step Base Sepolia run with six additional requests and a cumulative cap of 18. The 24-hour acceptance still requires live review for every transaction and has a separate pending budget. Mainnet release remains gated by an independent audit.

`node eval/mandate-controls.js` builds 15 internal controls with independently labeled in-band purchases, swaps in the wrong direction, and corrective swaps that overshoot the opposite boundary. Each input passes the deterministic policy and is labeled `BLOCK` for mandate review. A separate [Base Sepolia reference set](../../eval/cases/base-sepolia-usdc-approvals.json) pins 12 mined USDC approvals with matching successful receipts and distinct originators. Current results for synthetic controls are internal diagnostics. Paid semantic evaluation requires separate authorization.

### Live approval committee evaluation

`node eval/base-approval-baseline.js --committee-plan` verified all 20 on-chain sources, the two independent labels and a 40-request plan with zero paid reservations. For an authorized live evaluation, the runner uses the explicitly configured `PROOFGUARD_APPROVAL_EVAL_API_KEY` and the options `--live-committee --max-router-requests=40 --journal=<new-path>`. It verifies every source before opening the journal. For each case it records the paired reservation before inference, then saves the result and receipt IDs. The cap applies to one invocation and the journal path must be new. This measurement has a separate budget from Base Sepolia acceptance.

The reviewers receive the same benchmark mandate for each class, with the matched sender and the exact decoded amounts. The report separates rule and committee blocks, shared mistakes, disagreements, and inconclusive receipts. Latency percentiles run from the rule layer to verified verdict or in-memory permit compilation. Per-response token counts and [reported billing](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/web-fetch) are recorded when available. The summary preserves separate micro-USD and 0G wei totals with reported-response counts. The benchmark has no signer and does not submit transactions.

The application suite passed 59 tests, covering a verified model disagreement, unconfirmed receipts and exact billing totals. A full 20-case run with mocked Router responses completed all 40 reservations and preserved the per-case outputs in its separate journal. With a two-request cap startup refused before creating a journal. Live committee outcomes and real charges still need an authorized run.

## Base swap coverage recorded 2026-11-19

The [swap fixture](../../eval/cases/base-usdc-weth-swaps.json) pins 30 direct Base mainnet USDC/WETH exchanges from 20 senders in a fixed scan range of blocks `59181683` through `59341682`, with at most three per sender. Every source is verified against its successful receipt, one [factory-registered V3 pool](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments), and the exact reciprocal transfer amounts between that pool and the transaction sender. Run `node eval/base-swap-coverage.js` to reproduce the verification and compare the decoder with receipts. Run it with `--discover` to reproduce selection from the fixed range.

| Compatibility measure | Result |
| --- | --- |
| Current Router registry | 8/30 targeted the registered V2 deployment. The other 22 targeted [V2.1.2](https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/base.json). |
| Decoded input and output agree with the receipt | 8/30. The other 22 failed target registration. |
| Canonical outer ABI envelope | 0/30. All 30 had a canonical prefix followed by additional data. Thirteen had 10 extra bytes and seventeen had 22. |

The source fixture SHA-256 is `002c1b6300976cf1b4cddf17dc916a8cd193516d79e056ec4ae694ae7cb0575c`. These results measure current decoder compatibility in the sampled deployment and pool set. A policy-level `ALLOW` label requires the benchmark mandate and price evidence at execution time. The sample gives no estimate of broad swap false-positive rates. This read-only evaluation did not invoke models or submit transactions.

### Historical quote and price verification

Run `node eval/base-swap-coverage.js --pricing` to price the same pinned receipts at the immediately preceding Base block. The verifier checks each original V3 command's path and amount bounds against the receipt. It records [QuoterV2](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments) exact-input or exact-output terms, the parent block hash, and the [Chainlink](https://docs.chain.link/data-feeds/historical-data) ETH/USD and USDC/USD feed rounds. It uses the parent block's timestamp, with maximum feed ages of one hour for ETH/USD and 25 hours for USDC/USD. For one-hop V2.1.x commands the calculation incorporates any [per-hop minimum price](https://github.com/Uniswap/universal-router/blob/802fe4c/contracts/modules/uniswap/v3/V3SwapRouter.sol). All 22 V2.1.2 samples had this protection disabled.

| Router in sample | Maximum adverse slippage permitted by calldata | Quote deviation from Chainlink values | Within benchmark limits |
| --- | --- | --- | --- |
| V2, 8 swaps | 25–27 bps | 1–17 bps | 8/8 |
| V2.1.2, 22 swaps | 240–253 bps | 1–21 bps | 0/22 |

The 2026-11-19 run at 04:28 UTC had zero inconclusive prices. All 30 parent-block quotes could satisfy the encoded amount bounds and met the USD 10,000 value cap and the 300 bps price-deviation limit. Twenty-two exceeded the 75 bps slippage tolerance, based on the maximum adverse slippage the submitted bounds permit. The calculation uses parent-block state and describes transaction limits. Full policy labeling still requires an applicable owner mandate and independently verified treatment of the envelope and other effects. Router registration and live acceptance were unchanged.
