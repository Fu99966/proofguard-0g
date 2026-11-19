# Keep observing while no quote meets the price limit

- Slug `no-quote-observation`
- Applied 2026-11-19
- Assessment [assessment.md](assessment.md)
- Status applied

The 24-hour Agent records `quote-unavailable` and waits for the next cycle when no supported pool supplies a quote within the independent-price limit. The one-shot command still fails in that condition for use by read-only preflights.

`npm test` passed 58 tests. The read-only preflight returned exit code 1 at Base Sepolia block `60670679`. The subsequent live run began at block `60670757` and recorded a position and `quote-unavailable` at block `60670764`. The process remained running after the skipped quote. Continuous observation and guarded executions are tracked in the acceptance task.
