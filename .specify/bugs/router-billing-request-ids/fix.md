# Router billing request identifiers

Status **partial**. The fix is verified offline. The two-hour live attempt stopped and remains closed.

Keep the HTTP correlation header with response metadata. Bind settlement to the unique `x_0g_trace.request_id` and retain the original amount and reservation checks. The API regression now gives each mock response distinct HTTP and billing identifiers, verifies exact settlement, then confirms a monetary mismatch still withholds a Permit and keeps both worst-case reservations in the ledger.

The 70 application tests and seven offline contract tests passed. The 0G activity export reconciled the stopped run's two requests to USD 0.007925. The original ledger still retains USD 0.190072 in unresolved live reservations as the preserved snapshot. Base Sepolia independently confirmed the 5 test USDC deposit, unchanged Agent nonce and zero Guard permit consumption. No requests were resubmitted.
