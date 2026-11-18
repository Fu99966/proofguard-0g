# Tasks and verification

- [x] T001 Pin Git baseline and run the unchanged unit suite and production build on Node 22.23.5. Both passed, including 10 existing unit tests.
- [x] T002 Enforce deterministic inputs, independent live committee votes and accurate 0G evidence (FR-001–003).
- [x] T003 Bind and consume signed permits against the operator owner and original proposal (FR-004).
- [x] T004 Align UI, README, technical notes and the live smoke command with supported behavior (FR-001–005).
- [x] T005 Verify unit/HTTP cases, independent commitments, production build and browser flows (FR-001–005).
- [x] T006 Verify the actual two-model Router responses with a funded, authorized local key and synthetic inputs. Twelve authorized requests across three rounds. The final four requests verified the now-approved Flash and SIA defaults. Independent signer recovery passed for both providers; independent content binding passed for Flash, with SIA limited to Router verification.

- [x] T007 Apply the approved default primary `glm-5.3-flash` (FR-002, FR-005). Preserve SIA, Private/TeeML, two explicit Router confirmations, and existing model overrides. Align setup and runbooks, then verify both scenarios by replaying the already-authorized live captures under the actual defaults. No additional paid calls.

## Verification recorded 2026-11-18

| Scope | Status | Evidence |
| --- | --- | --- |
| FR-001, FR-002 | Verified locally | Vitest over the real HTTP handler with controlled Router responses. The four demo scenarios returned ALLOW, BLOCK, BLOCK, BLOCK. Verified private and TEE request options, independent deterministic veto, provider veto, missing/failed TEE verification, invalid response, HTTP failure, simulated timeout, invalid input and force-demo. |
| FR-003 | Verified locally | Independently normalized and hashed transaction, policy and exact reviewer contents. Browser displayed the three commitments and flagged the one-byte change. |
| FR-004 | Verified locally | Ephemeral EVM wallets signed the same bytes supplied to browser personal_sign. An unconfigured server showed review-only, a configured server rejected a mismatched signer and changed proposal, two concurrent valid requests yielded one consumption, and expiry rejected consumption at 300 seconds. |
| FR-005 | Verified locally | npm ci, 22 passing tests and Vite production build on Node 22.23.5. Chrome production app exercised all four scenarios and the evidence views, and the 390 px viewport completed the safe-swap flow with a visible demo label. |
| Real Router and provider signature | Partial | Four approved requests returned HTTP 200 and request identifiers. All ended at the 700-token cap, so neither scenario produced a complete decision and live smoke exited 1. The Router reported TEE verification for both critic responses and no confirming flag for either primary response. All four signatures independently recovered the acknowledged signer registered by 0G, but binding to the exact returned completion content was not established. |

Public Router preflight confirmed that `GET /v1/models` lists the lowercase IDs `0gm-1.0-35b-a3b` and `0gm-1.0-35b-a3b-sia`, and `GET /v1/providers?model=…` listed one TeeML provider for each at the time of the check. The adapter now uses those IDs and accepts prior uppercase settings. HTTP regression checks verify canonical requests from prior settings and reject responses from a different model. The updated suite passed all 23 tests and the Vite production build.

The controlled Router fixture and public catalog verify client behavior and availability only. Live acceptance remains T006.

The truncation fix increases the budget to 4,096 and passes the 24-test suite and production build. The separately authorized retest verified that all four responses completed under the increased limit. See [live verdict truncation assessment](../../.specify/bugs/live-verdict-truncation/assessment.md).

The second run also identified a SIA parser variation. The completed responses were replayed through HTTP after the compatibility fix. Expected model votes were recovered in both scenarios. The injection decision was BLOCK. A safe permit is still unavailable because the native primary omits the explicit per-response TEE verification flag. Independent signer recovery matched on all four responses, but exact response binding could not be established with the material returned on this route. Status: partial. See [SIA verdict delimiter verification](../../.specify/bugs/sia-verdict-delimiter/test.md).

The 0G activity dashboard was checked on 2026-11-18. All eight recorded calls appeared as Private for the expected models and providers. The dashboard totals of 7,112 input tokens and 9,943 output tokens matched the two local Router captures, including each model's four completion-token counts. This verifies usage correlation. The dashboard does not supply the missing per-response TEE verification result.

A redacted inquiry about the primary model's missing verification field was confirmed in Sent on 2026-11-18 at 18:13 China Standard Time. A response from 0G could clarify the former primary's encrypted route; it is not needed for the verified Flash/SIA pair.

## Live alternative-primary acceptance

On 2026-11-18, one authorized four-request smoke run temporarily selected `glm-5.3-flash` as primary and kept `0gm-1.0-35b-a3b-sia` as critic. No saved model settings changed.

| Check | Result |
| --- | --- |
| Router | Four HTTP 200, complete verdicts and distinct request IDs. Every response had `tee_verified: true`. Both providers were registered, acknowledged TeeML services. |
| Smoke | Safe swap: both ALLOW and a simulated permit issued. Prompt injection: both BLOCK and no permit. Process exit 0. |
| HTTP replay | Exact captured Router responses produced the same permit outcomes. An ephemeral configured wallet consumed the safe permit once through the simulator; the next consume returned 422. |
| Official usage | Four new Private records match both models, providers, and the per-call usage values. Total for this run: 3,424 input and 4,745 completion tokens. |
| Independent proof | All four EIP-191 signatures recovered their acknowledged registry signer. For both Flash responses, the signed response digest matched the reserialized response with only Router trace metadata removed. SIA signatures matched registered identity, but digest binding to the observed Router response could not be established. This does not change the four Router confirmation results. |

Live acceptance is verified for this committee under the Router verification policy. The user subsequently approved Flash as the default primary. The earlier native-primary result remains partial and is recorded separately above.

## Approved default

Updated the runtime defaults, setup examples and technical and demo instructions to use Flash and SIA. Migrated the local old-primary setting without changing credentials. The former primary remains an explicit override and must still satisfy the same verification gates. The tested default pair is Private/TeeML; equivalent end-to-end encrypted transit for Flash was not established.

With no model overrides, the smoke runner reproduced all four original authorized request bodies byte for byte. Replaying their exact response bodies produced ALLOW for safe swap and BLOCK for prompt injection, with four verified Router responses. The full suite passed 25 tests and the Vite production build. No additional inference requests were sent.

GitHub handoff, if approved: push the local `codex/readme-verification` branch and create a draft pull request to `main`.
