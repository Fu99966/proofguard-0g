# Base Sepolia treasury agent

The agent reads a Safe's ETH, WETH and USDC balances at the same block as the independent price snapshot. It targets 40% ETH exposure with a 35–45% no-trade band and limits each order to $10 of testnet notional and 15% of the current portfolio. WETH and USDC are the trading inventory. The native ETH balance contributes to exposure.

## Local verification

```bash
npm ci
npm test
npm run test:contracts
npm run eval
```

Use `npm run agent:rebalance` for a single read-only tick with the Base Sepolia RPC, ETH/USD feed proxy and Safe address configured. The code verifies the network and discards pool quotes outside the independent price tolerance. Test USDC uses a $1 reference when no USDC/USD feed is configured. Market and simulation RPC URLs are operator-controlled.

## Real testnet run

The historic short run is closed at 16 Router requests. Use `node scripts/run-testnet-acceptance.js` for its read-only funding check. The separate approved two-hour run is `node scripts/run-live-acceptance.js`. It uses the existing dedicated Base Sepolia accounts, writes expected and observed outcomes to a new SQLite-backed journal, and enforces 30 paid requests and USD 0.90. The independent 24-hour sampler is `node scripts/observe-testnet-stability.js`. It reads from public RPC, holds no signer, and makes zero Router requests.

Use a dedicated Base Sepolia Safe 1.5.0 with owner keys held separately. Register the deployed ProofGuard contract as the Safe's module, module guard and transaction guard in that order while the account is empty. Configure the Safe as `PROOFGUARD_AGENT_WALLET`. Fund its test inventory with ETH or WETH and USDC (WETH is required for sell orders), and fund the separate agent EOA with testnet ETH for gas. The agent address must have only the module's restricted role. Keep the issuer key on the review server. The `.env.example` file lists the server settings.

For a disposable operator-managed run, `node scripts/deploy-testnet-safe.js` checks the local testnet account balance without broadcasting. The `--send` mode deploys and configures a new Safe/Guard for the known test-only roles from `var/testnet-acceptance/wallets.json`. Build the Foundry contract first.

For the agent process, set `PROOFGUARD_RPC_URL`, `PROOFGUARD_ETH_USD_FEED`, `PROOFGUARD_AGENT_WALLET`, `PROOFGUARD_TESTNET_GUARD_ADDRESS`, `PROOFGUARD_TESTNET_AGENT_KEY`, `PROOFGUARD_API_URL` and `PROOFGUARD_AGENT_API_KEY`. Set `PROOFGUARD_SIMULATION_RPC_URL` if the main RPC lacks `eth_simulateV1`. `PROOFGUARD_AGENT_LOG` overrides the default local journal path `var/agent.jsonl`.

```bash
npm run agent:rebalance -- --send --observe-24h
```

The SDK asks for authenticated review before every approval and swap. The local server defaults to `rules-only`, which requires no 0G key. It verifies the issuer, replays the specific Safe call through `eth_simulateV1`, checks simulated token movements and verifies the confirmation's `PermitConsumed` event.

The historical dual-model acceptance verifier requires two confirmed Router receipts on every review. For a separately authorized repetition, set `PROOFGUARD_REVIEW_MODE=rules-plus-models` on the server and configure the persistent Router budget. Use the same Agent API and Base Sepolia RPC settings to verify the completed journal.

```bash
npm run agent:verify -- <run-id>
```

The verifier checks the journal for observation gaps and compares its start and end to canonical Base Sepolia blocks at least 24 hours apart. It accounts for the entire Agent nonce range and matches each successful Safe Guard transaction to its `PermitConsumed` event, approved calldata and two Router-verified audit decisions. The 24-hour run uses the same capped review API for one zero-amount recipient rejection after the first confirmed swap. The verifier requires both the swap and the rejection with two Router receipts.

## Safe fork verification

Start Anvil on a loopback Base Sepolia fork and run the integration script. It verifies deployed Safe code hashes, creates a test-local Safe and exercises both review modes through its Guard. The dual-model case uses mocked Router receipts. All writes stay on the local fork.

```bash
node node_modules/@foundry-rs/anvil/bin.mjs --fork-url https://base-sepolia-rpc.publicnode.com --chain-id 84532 --host 127.0.0.1 --port 18545 --silent
```

```bash
npm run test:contracts
node scripts/verify-safe.js
```

Run the forked Solidity integration and invariant suite on the pinned Base Sepolia block.

```bash
npm run test:contracts -- --fork-url https://sepolia.base.org --fork-block-number 61349084
```

[Safe v1.5.0 deployment registry](https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0) · [Base Sepolia Uniswap deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)
