# Public HTTP controls verification

Status **verified locally**. 公网安全项 **不适用：无公网部署**。

- `POST /api/review` applies the Agent bearer check before JSON parsing and allows 30 requests per Agent key per minute. `GET /api/audit/:hash` requires the same kind of bearer key and has an independent 60-per-minute quota by key. Bad or missing keys return 401. Requests beyond the applicable limit return 429 with a retry interval. Browser preflights reach CORS without a bearer key.
- The fixed local presets keep their 30-per-minute limit per connection IP and use deterministic rules, including when Agent dual-model review is configured. Signature-based simulation and commitment verification each allow 60 requests per minute per connection IP, with the limits applied before parsing. Simulated execution requires a configured owner’s signature and an unused Permit.
- The exact HTTP(S) origin whitelist rejects wildcards, opaque origins and paths at startup. HTTP tests verified `204` and the exact CORS header on allowed preflights, `403` without an allow-origin header on denied preflights, and a cache variant per Origin. The API keeps its direct same-origin allowance. Set `PROOFGUARD_FRONTEND_ORIGINS` to the exact public HTTPS origin for a TLS-terminating ingress. Client-supplied forwarded host and protocol are ignored.
- Docker and Cloud Run are optional and are not recommended for the local installation. A staged Node runtime using the final image stage's file layout returned successful health and expected CORS and bearer results during the previous check.
- The full Vitest suite passed 101 tests. The network guard in the public demo tests observed no Router requests. No hosted settings were changed.

The default limiter applies per process and uses the socket peer for unauthenticated routes. The recommended installation binds to `127.0.0.1` and retains authentication, rate limits and exact Origin validation.

[Cloud Run runtime contract](https://docs.cloud.google.com/run/docs/container-contract) · [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/) · [Rate-limit store behavior](https://express-rate-limit.mintlify.app/reference/stores)
