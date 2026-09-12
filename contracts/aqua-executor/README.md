# aqua-executor

Execution side of the Strategy Provider × Maker market-making flow, built on **1inch Aqua + SwapVM**.

This package now lives in the [PinTool Market Making workspace](../../README.md). Install dependencies with `pnpm install --frozen-lockfile` at the repository root. Run the package commands below from `contracts/aqua-executor/`; `npm run` also works with the workspace-installed dependencies. The original npm lock is retained only as a historical [source snapshot](docs/source-snapshots/risk-monitor-package-lock.json); the root `pnpm-lock.yaml` controls current installs. See [migration and implementation status](../../docs/AQUA-EXECUTOR-MIGRATION.md).

**LP programs:** XYC, PeggedSwap and concentrated liquidity; each has a zero-fee guarded variant. [LP setup, explicit Guard JSON recipes and automatic expiry rollover](docs/LP-STRATEGIES.md) describe the new interfaces and local validation.

A strategy's parameters can arrive through the [TEE JSON request entry](docs/execution-recovery.md) or the existing fixed-parameter demos. They are compiled into a SwapVM program and run through the Aqua lifecycle. Every transaction is written to a JSONL record.

```
maker approve(Aqua) → Aqua.ship → taker router.swap → [Aqua.multicall(dock old, ship new)] → Aqua.dock → revoke
```

**Current route: Ethereum Sepolia WETH / Circle testnet USDC.** See [funding, deployment, small demos and verification](docs/ETHEREUM-SEPOLIA.md). [Public run: 39 successful transactions and one expected Guard revert](docs/ethereum-sepolia-demo.md). Run `pnpm sepolia status` before deployment.

**Historical Base Sepolia demo completed:** 13 successful lifecycle transactions, including two swaps and atomic rebalance. See [deployment addresses and transaction evidence](docs/base-sepolia-demo.md), or forward the [confidential executor interface](docs/confidential-executor-interface.md) to the integration team.


| Step | Signer | Call | What moves |
|---|---|---|---|
| approve | maker | `token.approve(Aqua, amount)`; the spender is **Aqua, not the router** | nothing |
| ship | maker | `Aqua.ship(router, abi.encode(order), tokens, amounts)` | nothing (virtual balances only) |
| swap | taker EOA | `tokenIn.approve(router)`, then `router.swap(order, tokenIn, tokenOut, amountIn, takerTraits)` | maker ⇄ taker via Aqua `pull` / `push` |
| rebalance | maker | `Aqua.multicall([dock(old), ship(new)])` in one tx | nothing |
| dock | maker | `Aqua.dock(router, strategyHash, tokens)` | nothing (strategy deactivated) |

## Contracts

The Base Sepolia demo deploys the **official, unmodified** Aqua / SwapVM sources using `pnpm run deploy`. The pinned versions below were compared against the canonical mainnet contracts during the original work. It also deploys two mintable mock tokens (`mWETH`, `mUSDC`).

