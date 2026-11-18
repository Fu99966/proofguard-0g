# Verification

Status: verified against the recorded responses. 25 tests and the production build passed. The regression checks that interim JSON before an SIA delimiter does not become the verdict, and that extra JSON after the delimiter or unmarked prose is rejected.

Replaying the exact four Router response bodies through the real HTTP handler produced ALLOW/ALLOW votes for the safe scenario and BLOCK/BLOCK votes for the injection scenario. Both returned a blocked application decision without permits because the primary did not satisfy the TEE requirement. No new inference charges were incurred during replay. Live safe-permit acceptance remains open.
