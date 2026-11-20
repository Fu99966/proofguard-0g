# ProofGuard

**Current release target: Base Sepolia testnet. Do not use mainnet funds.**

> **A verifiable AI transaction firewall for autonomous onchain agents.**

ProofGuard applies deterministic owner policy to decoded EVM transaction proposals and binds approved proposals to short-lived, one-time permits. Live review also requires two 0G Private Computer verdicts and Router confirmation of both TEE signatures. Browser presets use a local simulator. The Base Sepolia Agent can submit qualifying transactions through a Safe Guard.

**Hackathon track:** Build with 0G Private Computer · 0G Labs

**Default 0G committee:** `glm-5.3-flash` (semantic judge) + `0gm-1.0-35b-a3b-sia` (red-team critic)

**Trust mode:** `private` / TeeML

## Why ProofGuard

Deterministic policy checks the registered wallet, decoded transaction effects, recipient, spending and approval limits, quote and slippage evidence, and the configured Base Sepolia portfolio mandate. A failing rule prevents permit issuance.

The live 0G integration records separate semantic and red-team verdicts for the same transaction. A veto, incomplete verdict, unavailable reviewer, or missing Router confirmation prevents issuance.

## Evaluation evidence

The deterministic rules correctly classified the tested approval cohort and the internal portfolio-mandate controls. All evaluated cases that warranted a block were already caught by the rule layer. Neither model produced an additional correct block in the evaluated samples. The approval comparison excluded model calls by design. Incremental detection on cases outside the current rules remains unevaluated. [Evaluation record](specs/002-project-completeness/tasks.md#evaluation-closure-and-limitations)

## Track compliance

| Track requirement | ProofGuard evidence |
|---|---|
| Official 0G Compute API | Server-side calls to `https://router-api.0g.ai/v1/chat/completions` |
| At least one 0G model | The live review path requests two distinct model verdicts through 0G Private Computer |
| Verifiable inference | The Router checks both TEE signatures on request; per-reviewer IDs and evidence are preserved for follow-up verification |
| Web3 + AI | Autonomous EVM transaction firewall, wallet countersignature, scoped one-time permit |
| Runnable demo | React Web App + Express Agent API; tests and production build included |
| Submission package | README, technical document, and a timed sub-three-minute recording script |

## Demo capabilities

- Four one-click scenarios: safe swap, prompt injection, unlimited approval, and slippage spike
- Deterministic policy checks and fail-closed permit issuance in the local demo
- A separate authenticated live review path that requests two verdicts using `X-0G-Provider-Trust-Mode: private`
- Three independent commitments: transaction, owner policy, and inference response
- Tamper challenge that modifies one byte and demonstrates commitment mismatch
- Optional EVM wallet connection and EIP-712 typed-data signature by the configured policy owner
- Execution adapter that verifies wallet signature, expiry, transaction hash, and one-time permit consumption
- Explicitly labelled no-key Demo mode for reliable judging and development
- Responsive industrial security-console interface

## Architecture

```mermaid
flowchart LR
    A["Autonomous agent"] -->|proposed EVM transaction| I["ProofGuard interceptor"]
    I --> D["Decode and check deterministically"]
    D -->|decoded facts| Z1["GLM-5.3-Flash live review"]
    D -->|decoded facts| Z2["0GM-SIA live review"]
    D --> C["Decision compiler"]
    Z1 -->|private verdict + evidence| C
    Z2 -->|private verdict + evidence| C
    C -->|policy and both reviews allow| P["Scoped execution permit"]
    C -->|rule, veto, or evidence failure| B["Transaction rejected"]
    P --> E["Base Sepolia Safe Guard or local simulator"]
    E --> R["Commitments and receipt"]
```

The rule layer has an independent veto. Successful live execution uses a Permit bound to the exact proposal and checks that Permit at the Safe Guard.

## 0G Private Computer integration

The server calls the official OpenAI-compatible Router and keeps the API key out of the browser. Both live reviewers receive the decoded effects, owner mandate and untrusted proposal memo. The production review omits the deterministic verdict. The request shape is shown below.

```js
const response = await fetch("https://router-api.0g.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.ZERO_G_API_KEY}`,
    "Content-Type": "application/json",
    "X-0G-Provider-Trust-Mode": "private",
  },
  body: JSON.stringify({
    model, // glm-5.3-flash or 0gm-1.0-35b-a3b-sia
    messages: [
      { role: "system", content: "You are an adversarial Web3 transaction firewall. Output JSON only." },
      { role: "user", content: reviewPrompt },
    ],
    temperature: 0.1,
    max_tokens: 4096,
    verify_tee: true,
  }),
});
```

The adapter captures each model's response ID, Router request ID, provider address, chat ID (`ZG-Res-Key` or response ID), and available proof metadata. Live permit issuance requires both models to return a complete verdict and the Router to report `x_0g_trace.tee_verified: true` for each. The 4,096-token limit covers both reasoning and the verdict. A truncated response never produces a permit. Generic response headers and local hashes do not satisfy the TEE requirement. [0G's verification reference](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution) explains the Router's result and the SDK path for independent checks.

## Quick start

Requirements: Node.js 22.12+ (or 20.19+) and npm.

```bash
git clone https://github.com/Fu99966/proofguard-0g.git
cd proofguard-0g
npm ci
cp .env.example .env
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Without a 0G API key, the application starts in **DEMO / NO 0G CALLS** mode. The four scenarios, policy checks, simulated permits and commitment verification run locally. **Demo mode is for development only and does not satisfy the hackathon's 0G API requirement; record the submission video in LIVE 0G mode.**

