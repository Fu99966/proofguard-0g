# Live 0G verdicts truncate at the output limit

2026-11-18 · Baseline 533c277 · Existing acceptance T006

- Reproduction: run the approved two-scenario live smoke with the two configured private models.
- Observed: all four responses were HTTP 200, reported 700 completion tokens, and ended with `finish_reason: length`. The primary returned no final content and reported 701 and 703 reasoning tokens. The critic returned truncated content. Neither review issued a permit; the command exited 1.
- Cause: the adapter set `max_tokens: 700`, leaving no room for a final structured verdict when the model spends that budget reasoning. The initial evidence also shows a separate unknown: the primary omitted a confirming TEE flag on both incomplete responses.
- Remediation: raise the bounded budget to 4,096 tokens, allow 90 seconds for responses, request compact final JSON, and explicitly identify truncation while continuing to fail closed. Confirm the original live scenarios only in a newly authorized four-request run.
- Independent evidence: read 0G's mainnet serving registry and the two providers' signature endpoints. All four EIP-191 signatures recovered the registered, acknowledged signer. The signed payload is not the exact completion text, and the content binding is unconfirmed. Separate that result from Router TEE flags and application verdicts.
