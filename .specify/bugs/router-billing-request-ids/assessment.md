# Router billing request identifiers

During the two-hour Base Sepolia run at revision `5cbb113e98ebb575a074c21b28f0010c09718af5`, the first review pair failed at the response correlation check. The ledger retained both full reservations and issued no Permit. The official 0G activity export records the two successful charges in that interval.

Reproduce with two valid bounded Router responses whose HTTP `X-Request-ID` differs from `x_0g_trace.request_id`. The HTTP identifier is correlation metadata. The trace identifier belongs to the provider evidence and is used for billing and receipt reconciliation. A requirement that those strings match made valid responses fail before settlement. The official short-run trace identifiers also match the activity export.

Record both identifiers separately, keyed to the existing proposal and model reservation. Require a unique trace request ID, enforce existing price and token checks, and retain the hard stop for a missing receipt or charge mismatch. Test differing HTTP and trace identifiers at the API entry point, successful charge settlement, and continued refusal to sign on billing inconsistency.
