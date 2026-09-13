# aqua-executor

Execution side of the Strategy Provider × Maker market-making flow, built on **1inch Aqua + SwapVM**.

This package now lives in the [PinTool Market Making workspace](../../README.md). Install dependencies with `pnpm install --frozen-lockfile` at the repository root. Run the package commands below from `contracts/aqua-executor/`; `npm run` also works with the workspace-installed dependencies. The root `pnpm-lock.yaml` controls current installs.

**LP programs:** XYC, PeggedSwap and concentrated liquidity; each has a Guard V2 variant with optional fixed LP input fees. [LP setup, explicit Guard JSON recipes and automatic expiry rollover](docs/LP-STRATEGIES.md) describe the new interfaces and local validation.

A strategy's parameters can arrive through the [TEE JSON request entry](docs/execution-recovery.md) or the existing fixed-parameter demos. They are compiled into a SwapVM program and run through the Aqua lifecycle. Every transaction is written to a JSONL record.

```
maker approve(Aqua) → Aqua.ship → taker router.swap → [Aqua.multicall(dock old, ship new)] → Aqua.dock → revoke
```

**Ethereum Sepolia verification:** the public run uses canonical WETH and Circle testnet USDC and includes a full lifecycle, guarded swaps and an expected onchain rejection. See the [deployment runbook](docs/ETHEREUM-SEPOLIA.md), [transaction evidence](docs/ethereum-sepolia-demo.md) and [confidential executor interface](docs/confidential-executor-interface.md).

| Step | Signer | Call | What moves |
|---|---|---|---|
| approve | maker | `token.approve(Aqua, amount)`; the spender is **Aqua, not the router** | nothing |
| ship | maker | `Aqua.ship(router, abi.encode(order), tokens, amounts)` | nothing (virtual balances only) |
| swap | taker EOA | `tokenIn.approve(router)`, then `router.swap(order, tokenIn, tokenOut, amountIn, takerTraits)` | maker ⇄ taker via Aqua `pull` / `push` |
| rebalance | maker | `Aqua.multicall([dock(old), ship(new)])` in one tx | nothing |
| dock | maker | `Aqua.dock(router, strategyHash, tokens)` | nothing (strategy deactivated) |

## Contracts

The Ethereum Sepolia release uses the canonical Aqua address, canonical WETH and Circle test USDC. PinTool deploys its SwapVM Router and Guard while retaining the official Aqua custody and shared-liquidity model. Local tests deploy the pinned upstream contracts and mock assets on an isolated Anvil chain.

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

# Ethereum Sepolia: configure MAKER_PK, TAKER_PK and ETHEREUM_SEPOLIA_RPC_URL.
npm run sepolia -- status
npm run sepolia -- fund --execute

# Ship both strategies against the same Maker wallet balance.
npm run execute -- --network ethereum-sepolia --state-dir .state/executor/11155111-maker \
  --request releases/sepolia-maker-v1/featured-tight-market.ship.json
npm run execute -- --network ethereum-sepolia --state-dir .state/executor/11155111-maker \
  --request releases/sepolia-maker-v1/featured-defensive-market.ship.json
```

## Wallet trading

The web application's `/trade` page lists confirmed wallet activations and quotes their exact shipped program. Traders connect their own wallet, approve only the required input amount if necessary, review a fresh quote, and sign the swap themselves. Quotes enforce 0.5% slippage and a five-minute transaction deadline; the Guard is checked again before signing and during settlement. Pending transaction hashes survive a reload. A trading link from a mandate also records the verified settlement in that mandate's activity.

For integrations that supply their own wallet interface, prepare unsigned calldata with public RPC reads only:

```bash
npm run prepare:wallet-swap -- \
  --ship-transaction "$SHIP_TRANSACTION" --strategy-hash "$STRATEGY_HASH" \
  --maker "$MAKER_ADDRESS" --taker "$TAKER_ADDRESS" \
  --token-in "$INPUT_TOKEN_ADDRESS" --amount-in 250000 \
  --output unsigned-swap.json
