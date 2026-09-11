# Aqua execution (contracts)

Owner: pengu

Everything onchain: the Guard contract, the SwapVM strategy that calls it, and deploy and demo scripts.

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