For a deterministic local presentation while keeping a configured key unused, set `ZERO_G_FORCE_DEMO=true`. This prevents outbound 0G inference calls and preserves the key in `.env`; it does **not** turn the simulated receipt into 0G evidence.

## Enable live 0G private inference

1. Open the [0G Private Computer dashboard](https://pc.0g.ai/dashboard/api-keys).
2. Create an API key and fund the associated compute balance if required.
3. Copy `.env.example` to `.env` and set:

```dotenv
ZERO_G_API_KEY=your-router-api-key
ZERO_G_BASE_URL=https://router-api.0g.ai/v1
ZERO_G_MODEL=glm-5.3-flash
ZERO_G_CRITIC_MODEL=0gm-1.0-35b-a3b-sia
ZERO_G_ENABLE_COMMITTEE=true
ZERO_G_TRUST_MODE=private
PORT=8787
```

4. Restart `npm run dev`.
5. The `/api/health` mode indicates server configuration. The public browser scenarios always use local simulation. Run the two synthetic scenarios with `npm run smoke:0g` when you are ready to make four billable Router calls. The command fails unless the safe swap yields `ALLOW`, the injection scenario yields `BLOCK`, and both have two confirmed TEE results and trace identifiers. Compare request IDs with the 0G usage dashboard. The smoke prints Router verification separately from independent verification.

### Model selection and verification

The recorded live smoke test exercised safe-swap and injection scenarios and collected four Router-confirmed TEE verdicts in Private/TeeML mode. This evidence covers receipt verification on the tested routes. The evaluation record reports detection results separately.

If an existing `.env` still names `0gm-1.0-35b-a3b` as the primary, set `ZERO_G_MODEL=glm-5.3-flash` or remove that override to use the new default. The older primary remains selectable. Its Encrypted Transit route omitted the Router's per-response `tee_verified` flag in the recorded tests. 0G describes how the encrypted gateway performs that check, and ProofGuard keeps permits blocked when the Router does not confirm both verdicts. [0G's explanation](https://0g.ai/blog/data-privacy-on-0g-private-computer#audit-it-then-verify-it)

## Production build

```bash
npm run build
npm start
```

Open [http://localhost:8787](http://localhost:8787).

## Demo flow

1. Run **正常换仓 / SAFE SWAP** and inspect the rule verdict, simulated reviewer results and demo permit.
2. Run **提示词注入 / INJECTION** and inspect the deterministic rejection.
3. Click **模拟篡改响应**; a one-byte change produces `COMMITMENT MISMATCH`.
4. Open **证据室** to show transaction, policy, and inference commitments.
5. To try optional simulated execution, set `PROOFGUARD_OWNER_ADDRESS` to the **public address** of a disposable EVM wallet you control and restart the server. Review again, connect the configured wallet and sign the EIP-712 permit fields. The wallet shows the target, value, and deadline. The server verifies the signer and consumes the permit once. Review and commitment checks work without a wallet.

The complete 2–3 minute narration and shot list are in [docs/hackathon/DEMO_SCRIPT.md](docs/hackathon/DEMO_SCRIPT.md).

## Attack scenarios

| Scenario | Deterministic policy result | Expected decision |
|---|---|---|
| Safe swap | Approved target, assets, value, and slippage within the limit | `ALLOW` |
| Prompt injection | Instruction injection and an unapproved payout address | `BLOCK` |
| Unlimited approval | ERC-20 approval larger than owner policy | `BLOCK` |
| Slippage spike | 9.8% slippage against a 0.75% maximum | `BLOCK` |

## Evidence semantics

ProofGuard distinguishes four kinds of evidence:

| Evidence | Meaning |
|---|---|
| Router TEE verification | The Router reports that it verified each provider signature. Response and request IDs identify the runs. |
| Independent TEE verification | An external verifier checks the provider signature against its registered TEE signer and the exact returned content. ProofGuard does not perform this check itself. |
| Local SHA-256 commitment | Recompute and compare with a known original commitment to detect a content change. |
| Demo receipt | Deterministic simulation for local use; **not** a cryptographic 0G proof |

For independent verification, start with each reviewer's `provider`, `chatId`, model and exact response content. Follow the [official SDK or manual verification procedure](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution#independent-verification-advanced). For the built-in synthetic smoke, the command prints the exact reviewer content. For a separate API review, the exact model content is in `JSON.parse(inference.rawDecision)` under `primary` and `critic`. Treat evidence collected using live, non-synthetic proposals as sensitive.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Service, mode, and model status |
| `GET` | `/api/demo` | Policy, agent, and attack scenarios |
| `POST` | `/api/review` | Run deterministic and 0G model review; compile permit |
| `POST` | `/api/verify-commitment` | Detect response or transaction tampering |
| `POST` | `/api/execute` | Verify the configured owner signature, permit expiry, exact proposal and one-time use |

Configure `PROOFGUARD_API_KEY_HASHES` with SHA-256 digests of random Agent keys, then send the original key as `Authorization: Bearer …`. Only the digest belongs on the server. Configure `PROOFGUARD_FRONTEND_ORIGINS` with exact origins for separate frontends and the browser-facing HTTPS origin when TLS terminates at an ingress. The built-in server also accepts direct same-origin browser requests. Review and audit default to 30 and 60 requests per minute per Agent key, respectively. Limits are local to each API process.

Submit an EVM transaction as `{ "transaction": { "chainId": 84532, "from": "0x…", "to": "0x…", "value": "0", "data": "0x…" } }`. `value` is a string in wei. The API decodes effects from calldata and independently checks the chain, sender, asset addresses, recipient, spend limit and minimum output. Optional legacy display claims must agree with decoded facts. Configure a trusted market source to approve custom proposals requiring valuation. The preset `/api/demo/review` accepts only a `scenarioId` and never sends requests to 0G.

`GET /api/audit/:permitHash` requires the same Agent authorization and returns the stored decision and consumption record. `PROOFGUARD_DATABASE_PATH` selects the SQLite file. Mount this path on persistent single-instance storage if permits must survive process or container replacement.

`/api/execute` takes `permitHash`, the unchanged `transaction` and the `signature`. The signer comes from the operator's policy configuration, not the HTTP request. Returned `txHash` is a local simulation receipt ID.

## Tests

```bash
npm test
npm run test:contracts
npm run eval
npm run build
```

The tests exercise the four demo scenarios, live Router response fixtures, no-key and force-demo behavior, invalid input, signer binding, expiration, concurrent reuse and commitment recomputation. Fixtures keep the test suite offline and do not establish live 0G acceptance.

The completed approval comparison covers deterministic policy, historical policy and archived GoPlus simulation signals. The approval cohort did not use Blockaid or model inference. The separate internal mandate evaluation found no incremental model blocks on rule-covered cases. [Evaluation record](specs/002-project-completeness/tasks.md#evaluation-closure-and-limitations)

## Repository map

```text
src/App.jsx                  Product UI and review state machine
src/styles.css               Responsive industrial security-console design
server/index.js              HTTP routes for the review and simulator
server/decoder.js            Address-aware EVM calldata decoder
server/reviewStore.js        SQLite decision chain and permit lifecycle
sdk/                         Review and guarded submission client
contracts/src/               Base Sepolia Safe guard and agent module
server/zeroGAdapter.js       0G Router integration and receipt capture
server/policyEngine.js       Deterministic rules, hashing, permit compiler
server/demoData.js           Owner policy and four judging scenarios
docs/TECHNICAL.md            Architecture, threat model, Sponsor integration
docs/hackathon/DEMO_SCRIPT.md          2–3 minute recording script
docs/hackathon/HACKATHON_SUBMISSION.md Copy-ready submission form and final checklist
docs/plans/                  Validated product design
```

## Security boundaries

- API keys remain server-side and are never returned by an endpoint.
- All model-controlled fields are untrusted input; malformed model output fails closed.
- Policy checks are independent from model output.
- Permits bind exact transaction hash, policy hash, inference hash, target, chain, expiry, and nonce.
- The simulator consumes permits through a guarded SQLite update and verifies the configured owner's EIP-712 signature.
- The four browser scenarios use fixed demo market data and simulated committee responses. The server decodes their calldata and labels the evidence as simulation.
- Broadcast and onchain enforcement require a separately configured testnet environment, with an external audit required before mainnet use.

## Base Sepolia agent and Safe Guard

The [treasury agent runbook](examples/rebalancer/README.md) covers the JavaScript SDK, read-only portfolio observation, the guarded testnet submission path and the Safe fork integration check. See [completeness acceptance records](specs/002-project-completeness/tasks.md) for the distinction between local, fork and public testnet verification.

## Roadmap

1. Maintain the Base Sepolia-only deployment and record testnet acceptance outcomes.
2. Define a separate evaluation for semantic judgments outside the current rule set.
3. Complete a third-party contract audit before any mainnet launch.

## Documentation and Sponsor resources

- [Technical submission](docs/TECHNICAL.md)
- [Video script](docs/hackathon/DEMO_SCRIPT.md)
- [Copy-ready hackathon submission](docs/hackathon/HACKATHON_SUBMISSION.md)
- [0G Private Computer](https://pc.0g.ai/)
- [0G model catalog](https://pc.0g.ai/models)
- [0G documentation](https://docs.0g.ai/)

## License

MIT

