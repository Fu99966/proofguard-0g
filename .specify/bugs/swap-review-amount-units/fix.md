# Verification of swap quantities in review requests

- Status partial as of 2026-11-19. Local verification passed. The live repeat is pending.
- Both reviewers now receive decimal input and output bounds with symbols from the network's registered assets. The prompt also carries the original decoded atomic amounts. The changes are limited to the reviewer payload.
- The API regression verifies that the two requests both contain `2400.0 USDC` and `0.996 WETH` alongside the corresponding raw amounts. The 58-test application suite and production build passed.
- The prior veto issued no permit and no swap was broadcast. The persistent ledger records 10 of 12 authorized requests reserved. Two further dual reviews for the swap and recipient rejection require at least four requests. Confirm the increased cap before starting the live replay.
