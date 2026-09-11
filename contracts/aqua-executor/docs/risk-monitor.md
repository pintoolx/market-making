# Maximum loss monitoring

The monitor values Aqua inventory against the original HODL benchmark, reads independent Chainlink prices, and sends `Aqua.dock()` at the configured threshold. A monitor session follows confirmed atomic rebalances without resetting the benchmark. [Base Sepolia evidence](risk-monitor-sepolia.md) covers live and simulated price demonstrations separately.

For TEE JSON requests with durable transaction recovery, use [the execution controller and its watcher](execution-recovery.md). This page describes the earlier standalone monitor/session API; it must not sign concurrently with the durable controller for the same accounts.

## Threshold and plan

```text
HODL value      = original token amounts × current external prices
strategy value  = current Aqua balances × the same external prices
loss fraction   = max(HODL value − strategy value, 0) / HODL value
dock when loss fraction × 10000 >= maxDrawdownBps
```

`maxDrawdownBps` measures underperformance against HODL, not absolute USD loss or decline from a historical peak. If unchanged holdings lose USD value together, that alone does not trigger it. Integer arithmetic preserves token decimals and exact threshold comparisons; displayed `lossBps` is rounded down. Gas is excluded from this inventory valuation.

```ts
interface RiskPolicy {
  tokens: Hex[]                 // two tokens in strategy order
  baselineAmounts: string[]     // original raw amounts, retained across rebalances
  maxDrawdownBps: number        // integer 1–10000; 100 = 1%
  maxPriceAgeSec: number        // 86520 for the provided Chainlink adapter
}

interface MonitorPlan {
  strategy: AquaStrategyParams  // ORIGINAL strategy; never replace this field
  policy: RiskPolicy            // ORIGINAL benchmark; never reset to new inventory
  rebalances?: {
    strategy: AquaStrategyParams
    txHash: Hex                 // confirmed atomic dock(old) + ship(new)
  }[]
  finished?: boolean
}
```

This plan is separate from `AquaStrategyParams`, preserving the existing TEE/SwapVM interface. Create it from the original funded strategy. The transition journal only grows; a running session rejects changed original parameters, changed policy, rewritten history, a different maker/network/token order, and reuse of the previous strategy hash.

## Live prices

`createChainlinkPrices(deployment)` reads Base mainnet through public RPCs without a wallet or API key. It maps this deployment's mWETH/mUSDC demonstration tokens to ETH/USD and USDC/USD references. These mock tokens have no claim on real ETH or USDC. Real deployments may instead provide `WETH` and `USDC` address keys; the deployer must verify that those assets match the references.

| Feed | Base mainnet proxy | Accepted age |
|---|---|---|
| ETH/USD | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | 1320 seconds |
| USDC/USD | `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` | 86520 seconds |
| Sequencer uptime | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` | Must be up for more than 3600 seconds |

Price ages are the directory's 1200-second ETH and 86400-second USDC heartbeat plus a 120-second allowance. Each feed is checked separately: allowing the USDC heartbeat does not permit a day-old ETH price. Proxies and heartbeats were checked against the [Chainlink Base feed directory](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json); ETH uses the standard secondary proxy of the shared SVR entry. The [AggregatorV3 API](https://docs.chain.link/data-feeds/api-reference) supplies round timestamps and decimals, and the [L2 sequencer guidance](https://docs.chain.link/data-feeds/l2-sequencer-feeds) supplies the uptime check and recovery grace period.

The adapter verifies chain ID 8453, a recent oracle block (60 seconds), positive round answers, timestamps, decimals and expected feed descriptions. Both feeds and the sequencer are read in one multicall at the same block. USDC uses its actual quote, not an assumed $1 peg. A failed endpoint is followed by the next endpoint. Optional `BASE_PRICE_RPC_URLS` is a comma-separated list of read-only Base mainnet RPCs; defaults are PublicNode and `mainnet.base.org`.

```ts
interface PriceSnapshot {
  asOf: number                  // oldest actual observation, Unix seconds
  source: string
  usdE8: Record<Hex, string>     // USD per whole token × 1e8
  mode?: 'live' | 'simulated' | 'file'
  evidence?: Record<string, unknown>
}
```

Every live snapshot records proxy, round ID, answer, decimals, original `updatedAt`, source block, fetch time and sequencer evidence. `asOf` is the oldest actual round timestamp; fetching or saving does not refresh it. `maxPriceAgeSec: 86520` accommodates the slower USDC feed, while the adapter enforces ETH's shorter limit. A stricter policy intentionally rejects older observations.

The API also accepts a custom `getPrices()` callback. File mode rereads a JSON price file each check and labels it `file` or explicitly `simulated`; loading a file cannot certify it as live. For example, $2500 is `"250000000000"`. Validation cannot authenticate an arbitrary file's claims.

## Run and follow rebalances

```bash
# Existing deployment, active maker strategy, and a plan with the original benchmark.
npm run monitor -- --network base-sepolia --plan /path/to/plan.json

