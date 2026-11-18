# SIA output uses an unmatched closing reasoning delimiter

2026-11-18 · Live acceptance T006

On the second authorized live run, all four responses ended normally under the 4,096-token limit. The primary's final content parsed directly. Both SIA responses used a single closing `</think>` delimiter without an opening tag, followed by valid JSON. The existing paired-tag parser rejected both responses.

The primary still omitted `x_0g_trace.tee_verified` after normal completion. SIA returned `true` for both responses. Direct signature checks recovered the acknowledged signer for all four responses. Neither the exact Router bytes nor a reserialization without its trace matched the signed payload digest. The primary signs sealed transport bytes. The public 0G gateway uses a transit header to report the transport path, and its source explicitly says this header does not attest per-response signature verification. The public Router client did not receive the original provider-side sealed bytes or an alternate documented per-response assertion. See [0G gateway marker source](https://github.com/0gfoundation/0g-pc-e2ee/blob/main/client/openaiproxy/e2eemark.go).

Fix scope: recognize this wire-format variation only for the known SIA model. Keep one exact JSON verdict, finish reason validation, and both TEE requirements.

## Hosted gateway preflight

0G's [gateway verifier guide](https://github.com/0gfoundation/0g-pc-e2ee/blob/main/docs/verifying-the-gateway.md) describes attesting the gateway's identity, TLS endpoint and deployed configuration. The [trust chain](https://github.com/0gfoundation/0g-pc-e2ee/blob/main/docs/design/trust-chain.md) describes per-response signature enforcement as a deployment option. On 2026-11-18 the hosted Router returned a self-reported gateway identity (HTTP 200), but its deployed app-compose endpoint returned HTTP 404 and the documented platform attestation lookup returned HTTP 401 without credentials. No deployment attestation or request-specific response binding was established by this preflight. Application acceptance remains unchanged.
