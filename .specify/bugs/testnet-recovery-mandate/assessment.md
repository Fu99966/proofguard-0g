# Testnet mandate omits recovery from outside the target band

- Slug `testnet-recovery-mandate`
- Assessed 2026-11-19
- Verdict valid
- Severity high for public testnet acceptance

## Evidence

The funded Agent obtained a quote within the independent-price limit at block `60685868`. Its first proposal was a bounded ERC-20 approval of 2.843095 USDC to registered Permit2. Deterministic checks passed. The primary reviewer allowed it. The Router-verified critic rejected it because observed ETH exposure was 30.05%, outside the 35–45% target. The veto was enforced. The Agent broadcast no transaction, and the observer ended.

The written plan calls for the Agent to initiate a corrective swap when exposure moves outside the band. The testnet owner policy inherited a short mandate that only describes maintaining the range. An ERC-20 approval is a required preparatory action and has no immediate exposure effect.

## Plan and verification

State the recovery policy in the authoritative Base Sepolia mandate. Explain the 40% target, allow steps toward it, and specify that capped approvals to registered spenders can prepare those swaps. Keep the existing amount, spender, chain, recipient, valuation, simulation, and dual-review checks. Verify both reviewers receive the mandate together with independently supplied portfolio facts in a mocked HTTP test. Verify locally before opening a new funded observation. The persistent Router budget currently has four reservations against its 12-request cap.
