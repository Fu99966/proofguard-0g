# Observation exits when no quote meets the price limit

- Slug `no-quote-observation`
- Assessed 2026-11-19
- Verdict valid
- Severity medium

## Evidence and reproduction

The funded rebalance runner reached a valid Base Sepolia position at block `60666975`. Every configured Uniswap V3 pool exceeded the 300 bps independent-price deviation limit. The best quote deviated by 306 bps. Subsequent read-only checks reproduced the absence of an eligible quote. The 24-hour runner aborted before any review and did not record another position.

## Plan and verification

An absent eligible quote is a decision to wait. In the 24-hour runner, record that decision and return to the observation loop. Keep the failure exit for the one-shot command so it can serve as a strict preflight. The existing verifier must still find a real rebalance, a recipient refusal and the full observation interval before reporting success. Verify the application suite, the strict read-only preflight, and the first observed position and skipped quote in a live process when the market reproduces the condition.
