# ProofGuard project completeness

The operator adopted the 2026-11-18 completeness plan for ProofGuard and selected a full trading agent for phase three. The firewall stays independently authoritative over what the agent can execute. Use Base Sepolia for transaction submission and production acceptance before any mainnet plan.

- FR-001 Require canonical EVM transaction inputs. Decode allowlisted token, Permit2 and Universal Router calls. Block unsupported semantics, inconsistent legacy claims, unsafe recipients, source accounts or allowances, and missing independent valuation evidence.
- FR-002 Give both independent 0G reviewers the trusted owner mandate and decoded effects. Label proposer memo as untrusted and exclude deterministic votes from both prompts.
- FR-003 Require authenticated, rate-limited Agent review, restricted CORS, durable SQLite permits and decision records, atomic consumption, EIP-712 signatures and PR CI. Retain a zero-cost, clearly marked public demo.
- FR-004 Deliver a guarded SDK, custom calldata UI and Base Sepolia trading agent with independent market inputs, strategy, portfolio state and review-first execution. Verify 24 hours of testnet runs.
- FR-005 Enforce permits on a Safe, restrict the agent role, simulate balance changes and test missing, expired, replayed and modified permits. Verify on testnet before any mainnet operation. Third-party audit is a mainnet release gate.
- FR-006 Run a labeled repeatable evaluation and report measured recall and false-positive rate with sample size and scope.
