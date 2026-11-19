# Testnet acceptance starts with insufficient review budget

- Slug `testnet-budget-preflight`
- Assessed 2026-11-19
- Verdict valid
- Severity high for public testnet acceptance

## Evidence

The launcher applies the persistent request cap inside the API. It currently starts the observer even when the budget ledger already holds ten reservations against the cap of twelve. A fresh passing observation must include two distinct committee reviews, one for the confirmed rebalance and one for the verified recipient rejection. The API reserves two requests per review. With only two requests left, a fresh run can spend the remainder and still fail its required evidence checks.

At Base Sepolia block `60704274`, a read-only Agent tick obtained a quote within the independent price limit for 2.791863 USDC. The existing ERC-20 allowance to Permit2 was 2.843095 USDC. The router allowance inside Permit2 expired at `03:49:25 UTC`. At that block a successful run therefore needed three reviews for Permit2 renewal, execution and rejection evidence. The budget ledger allowed only one.

## Plan and verification

Have the launcher read the persisted usage without creating or migrating the database. Print usage and remaining capacity in the default preflight. Refuse startup when the budget cannot cover even the two required committee reviews, before deployment or any paid request. The current quote and allowances remain optional context because they can change during a fresh observation. Preserve the API's atomic enforcement and the existing authorized cap. Check missing and persisted ledgers in the existing restart test, then verify the real preflight and its startup refusal with the Router key disabled.
