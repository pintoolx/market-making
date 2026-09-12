# P1 risk monitor — Base Sepolia evidence

Completed on 2026-09-12 Taiwan time (2026-09-11 UTC). Both demonstrations used the existing [P0 deployment](base-sepolia-demo.md), unchanged contract artifacts, and actual mWETH/mUSDC transfers on Base Sepolia, chain 84532. Base mainnet was used only for read-only Chainlink references. No mainnet transactions were sent.

Each run executed 13 successful transactions: maker approve ×2 → ship → taker approve → swap → maker approve ×2 → atomic rebalance → taker approve → swap → **risk-dock** → maker revoke ×2. Both ended with `cycle: completed` and one risk-triggered dock.

| Result | Live Chainlink references | Explicitly simulated references |
|---|---|---|
| UTC run | 18:39:24–18:40:24 | 18:41:30–18:42:29 |
| Original benchmark | 2 mWETH + 1273.225449 mUSDC | 2 mWETH + 5000 mUSDC |
| Loss threshold | 100 bps (1%) | 100 bps (1%) |
| Before / after rebalance | 29 / 29 bps | 0 / 0 bps, displayed rounded down |
| Loss at automatic dock | **546 bps** | **226 bps** |
| Transactions | 13 success | 13 success |

These are loss-trigger demonstrations with mock assets. Live mode deliberately starts the pool at one-quarter of the real ETH/USDC reference ratio and performs adverse inventory swaps. It proves detection using actual reference prices, not a naturally occurring market loss. Simulated mode deliberately changes its ETH reference from $2500 to $10000 after two real 100 mUSDC swaps. The recorded `price_mode`, `simulated_prices`, source and evidence distinguish the scenarios.

## Live-price observations

At the triggering check, ETH/USD was **$2546.06860000**, USDC/USD **$0.99984987**. These are historical observations from this run, not current quotes.

| Feed | Round ID | Actual updatedAt (Unix seconds) |
|---|---|---|
| ETH/USD | `55340232221128657513` | `1789151693` |
| USDC/USD | `55340232221128654871` | `1789130477` |

The snapshot records Base mainnet block `51181333`, its timestamp `1789152013`, fetch time `1789152012`, and `asOf: 1789130477` (the older USDC observation). The source block was one second ahead of the local clock, inside the five-second tolerance. ETH and USDC passed their separate age limits, and the sequencer was up beyond the recovery grace period. Fetching did not replace observation timestamps.

At those same prices, the retained HODL benchmark was approximately $6365.17150 and strategy inventory $6017.12681. The exact values and integer threshold comparison are in the JSONL. The live demo's first swap was 6.366127 mUSDC and the second 127.322544 mUSDC.

