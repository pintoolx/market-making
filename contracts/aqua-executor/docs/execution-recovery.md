# TEE JSON input and execution recovery

`npm run execute` accepts a JSON request, validates its strategy and risk policy, and executes it through a durable local controller. Ship, swap, rebalance, risk-triggered dock and explicit allowance cleanup can resume after a process interruption. The existing fixed-parameter demo commands remain available; their transaction path does not gain this recovery behavior automatically.

This is an integration boundary for a trusted TEE/controller to submit `AquaStrategyParams`. It does not implement a TEE runtime, remote attestation, HTTP authentication or remote signing. `meta.producer: "tee"` is a provenance label, not proof of attestation. The configured local wallets still sign transactions.

## Requests

Every request contains `schema: "aqua-execution-v1"`, `requestId`, `sessionId` and `action`. IDs are 1–96 letters, digits, dots, underscores or hyphens, starting with a letter or digit. Use a new request ID for each new operation; resend exactly the same request to retry an interrupted operation.

| Action | Additional fields | Behavior |
|---|---|---|
| `ship` | `strategy`, `policy` | Exact maker approvals, ship, then a risk check; creates the session. |
| `swap` | `expectedStrategyHash`, `tokenIn`, `amountIn`, `slippageBps` | Risk check, exact taker approval, quoted swap, then another risk check. |
| `rebalance` | `expectedStrategyHash`, `strategy` | Risk check, exact maker approvals, atomic dock/ship, persist transition, check replacement. |
| `monitor` | `expectedStrategyHash` | One risk evaluation; docks automatically when the threshold is reached. |
| `dock` | `expectedStrategyHash`, optional `revokeAllowances` | Close the strategy; revoke the two maker allowances only when explicitly requested. |

The strategy shape is the existing [`AquaStrategyParams`](tee-handoff.md). The parser rejects unknown fields, malformed addresses, fractional/overflowing values, invalid fee/deadline/salt bounds and unsupported programs. Integer token amounts are canonical decimal strings in raw units. Execution also verifies the network, configured maker, deployment token allowlist, and on-chain preconditions. This controller is intentionally limited to one open session per maker.

`ship.policy` is a [`RiskPolicy`](risk-monitor.md). Its token order and baseline amounts must exactly match the original funded strategy. Only the first ship can supply it. Rebalance takes a complete replacement strategy, including its new amounts, fee, deadline and salt; it retains the original policy. Use `maxPriceAgeSec: 86520` with the supplied Chainlink adapter, which independently applies the shorter ETH feed age limit.

`expectedStrategyHash` must match the current session strategy. Take it from the preceding result or `--status`. A request created before a different rebalance is rejected instead of operating against an unintended strategy. A new `sessionId` cannot adopt a strategy already shipped outside this journal.

The [complete ship example](../examples/ship-request.json) demonstrates the input shape using the existing Base Sepolia mock-token deployment. It is sample data, not actual TEE output. Before submitting a real new operation, supply fresh IDs, an intended deadline (normally current chain time plus one hour), and a new uint64 salt. After the first submission, keep the request unchanged for retries.

```bash
# Validate the example's JSON/schema without accessing the chain or signing.
npm run execute -- --request examples/ship-request.json --validate

# Execute the actual request supplied by the TEE/controller.
npm run execute -- --network base-sepolia --request /path/to/ship.json

# Read stored state, request statuses, and transaction hashes/nonces.
npm run execute -- --network base-sepolia --session maker-session-123 --status

# Same command and same JSON resume an interrupted operation or return its saved result.
npm run execute -- --network base-sepolia --request /path/to/ship.json
```

`--validate` checks schema only; signer, chain state, balances, allowances and deadline freshness are checked during execution. Optional `--deployment <file>` selects an explicit deployment JSON; network and state-directory bindings are still verified. CLI results are JSON with the request/session IDs, status, outcome, active strategy hash, retained plan, transaction hashes and record path. A reverted transaction returns `status: "failed"`; the CLI exits nonzero. `--status` describes persisted state, including unconfirmed intents; it is not a fresh risk evaluation.

