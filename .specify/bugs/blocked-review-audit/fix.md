# Retain blocked-review explanations

- Slug `blocked-review-audit`
- Applied 2026-11-19
- Assessment [assessment.md](assessment.md)
- Status applied

The authenticated review path now saves a 400-character final summary and up to three 160-character threat descriptions per reviewer on blocked decisions. The retained fields come from the validated verdict. The evidence still records the response commitment and Router verification.

`npm test` passed 58 tests. The new HTTP regression test supplies a verified split committee, closes the server, reads the SQLite record and checks the critic explanation, lack of a permit and exclusion of raw reasoning. `git diff --check` passed. The original live veto preceded this change, so its explanation remains unavailable.
