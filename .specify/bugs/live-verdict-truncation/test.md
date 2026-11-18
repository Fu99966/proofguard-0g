# Verification

Status: partial. 24 tests and the Vite production build passed. The new HTTP regression checks the request budget and confirms a parseable, Router-verified ALLOW is blocked when its finish reason is `length`. A new live run is needed to show the changed budget produces complete decisions and both Router verifications. No additional paid requests have been made.