# Read-only single check with live Chainlink prices.
npm run monitor -- --network base-sepolia --plan /path/to/plan.json --once --dry-run

# Explicit external price file.
npm run monitor -- --network base-sepolia --plan /path/to/plan.json --prices /path/to/prices.json
```

Default polling is 5000 ms; `--interval-ms` changes it (minimum 100). `--dry-run` reports `would-dock` without signing. Balance and decimals reads are pinned to one execution-chain block, independently checked for freshness. A docked strategy does not fetch prices or send again.

Use one signing controller per maker. Embed `createMonitorSession()` in that controller and pass `stateFile` to persist its plan:

```ts
const session = createMonitorSession(ctx, deployment, originalPlan,
  createChainlinkPrices(deployment), rec, { stateFile: planPath, signal })

await session.check()
await session.rebalance(nextParams) // validates risk, approves, sends atomic tx,
                                    // persists transition, checks replacement
await session.run()                 // continues until risk-dock or abort
```

Checks and managed rebalances share an in-process queue. `rebalance()` confirms the transaction before switching the active strategy and retains the original policy. It immediately checks the replacement. Keep swaps/other maker transactions under the same controller's coordination; this is not a distributed nonce lock.

For a standalone follower, publish the plan with `writeMonitorPlan()` after the atomic rebalance succeeds. It writes by atomic rename, so readers see complete JSON. The CLI rereads the plan every check and validates each new entry against the receipt and transaction: success, maker sender, Aqua recipient, and exact encoded `multicall(dock(old), ship(new))`. Restarting reconstructs the latest strategy from this journal and the original benchmark. It does not discover unpublished transactions by scanning the chain.

If the previous strategy is already docked but a replacement has not yet been published, continuous mode keeps polling. `finished: true` allows it to stop once the final strategy is docked. Managed risk-dock persists that flag automatically; a controller that closes a session manually should mark completion after confirming the dock. `--once` always returns after one check. An external publisher and a signing follower still need one coordinated owner; do not run two uncoordinated signing processes for the same maker.

## Failures, records and limits

Unavailable RPCs, invalid/stale prices and stale chain snapshots produce `monitor-degraded`, with retries at 5, 10, 20 and then 30 seconds for the default interval. A successful check emits `monitor-recovered`. No cached price is treated as fresh, and missing data does not automatically mean healthy or trigger a dock. `--once` reports the error and exits instead of retrying.

Configuration, inconsistent journal and transaction failures are fatal and recorded as `monitor-error`. Submitted transactions are not blindly retried. If a process stops after broadcasting but before recording a rebalance, inspect its receipt and publish the confirmed journal entry before restarting. SIGINT/SIGTERM abort polling; a transaction already submitted can still finish. Run the process under supervision and observe degraded/error records.

Each `risk` record includes the policy, prices, inventory, block and exact valuation. `monitor-follow` records the old/new hashes and confirmed rebalance hash. `risk-dock` uses the existing simulation/signing/receipt path and is followed by a check that both token slots are 255.

This is an off-chain response to observed loss. Price update intervals, RPC outages, polling, concurrent swaps and transaction latency can let losses exceed the threshold. It does not guarantee a 1% cap, sell assets, or revoke allowances shared by other strategies. A recovered price after a recorded breach does not cancel an already triggered dock.

## Demonstrations

Use the existing Base Sepolia deployment; no redeployment is needed:

```bash
npm run demo:risk -- --network base-sepolia --price-source chainlink
npm run demo:risk -- --network base-sepolia --price-source simulated
```

Both perform approve → ship → swap → monitored rebalance → swap → risk-dock → revoke using mock tokens. Live mode deliberately seeds a mock pool at one-quarter of the real ETH/USDC reference ratio and makes adverse inventory swaps. Its Chainlink values remain unmodified; the demonstrated loss is from the mock pool's mispricing. Simulated mode starts at 2 mWETH/5000 mUSDC, executes two 100 mUSDC swaps, and explicitly fabricates a $2500 → $10000 ETH reference change. Both use the original 1% HODL-shortfall threshold.

For an offline local demo, start `.cache/bin/anvil --silent`, run `npm run deploy -- --network local`, then `npm run demo:risk -- --network local --price-source simulated`. Live mode requires network access. Demo cleanup revokes exact maker allowances, so use isolated demo accounts with no other active strategies.

Commands print the JSONL path and save `.plan.json` and `.prices.json` alongside it. Plans describe completed, docked strategies; saved prices retain their observation timestamps. Pass a saved plan to `npm run monitor -- --network base-sepolia --plan <record>.plan.json --once` to verify restart and `already-docked`. Local records are gitignored. Unit and Anvil integration tests cover price validity, exact thresholds, journal validation, delayed publication, restart, read-failure recovery, benchmark preservation and one-time docking.
