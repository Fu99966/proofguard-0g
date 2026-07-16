# ProofGuard Product Design

## Decision

Build a transaction firewall rather than a trading copilot. The product must sit on the execution path: an autonomous agent proposes an EVM transaction, 0G privately reviews its semantic intent, a deterministic owner policy enforces hard limits, and a scoped permit is produced only when both agree.

Three approaches were considered:

1. Model-only reviewer — fastest, but a model can be manipulated and becomes a single point of failure.
2. Deterministic rules only — reliable for known thresholds, but cannot understand contextual attacks or ambiguous intent.
3. Dual-gate compiler — selected because semantic and deterministic controls compensate for each other's weaknesses and make 0G indispensable.

## Product surface

The main screen is an industrial security console, not a generic chat UI. A judge can select four scenarios and run the entire system with one button. The center shows the four-stage state machine; the left shows the exact transaction and hostile fields; the right shows immutable owner policy and live logs. A separate evidence room demonstrates commitments and tamper detection. The architecture screen explains why the model cannot execute unilaterally.

## Data flow

1. Client selects or submits a transaction.
2. Server validates the request and runs deterministic checks.
3. Server sends policy, pre-scan, and untrusted transaction to 0G Private Computer.
4. Model output is parsed through a strict fail-closed JSON adapter.
5. Decision compiler requires both gates to return allow.
6. Server binds transaction, policy, inference, expiry, nonce, and model into a permit.
7. Optional wallet signature is verified by the execution adapter; nonce is consumed once.

## Error handling

Network errors, timeouts, malformed model output, unknown decisions, expired permits, modified transactions, wrong signers, and replay attempts all fail closed. Demo mode remains available without credentials but is visually and semantically separated from live 0G proof material.

## Testing

Unit tests cover every attack scenario, stable hashing, dual-gate permit behavior, reasoning-tag JSON extraction, and malformed-output rejection. Release verification requires unit tests, Vite production build, API smoke tests, and browser review at desktop and mobile widths.

