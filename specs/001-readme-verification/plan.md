# Verification plan

1. Establish the clean-clone baseline and map README promises to actual API routes, model requests, policy data, wallet signature and browser evidence.
2. Enforce complete input and reviewer contracts at the existing decision boundary. Compare the implementation with the official 0G Router Chat Completions, Provider Routing and Verifiable Execution references. Keep deterministic no-key demo paths separate from live calls.
3. Bind the operator-configured owner to policy and permit. Check it alongside transaction, expiry and use within the simulator's synchronous consume path. Record disabled consumption when the owner is unconfigured.
4. Keep the existing UI, tests and smoke entry point. Display actual evidence and permit state; update instructions and remove unsupported claims.
5. Validate through Vitest, controlled HTTP fixtures, independently computed SHA-256 values, production browser UI and a disposable wallet. Live acceptance uses a user-authorized API key and the built-in synthetic scenarios only. Save exact acceptance results without key material.

Original materials: Git tree, npm lockfile, demo fixtures, raw Router headers/body, byte strings signed by the demo wallet, HTTP responses, and official model catalog. Independent live oracle: Router usage IDs plus the official SDK or verification procedure against provider signatures and onchain signer records. Official references: https://pc.0g.ai/models and https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution.