See [price validation, feed proxies and upstream Chainlink sources](risk-monitor.md#live-prices) for implementation details. The mock assets themselves are not redeemable for the referenced assets.

## Transactions

| Action | Live run (Basescan) | Simulated run (Basescan) |
|---|---|---|
| Ship | [310516d8…](https://sepolia.basescan.org/tx/0x310516d884db36c768ee27c5e4039174e0addfce8f35243ef7afae7dad3d48f4) | [031b638a…](https://sepolia.basescan.org/tx/0x031b638a4babe426a2d2e37b2fafdb96d5e31ad261ab9847e4b4be7dbda1b3c2) |
| First swap | [7f8dfc23…](https://sepolia.basescan.org/tx/0x7f8dfc2339d94bb479ff73c0dcd8633b0877dc09a2c52fd5e500d799a2643761) | [daa99047…](https://sepolia.basescan.org/tx/0xdaa99047d78ad788f808d15df30f5c5787ac8c94421288bf3d0defba48b9eb77) |
| Rebalance | [40ce2ae9…](https://sepolia.basescan.org/tx/0x40ce2ae9f2cc06e33e9ab90b2cd4dab79efc50e42216690fcc46b5b22793fe5f) | [e45b503b…](https://sepolia.basescan.org/tx/0xe45b503b08a682868f0fc8218be87dc57891febf88b5f380feb9574637552a6a) |
| Second swap | [5054ddfe…](https://sepolia.basescan.org/tx/0x5054ddfe1c5ccaedd8b07159b22da09680f024e8a6210023f691a40117175ced) | [6bac80c3…](https://sepolia.basescan.org/tx/0x6bac80c3d1b73d951f878266ce0cfe93b210086c1e34d9fe956c2f2698ff61ed) |
| Automatic risk-dock | [e3480032…](https://sepolia.basescan.org/tx/0xe348003275c88c807a9a80a5186caf35ad4bf6f8834ba0669235ae8f79467cb7) | [e0cac0f3…](https://sepolia.basescan.org/tx/0xe0cac0f3a07a691f08da9cd0d1fec7c6475aeedc3017842e69fbac222f5dcc3c) |

Alternate dock links: [live on Blockscout](https://base-sepolia.blockscout.com/tx/0xe348003275c88c807a9a80a5186caf35ad4bf6f8834ba0669235ae8f79467cb7), [simulated on Blockscout](https://base-sepolia.blockscout.com/tx/0xe0cac0f3a07a691f08da9cd0d1fec7c6475aeedc3017842e69fbac222f5dcc3c). Automated Blockscout API access returned HTTP 403 in this run. Success was independently checked by rereading all 26 receipts over RPC; no claim is made that the explorer pages were visually inspected.

## Records and acceptance

- [Live run JSONL](../records/84532/risk-live-2026-09-11T18-39-23-812Z.jsonl), [retained plan](../records/84532/risk-live-2026-09-11T18-39-23-812Z.jsonl.plan.json), [actual price snapshot](../records/84532/risk-live-2026-09-11T18-39-23-812Z.jsonl.prices.json).
- [Simulated run JSONL](../records/84532/risk-simulated-2026-09-11T18-41-29-896Z.jsonl), [retained plan](../records/84532/risk-simulated-2026-09-11T18-41-29-896Z.jsonl.plan.json), [simulated price snapshot](../records/84532/risk-simulated-2026-09-11T18-41-29-896Z.jsonl.prices.json).
- [Independent RPC verification](../records/84532/risk-verification-2026-09-11.json): 26 successful receipts; all four original/replacement strategies have zero Aqua virtual balances and `tokensCount: 255`; maker's two Aqua allowances are zero.
- Every swap record has three decoded ERC20 `Transfer` events. Both plans preserve the original amounts, contain one confirmed rebalance entry, and finish with `finished: true`. The live sequence records the same 29 bps shortfall on each side of rebalance.
- [CLI restart record](../records/84532/monitor-2026-09-11T18-43-29-662Z.jsonl): reconstructed the replacement from its confirmed journal entry and returned `already-docked` without another transaction.

After both demos, maker gas was `0.000348472054279614 ETH`, taker gas `0.000093574255336324 ETH`. These are verification-time balances.

`ANVIL=$PWD/.cache/bin/anvil npm test`: **21/21 pass**. `npm run typecheck`: pass. Coverage includes exact loss boundaries, per-feed freshness, sequencer downtime/recovery, invalid data, confirmed journal proof, delayed journal publication, restart, unchanged benchmark, dry-run, read-error recovery, and one-time docking. The local CLI also completed the simulated full lifecycle and restart check; its Anvil was stopped afterward.

These runs predate the migration into `pintoolx/market-making`. P0 historical records and artifacts are unchanged. The [SHA-256 manifest](risk-monitor-source.sha256) identifies the source, parameters, dependency files and artifacts used for these runs. Use the [original package.json snapshot](source-snapshots/risk-monitor-package.json) for its `package.json` entry and the [original npm lock snapshot](source-snapshots/risk-monitor-package-lock.json) for `package-lock.json` when checking the historical manifest. After the Guard prototype added a legacy-compiler rejection check, use [the earlier compiler snapshot](source-snapshots/pre-guard-compile.ts) for `src/compile.ts`. The other listed files remain unchanged. Current workspace installs use the root pnpm lock; see the [migration notes](../../../docs/AQUA-EXECUTOR-MIGRATION.md).

To repeat using the existing deployment:

```bash
npm run demo:risk -- --network base-sepolia --price-source chainlink
npm run demo:risk -- --network base-sepolia --price-source simulated
```

These commands send testnet transactions and produce new salts, plans and logs. For a read-only restart check, use `npm run monitor -- --network base-sepolia --plan records/84532/risk-live-2026-09-11T18-39-23-812Z.jsonl.plan.json --once --dry-run`.

The threshold is a reaction trigger, not a guaranteed loss cap. These results also illustrate that a configured 1% threshold may be observed only after an adverse swap has already caused a larger loss. Full operational limits and the one-controller-per-maker requirement are in [the monitor documentation](risk-monitor.md).
