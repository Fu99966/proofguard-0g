# ProofGuard README conformance

Baseline: origin/main at 0628899d5f79d31fd67a64fb95b3a1ebdf93989b. Scope: the existing local/sponsor demonstration and HTTP API described in README.md. The roadmap remains future work.

- **FR-001:** Keep the four no-key scenarios runnable. A safe swap produces a simulated permit; the other three return BLOCK and no permit. Force-demo suppresses outbound inference even when a key exists.
- **FR-002:** Live reviews send two parallel private requests to distinct configured 0G model IDs at the official Router, request TEE verification, and require two valid, complete ALLOW votes plus deterministic approval. Invalid proposal fields block before inference. Reviewer veto, timeout, invalid model output or absent/failed TEE verification never yields a permit.
- **FR-003:** Preserve per-reviewer response ID, Router request ID, provider address and chat ID when returned. Report verification provenance accurately. SHA-256 commitments cover transaction, policy and exact ordered reviewer output. A byte change fails comparison against the original hash.
- **FR-004:** The simulator checks the exact proposal, expiry, one-time use and the signer configured by the operator. Missing signer configuration leaves review usable and consumption unavailable. No broadcast or funds movement.
- **FR-005:** README, technical notes, smoke script and UI accurately describe the supported flow, availability and evidence. Proposal metadata is reviewed as provided; no claims of ABI decoding, oracle validation, execution enforcement outside the simulation or independent TEE verification without evidence.

Acceptance requires npm ci, unit and HTTP tests, a production build, independent hash recomputation, and real browser checks of the four scenarios and evidence views. Live acceptance separately requires two synthetic scenarios through the real Router and response evidence correlated with official usage records, plus independent signature verification when the required material is available. Report each as verified, partial or failed.
