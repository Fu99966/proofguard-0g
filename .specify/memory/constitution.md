# ProofGuard Constitution

1. **Unanimous authorization.** Two distinct private reviewers and the deterministic owner policy must agree for live permit issuance. Missing, invalid or unverified reviewer evidence fails closed.
2. **Explicit evidence.** Preserve per-reviewer provenance and distinguish simulation, a local SHA-256 commitment, Router verification and independent provider-signature verification.
3. **Bounded execution.** A permit binds a proposal, policy, model responses, optional configured signer, expiration and nonce. The included executor is an in-memory simulation.
4. **Reproducibility.** Changes to authorization and evidence require reproducible regression checks. Use synthetic transactions and disposable wallets for local verification. Keep credentials outside source control.

Version 1.0.0 · 2026-11-18
