# Fix

Raised the completion cap to 4,096 and the request deadline to 90 seconds. The prompt asks for a short JSON verdict over the submitted proposal metadata and states that abbreviated calldata is not execution evidence. The adapter rejects a completion marked `length` even if its content parses as ALLOW and the Router reports a verified signature. No permit or attestation requirements were relaxed.
