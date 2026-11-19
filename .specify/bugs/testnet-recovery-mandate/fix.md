# Verification of the corrective trading mandate

- Verified 2026-11-19 for bounded approvals on Base Sepolia.
- The testnet mandate describes how to return to the 40% target when exposure is outside the band and allows bounded preparatory approvals to registered spenders.
- The authenticated HTTP regression test checks that both reviewers receive this mandate and the independently sourced portfolio facts. All 58 application tests passed.
- The live repeat confirmed the [USDC allowance to Permit2](https://sepolia.basescan.org/tx/0x50a727c82be7bfc6d72e0e26f35f9c4c7f7b04b2740d710e225fcb513095c745) and the [Permit2 allowance to the router](https://sepolia.basescan.org/tx/0x21255630f1fa7ed24989f41330eb103caedc514d54bb7c4919038acdd52f2174). Both had two verified ALLOW reviews and matching on-chain permit consumption.
- The subsequent swap was vetoed over the interpreted output amount. Its verification is tracked in the [amount units assessment](../swap-review-amount-units/assessment.md).