```

The output contains an exact-amount approval only when needed, the quote, minimum output, deadline, and unsigned transaction. No signing key is loaded and no transaction is broadcast. Generate a fresh file before wallet submission; expired calldata must not be reused.

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
npm run execute -- --network ethereum-sepolia --request /path/to/request.json
npm run execute -- --network ethereum-sepolia --session session-123 --status
npm run execute -- --network ethereum-sepolia --session session-123 --watch
```

Requests support ship, swap, rebalance, monitor and dock. The controller stores its journal in `.state/executor/<chainId>/`, binds each request ID to its content, and resumes confirmed or pending transactions using their original hash and nonce. It keeps the HODL benchmark through rebalance and process restarts. A local SQLite lock coordinates processes sharing that directory. Do not run the legacy demos or another signing controller concurrently with these accounts. See [request fields, failure handling and recovery tests](docs/execution-recovery.md).

## Per-swap Guard

The [Guard](docs/guard.md) is an `onReport` receiver called by the SwapVM program on every quote and swap. It checks workflow identity, active strategy, report freshness, direction, per-token trade amounts and resulting inventory against the Maker-approved immutable envelope. It is separate from the off-chain loss monitor.

The local test harness validates all boundaries with synthetic reports. On Ethereum Sepolia, the Chainlink local simulator broadcasts reports through its official simulation forwarder. After a strategy switch, create an independently verifiable failed receipt with:

```bash
npm run verify:guard-rejection -- \
  --strategy releases/sepolia-maker-v1/featured-tight-market.ship.json \
  --request releases/sepolia-maker-v1/03-tight-market-inactive.swap.json \
  --mandate-api http://localhost:8787 \
  --mandate-id <mandate-id> \
  --provider-strategy-id featured-tight-market
```

The verifier first requires the exact `StrategyNotActive` Guard error, then broadcasts once and proves the reverted receipt emitted no swap and changed no token or Aqua balances.

## Risk monitor

For persistent confidential execution, use [the JSON controller and its watcher](docs/execution-recovery.md). It saves signed transactions before broadcasting, resumes the same request without duplicate operations, and retains the original risk benchmark.

The monitor reads Chainlink Ethereum mainnet ETH/USD and USDC/USD as reference prices, retries data failures, and follows confirmed rebalances while retaining the original HODL benchmark. Sepolia WETH and Circle test USDC are mapped explicitly to those reference feeds. See [risk policy, session API and limitations](docs/risk-monitor.md).

## Records

Builder drafts can also run the standalone [isolated lifecycle evaluator](../../docs/BUILDER-LIFECYCLE-SIMULATION.md). It forks pinned Sepolia deployments with synthetic local funding and report authority, verifies actual settlement/rejection receipts, and never writes to the public RPC. These results do not yet enable Builder wallet registration.

`records/<chainId>/<runId>.jsonl`, one JSON object per line:

| `kind` | Meaning |
|---|---|
| `execution` | One per tx: action, tx hash, status, block, gas, decoded Aqua/SwapVM/ERC20 events, explorer link. |
| `check` | On-chain post-condition read after a tx: Aqua `rawBalances`, where `tokensCount` is 2 after ship and 255 after dock. |
| `cycle` | Run summary: status, strategy params and hashes, swap amounts vs quote. A future adapter to PinTool `private_execution_cycles` must add its required identifiers, including `deployment_id` and `idempotency_key`. |

## License / attribution

SwapVM — © Degensoft Ltd 2025. Aqua — © Degensoft Ltd 2025. The contracts are used under the Degensoft SwapVM-1.1 and Aqua-Source-1.1 licenses; see the upstream repos. Production or commercial use needs a separate license from 1inch/Degensoft. This package's own code is MIT.
