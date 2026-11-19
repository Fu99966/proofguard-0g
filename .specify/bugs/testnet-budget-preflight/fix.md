# Verification of the review budget startup check

- Verified 2026-11-19 for startup refusal with insufficient review capacity.
- The default preflight reads the existing budget scope in read-only mode. It reports the cap, requests reserved, requests remaining, and the minimum requests for the two mandatory committee reviews.
- A startup request with the real ledger at 10 of 12 returned exit code 1 and cited the four-request minimum. This check used a disabled Router key. It ended before the launcher started deployment, the local review API, or the Agent.
- The existing restart test covers a missing database, a new budget, two persistent reservations, isolation between scopes, and rejection after restart. The 58-test application suite passed.
- In the read-only market check at block `60704274`, the Agent selected a 2.791863-USDC buy through the 100-fee pool. The existing USDC allowance covered it. The Permit2 allowance had expired. That snapshot called for six requests in total for Permit2 renewal, swap review and rejection review. Market and allowance conditions may change before startup.
