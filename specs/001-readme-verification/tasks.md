# Tasks and verification

- [x] T001 Pin Git baseline and run the unchanged unit suite and production build on Node 22.23.5. Both passed, including 10 existing unit tests.
- [x] T002 Enforce deterministic inputs, independent live committee votes and accurate 0G evidence (FR-001–003).
- [x] T003 Bind and consume signed permits against the operator owner and original proposal (FR-004).
- [x] T004 Align UI, README, technical notes and the live smoke command with supported behavior (FR-001–005).
- [x] T005 Verify unit/HTTP cases, independent commitments, production build and browser flows (FR-001–005).
- [ ] T006 Verify the actual two-model Router responses with a funded, authorized local key and synthetic inputs. Four requests authorized. Pending local credentials. Independently verify provider signature evidence as documented when exposed.

## Verification recorded 2026-11-18

| Scope | Status | Evidence |
| --- | --- | --- |
| FR-001, FR-002 | Verified locally | Vitest over the real HTTP handler with controlled Router responses. The four demo scenarios returned ALLOW, BLOCK, BLOCK, BLOCK. Verified private and TEE request options, independent deterministic veto, provider veto, missing/failed TEE verification, invalid response, HTTP failure, simulated timeout, invalid input and force-demo. |
| FR-003 | Verified locally | Independently normalized and hashed transaction, policy and exact reviewer contents. Browser displayed the three commitments and flagged the one-byte change. |
| FR-004 | Verified locally | Ephemeral EVM wallets signed the same bytes supplied to browser personal_sign. An unconfigured server showed review-only, a configured server rejected a mismatched signer and changed proposal, two concurrent valid requests yielded one consumption, and expiry rejected consumption at 300 seconds. |
| FR-005 | Verified locally | npm ci, 22 passing tests and Vite production build on Node 22.23.5. Chrome production app exercised all four scenarios and the evidence views, and the 390 px viewport completed the safe-swap flow with a visible demo label. |
| Real Router and provider signature | Partial | Official Router contract and model catalog checked. Four synthetic calls approved, but no local ZERO_G_API_KEY was configured. No paid calls made and no independent live provider signature checked. |

Public Router preflight confirmed that `GET /v1/models` lists the lowercase IDs `0gm-1.0-35b-a3b` and `0gm-1.0-35b-a3b-sia`, and `GET /v1/providers?model=…` listed one TeeML provider for each at the time of the check. The adapter now uses those IDs and accepts prior uppercase settings. HTTP regression checks verify canonical requests from prior settings and reject responses from a different model. The updated suite passed all 23 tests and the Vite production build.

The controlled Router fixture and public catalog verify client behavior and availability only. Live acceptance remains T006.
