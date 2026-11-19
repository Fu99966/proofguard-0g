# Verification of swap quantities in review requests

- Status verified as of 2026-11-19. The revised prompts passed the offline replay and the authorized live Base Sepolia short run.
- Both reviewers now receive decimal input and output bounds with symbols from the network's registered assets. The prompt also carries the original decoded atomic amounts. The changes are limited to the reviewer payload.
- The API regression verifies that the two requests both contain `2400.0 USDC` and `0.996 WETH` alongside the corresponding raw amounts. The 58-test application suite and production build passed.
- The original proposal and policy hashes were reconstructed from the recorded facts and matched the audit. At archived Base Sepolia block `60687118`, the real V3 quote was 0.001554686835174928 WETH for 2.843095 USDC. The minimum from calldata was 0.001550800118086990 WETH, or USD 2.756640 at the recorded Chainlink ETH/USD price of 1777.56. Both independent price deviation (280 bps) and adverse slippage (26 bps) met policy. The raw quote was constant from initial pricing through both approval confirmations. The critic's stated numerical objection is unsupported. Ambiguous units and absent like-for-like quote evidence are the likely prompt contributors.
- The corrected prompt supplies the normalized quote and USD comparisons to both reviewers. The offline fixture replays the original calldata and price facts, verifies both prompts, confirms that a captured veto still withholds a permit, and confirms in-memory permit creation with two fixture approvals. The 61-test suite passed before the live short run below.
- The prior veto issued no permit and no swap was broadcast. The investigation and offline regression used no paid calls.

## Public short run

The acceptance ledger pins commit `c05289a163dd67a3f8a0c4c9e7aa4ab6558b3582` and run `c76ff42a-b15a-4d9f-a82d-03692bcb0beb`. The short run used a fresh quote for a 2.782633-USDC rebalance. The market recorded 26 bps slippage and 175 bps independent price deviation. The original incident used 2.843095 USDC and the policy recorded 26 and 280 bps. Both quotes were in policy. The distinct live proposals establish a successful regression scenario. The exact historical input was replayed offline.

| Review | Prior live decision | Revised live decision | Revised Router request |
| --- | --- | --- | --- |
| Flash primary | `ALLOW` | `ALLOW` | `369459ee-42a2-4439-ae3f-e328229062db` |
| SIA critic | `BLOCK` over the interpreted minimum output | `ALLOW` for a bounded adjustment from 30.30% toward 40% ETH | `08d008c7-a3b7-4fbf-8251-ba8772d5ff05` |

The [renewal](https://sepolia.basescan.org/tx/0x10a686f7278526f04ff9b762d3bd6a41d74afe96159fbea00eb37bbd36bbab9b) covered the exact input and had 173,363 seconds remaining at confirmation. The [swap](https://sepolia.basescan.org/tx/0xc4996aaefe4481d3f4f259a72dd85b13fe32243b167f6f01b20b20020910f074) confirmed with its Guard permit receipt. ETH exposure reached 39.89%. The final invalid-recipient review returned two Router-verified `BLOCK` decisions without a permit. The run used six requests with $0.023095 in reported charges, ending at 16 reservations against the cumulative cap of 18.