A swap request looks like this (fill the returned hash):

```ts
const swapRequest = {
  schema: 'aqua-execution-v1',
  requestId: 'swap-002',
  sessionId: 'maker-session-123',
  action: 'swap',
  expectedStrategyHash: shipResult.strategyHash,
  tokenIn: deployment.tokens.mUSDC,
  amountIn: '100000000', // 100 mUSDC
  slippageBps: 50,
}
```

Rebalance uses the same envelope with `action: 'rebalance'` and `strategy: nextParams`. Supply the intended replacement inventory; the executor does not silently replace a TEE-provided amount with its own choice. Explicit cleanup uses `action: 'dock'` and `revokeAllowances: true`.

## Continuous monitoring

Ship/rebalance/swap perform risk checks as part of the request. Start a watcher for continued monitoring:

```bash
npm run execute -- --network base-sepolia --session maker-session-123 --watch
```

The watcher releases the controller lock between checks, so another process can submit a rebalance using the same state directory. It reads the latest session on each poll and follows the confirmed replacement without resetting HODL. It uses a fresh request ID for each observation; replaying a completed `monitor` request ID returns that historical result, not a new market check.

After a crash, the watcher resumes the session's pending request before issuing a new observation. That can include a previously authorized ship, swap or rebalance. One unresolved request blocks newer requests so they cannot consume its nonce. Price/RPC read errors and lock contention are retried with bounded backoff. Failed read-only observations without a prepared transaction are recorded as failed, allowing another fresh check. A persisted breach is completed even if prices subsequently recover or become unavailable.

Default polling is five seconds; change it with `--interval-ms` (minimum 100). Chainlink is the default price provider. `--prices <file.json>` supplies an explicitly labelled file or simulated snapshot. Update its actual observation time through the provider; do not relabel stale data as fresh. See [price validation and risk limitations](risk-monitor.md).

Use this watcher for sessions managed by the durable controller. The older `npm run monitor` command and fixed-parameter demos do not share its lock or transaction journal; they must not sign concurrently with it for the same maker/taker.

## What recovery does

Before broadcasting, the controller simulates the call, fills its nonce/gas/fees, signs it, computes its hash locally, and commits the exact signed bytes to SQLite. On retry, the saved intent is loaded before running any new quote or transaction preparation. The sender first queries the original hash's receipt.

| Interruption point | Recovery |
|---|---|
| Before an intent is committed | No transaction has been broadcast; safely prepare this step. |
| After intent commit, before broadcast | Submit the saved bytes with the same hash and nonce. |
| Broadcast succeeded but response/receipt was not saved | Query the original hash; if unavailable and the nonce is not consumed, resubmit only the same signed bytes. |
| Receipt saved, request/transition not completed | Recheck the receipt, recover the session update and continue remaining steps. |
| Request already completed | Recheck its recorded receipts and return the original saved result without new transactions. |

Receipt and execution-log updates are committed together. Rebroadcasting identical signed bytes preserves the transaction identity. Recovery never increases a fee, changes nonce/min-out/deadline, invents a replacement quote, or assumes a new request ID represents an earlier operation.

If a saved swap expires while stopped, the original transaction can revert. That is recorded as a failed result for the original request; it is not retried with relaxed bounds. After a confirmed revert, a caller can submit a new explicitly authorized operation or close the session. A ship that expires before submission can close its unshipped session and revoke its completed approvals.

If another transaction consumed the saved nonce and the original receipt cannot be found, recovery stops for inspection. A previously confirmed receipt disappearing or changing also stops recovery. If the receipt waiter follows a replacement, the controller rejects its different transaction hash. There is no automatic transaction replacement or reorg repair. In these cases use `--status` and the printed hash to inspect the chain; do not delete the journal or change the request ID to bypass the unresolved operation.

