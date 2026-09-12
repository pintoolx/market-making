# Aqua execution (contracts)

Owner: pengu

Everything onchain: the Guard contract, the SwapVM strategy that calls it, and deploy and demo scripts.

## Available executor

[`aqua-executor/`](aqua-executor/) contains the imported Aqua / SwapVM v1.0.2 executor: approve, ship, quote, swap, atomic rebalance, dock, off-chain loss monitoring and resumable JSON execution. Its Base Sepolia deployment and historical transaction records are included. Node 24 is required; tests use Anvil.

From the repository root, run `pnpm install --frozen-lockfile`, `pnpm typecheck:contracts` and `ANVIL=/path/to/anvil pnpm test:contracts`. See the [migration notes](../docs/AQUA-EXECUTOR-MIGRATION.md) for provenance, package commands and validation.

The imported XYC program has no Guard instruction. Its JSON execution requests are local controller commands, not authenticated CRE reports. The Guard, workflow delivery and per-swap rejection demo described below remain to be implemented after agreeing the report format.

## Scope

- Deploy official Aqua and `AquaSwapVMRouter` contracts on a testnet (redeploying the official contracts is fine; `1inch/swap-vm` has `script/DeployAquaSwapVMRouter.s.sol`).
- **Guard contract**: receives the TEE report via `onReport`, stores the current parameters per strategy, and implements SwapVM's `IExtruction` / `IStaticExtruction` so every swap checks them. It can only tighten the Maker's hard limits, never loosen them, and stops trading when the report is stale.
- **Strategy program**: a curve instruction (for example `PeggedSwap` or `XYCSwap`) followed by `Extruction(Guard, hard limits)`. The Maker ships it once from their own wallet.
- **Demo**: a real token swap from a test taker, and a swap that the Guard rejects.

## Agree first

The report format with the confidential workflow in [`workflow/`](../workflow/). Keep the agreed schema in [`docs/`](../docs/).

Start review with the [Guard report v1 proposal](../docs/GUARD-REPORT-V1.md). It includes proposed ABI fields, units, expiry and replay behavior, an encoding fixture and the decisions that still require agreement.

## Background

- [What Aqua can enforce per swap, and the Guard design](../docs/AQUA-STRATEGY-DEEP-DIVE.md)
- Example Extruction target: `test/solidity/mocks/BestRouteSelector.sol` in `1inch/swap-vm`