| Contract | Source | Canonical mainnet address |
|---|---|---|
| AquaRouter (Aqua + Multicall) | [1inch/aqua](https://github.com/1inch/aqua) @ `9c5c42e` | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` |
| AquaSwapVMRouter | [1inch/swap-vm](https://github.com/1inch/swap-vm) @ `v1.0.2` | `0x111111338c5091E8440b67B168bAe16a668AC0De` |

Program encoding targets **router v1.0.2**, via `@1inch/swap-vm-sdk@0.4.4`. The opcode table on swap-vm `main` is different: its orders silently mis-encode against v1.0.2. `test/compile.test.ts` pins the exact bytes.

Parity with the canonical Base mainnet deployment was checked by deploying the artifacts and diffing the runtime code byte for byte:

| Contract | Result |
|---|---|
| AquaRouter | Identical: 5619/5619 bytes, CBOR metadata included. |
| AquaSwapVMRouter | 20541 bytes, identical except solc immutable slots: the Aqua address, and the EIP-712 cached chainId, address and domain separator. |

`artifacts/*.json` are committed. Rebuild them with `FORGE=/path/to/forge npm run build:contracts`. Verified with forge 1.8.1. The script fails if the creation bytecode hash drifts.

## Run

Requires Node ≥ 24. The tests also need [anvil](https://book.getfoundry.sh/).

```bash
pnpm install --frozen-lockfile  # run at the repository root, then cd contracts/aqua-executor
npm test                       # golden encoding tests + full lifecycle and guard-rail tests on a throwaway anvil
                               # (ANVIL=/path/to/anvil if it's not on PATH)

# local chain
anvil &
npm run deploy -- --network local
npm run lifecycle -- --network local --rebalance

# Base Sepolia: fill .env from .env.example and fund MAKER with >= 0.001 Base Sepolia ETH
# (deploy ≈ 7.1M gas ≈ 0.00005 ETH at 0.006 gwei; deploy also sends the taker 0.0005 ETH for gas)
npm run deploy -- --network base-sepolia      # writes deployments/84532.json
npm run lifecycle -- --network base-sepolia --rebalance
```

## Strategy params: the TEE hand-off

`AquaStrategyParams` (`src/types.ts`) is the contract between the TEE agent and this executor. The JSON entry accepts it as `request.strategy` for ship/rebalance. The fixed demos still use `src/fixed-params.ts`: 30 bps XYC on mWETH/mUSDC, 1h expiry, ship 2 mWETH + 5000 mUSDC. Actual TEE service integration is separate from this validated input interface.

How the maker's risk limits map onto the params:

| Risk limit | Enforcement |
|---|---|
| Capital limit | `amounts`. Aqua only pulls against the virtual balance, so the maker's net outflow per token never exceeds what was shipped. |
| Expiry | `program.deadline`, the SwapVM `deadline` opcode. |
| Max loss | [Off-chain monitor](docs/risk-monitor.md) docks when the strategy's loss relative to HODL reaches a threshold, using a separately supplied price feed and retained benchmark. This is not an on-chain loss cap. |

Lifecycle signing goes through `send()` in `src/executor.ts`. Lifecycle transactions are built unsigned first (`buildTx.*`), so a wallet or a TEE can sign instead. Contract deployment and taker gas funding in `src/deploy.ts` sign directly through the maker wallet; those operations do not yet have an unsigned transaction interface.

## JSON execution and recovery

```bash
# Schema validation only; no RPC or signing.
npm run execute -- --request examples/ship-request.json --validate

# Submit an actual request from the TEE/controller; retry with the same JSON and ID.
npm run execute -- --network base-sepolia --request /path/to/request.json
npm run execute -- --network base-sepolia --session session-123 --status
npm run execute -- --network base-sepolia --session session-123 --watch
```

Requests support ship, swap, rebalance, monitor and dock. The controller stores its journal in `.state/executor/<chainId>/`, binds each request ID to its content, and resumes confirmed or pending transactions using their original hash and nonce. It keeps the HODL benchmark through rebalance and process restarts. A local SQLite lock coordinates processes sharing that directory. Do not run the legacy demos or another signing controller concurrently with these accounts. See [request fields, failure handling and recovery tests](docs/execution-recovery.md).

## Per-swap Guard prototype

The [Guard prototype](docs/guard.md) adds an `onReport` receiver and a fixed zero-fee XYC program that calls the Guard on each quote / swap. It checks report freshness, direction, per-token trade amounts and resulting inventory against the Maker-approved envelope. This is separate from the off-chain loss monitor. The included demo uses synthetic reports through a project-owned test harness; CRE delivery and workflow agreement remain pending.

Run `pnpm demo:guard --network local` after local deployment, or use the existing Base Sepolia deployment with isolated demo accounts. See [build instructions, supported APIs and limitations](docs/guard.md) and [completed Base Sepolia evidence](docs/guard-sepolia-demo.md).

## Risk monitor

For persistent TEE-controlled execution, use [the JSON controller and its watcher](docs/execution-recovery.md). It saves signed transactions before broadcasting, resumes the same request without duplicate operations, and retains the original risk benchmark. The commands below describe the earlier standalone monitor/demo path.

The monitor reads Chainlink ETH/USD and USDC/USD, retries data failures, and follows confirmed rebalances while retaining the original HODL benchmark. For an active strategy, run `npm run monitor -- --network base-sepolia --plan /path/to/plan.json`. See [risk policy, session API and limitations](docs/risk-monitor.md).

Run `npm run demo:risk -- --network base-sepolia --price-source chainlink` for real reference prices with an intentionally mispriced mock pool, or `--price-source simulated` for a clearly labelled fabricated-price scenario. Both execute swaps, a monitored rebalance and automatic risk-dock. For an offline local demo, use `--network local --price-source simulated` after deployment. [Testnet evidence](docs/risk-monitor-sepolia.md) distinguishes both scenarios.

## Records

`records/<chainId>/<runId>.jsonl`, one JSON object per line:

| `kind` | Meaning |
|---|---|
| `execution` | One per tx: action, tx hash, status, block, gas, decoded Aqua/SwapVM/ERC20 events, explorer link. |
| `check` | On-chain post-condition read after a tx: Aqua `rawBalances`, where `tokensCount` is 2 after ship and 255 after dock. |
| `cycle` | Run summary: status, strategy params and hashes, swap amounts vs quote. A future adapter to PinTool `private_execution_cycles` must add its required identifiers, including `deployment_id` and `idempotency_key`. |

## License / attribution

SwapVM — © Degensoft Ltd 2025. Aqua — © Degensoft Ltd 2025. The contracts are used under the Degensoft SwapVM-1.1 and Aqua-Source-1.1 licenses; see the upstream repos. Production or commercial use needs a separate license from 1inch/Degensoft. This package's own code is MIT.
