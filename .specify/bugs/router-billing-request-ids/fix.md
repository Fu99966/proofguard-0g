# Router billing request identifiers

Status **verified**. The initial two-hour attempt remains closed. The independently authorized continuation passed using the corrected billing identifiers.

Keep the HTTP correlation header with response metadata. Bind settlement to the unique `x_0g_trace.request_id` and retain the original amount and reservation checks. The API regression now gives each mock response distinct HTTP and billing identifiers, verifies exact settlement, then confirms a monetary mismatch still withholds a Permit and keeps both worst-case reservations in the ledger.

The 70 application tests and seven offline contract tests passed. The 0G activity export reconciled the stopped run's two requests to USD 0.007925. The original ledger still retains USD 0.190072 in unresolved live reservations as the preserved snapshot. Base Sepolia independently confirmed the 5 test USDC deposit, unchanged Agent nonce and zero Guard permit consumption. No requests were resubmitted.

On 2026-11-19 the continuation at `1ba67a810071af72fa6d3a6e5d91a53e73d9b929` settled all eight new responses with different HTTP and trace identifiers. Raw response totals matched the ledger. The final stop-before-dispatch budget check made no request. The cumulative scope billed USD 0.031329 for ten requests, including the two externally reconciled charges from the original attempt.