Same-ID requests are bound to a canonical content digest. JSON key order and address letter case do not create a new operation, but changing its strategy, amounts, session or action is rejected. The directory is also bound to chain ID, genesis hash, deployment and maker/taker addresses, preventing an accidental replay against another environment.

## Storage and process ownership

Default state is `.state/executor/<chainId>/`; override it with `--state-dir` or `ControllerOptions.stateDir`. It contains `executions.sqlite`, a separate `controller-lock.sqlite`, and exported `records/<requestId>.jsonl`. Keep it on local storage that supports SQLite locking, preserve it across restarts, and share exactly the same directory between processes using these signers.

One SQLite connection holds the process lock while the execution database commits its checkpoints. A process crash releases the OS lock, so no stale PID-file deletion is required. The execution database uses rollback journaling with `synchronous=EXTRA`. This uses the [Node SQLite API](https://nodejs.org/api/sqlite.html), [SQLite file locking](https://www.sqlite.org/lockingv3.html) and [synchronization settings](https://www.sqlite.org/pragma.html#pragma_synchronous). Node 24 currently emits an experimental-feature warning for its built-in SQLite module; no new npm dependency is required.

The directory is gitignored and new database files are owner-only. It stores already signed transactions, not private keys. Keep the entire state directory private and backed up consistently while the controller is stopped. Another directory, an external wallet, the legacy demos or another host cannot be coordinated by this local lock. No cross-host execution guarantee is claimed.

JSONL files are regenerated from SQLite events and can be recovered if a crash prevents export. They never contain raw signed transaction bytes. Do not use them instead of the database for recovery. `tx-prepared`, `execution`, `risk`, `monitor-follow`, `request-interrupted` and `request-result` provide an audit trail; successful receipt events are unique by transaction hash.

SIGINT/SIGTERM stop further preparation/broadcast where possible. A submitted transaction may finish while the process waits for its receipt. There is no automatic cleanup in an interrupted request: restarting must continue the original operation. Run `--status` or resubmit the original request to inspect/resume it.

## Programmatic entry

```ts
const options = {
  stateDir: '/absolute/path/to/persistent-state',
  getPrices: createChainlinkPrices(deployment),
  signal: abortController.signal,
}
const result = await executeRequest(ctx, deployment, teeRequestJson, options)
const status = await executionStatus(ctx, deployment, options.stateDir, teeRequestJson.sessionId)
await watchExecution(ctx, deployment, teeRequestJson.sessionId, options)
```

Imports are in `src/execution-controller.ts`, `src/execution-request.ts` and `src/prices.ts`. Call `executeRequest()` again with the same request to resume; callers do not need to reconstruct partially completed steps. A transient error leaves the request pending; known on-chain reverts return a durable failed result. Inspect `result.outcome`: a risk check can close a session instead of performing the requested swap or rebalance.

## Verification

`test/execution.test.ts` runs the JSON input through real Anvil transactions and production CLI restarts. It sends `SIGKILL` to a separate process after ship/rebalance/risk-dock broadcast and after swap preparation. Assertions verify the original transaction hashes, no extra maker/taker nonces, one receipt event per transaction, unchanged HODL through rebalance, and recovery without fresh prices after a persisted breach.

Additional tests cover competing processes, lock release after a crash, a watcher following another process's rebalance, temporary price outages, expired signed swaps, interrupted cleanup of an unshipped session, replacement receipts, and externally consumed nonces. Schema tests cover canonical idempotency and malformed input. Existing lifecycle, encoding and risk tests remain in the same full suite:

```bash
ANVIL=$PWD/.cache/bin/anvil npm test
npm run typecheck
```

These recovery tests run locally on Anvil. The earlier [Base Sepolia price-monitor evidence](risk-monitor-sepolia.md) uses the prior monitor path and does not claim to validate this new recovery controller on a public network. The existing on-chain proof and artifacts are preserved; git remains paused.

Latest verification: **31/31 tests passed**, typecheck passed, and the example request passed the production CLI's schema-only validation.
