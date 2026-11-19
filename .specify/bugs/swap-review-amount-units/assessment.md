# 0G swap review receives amounts in atomic units

- Slug `swap-review-amount-units`
- Assessed 2026-11-19
- Verdict valid
- Severity high for public testnet acceptance

## Evidence

The Base Sepolia observation confirmed both bounded approvals. The subsequent USDC-to-WETH swap passed the deterministic checks and its first reviewer allowed it. The Router-verified critic rejected the swap, citing an impossible output relative to the portfolio value. ProofGuard withheld the permit. The observation stopped without broadcasting the swap.

The decoded `maxIn` was `2843095` and `minOut` was `1550800118086990`. The registered token precisions are 6 for USDC and 18 for WETH, yielding 2.843095 USDC and 0.001550800118086990 WETH. The quote was 280 bps from the independent reference and the worst slippage was 26 bps. The review prompt provided the raw amounts and the policy asset table separately. Unit interpretation is a probable contributor based on the recorded explanation.

## Plan and verification

Add decimal quantities with token symbols to trusted decoded swaps in both reviewer prompts. Keep the raw transaction amounts and the existing policy gates. Extend the HTTP test for both reviewers to check the atomic and decimal representations. Run the application suite and production build. Record the live result separately after a funded replay fits the authorized Router cap.

On 2026-11-19 the operator asked for a replay of the specific refused Base Sepolia swap with zero 0G requests. Recheck the QuoterV2 amount and Chainlink answer at the archived audit block, then feed those exact facts through the original calldata decoder and rule engine. Include the independent router quote and USD values for the amount bounds in each blind prompt. Use the captured veto to exercise enforcement offline and separately test approval under a fixture committee. The fixture can validate payload construction and enforcement. The critic's live response after the change remains unmeasured.
