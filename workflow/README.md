# Confidential workflow (Chainlink TEE)

Owner: ㄍㄨㄢ材

The target is a Chainlink CRE workflow that combines Provider logic and Maker limits inside a TEE, then writes public derived bounds to the Guard in [`contracts/`](../contracts/). The confidential evaluator is still pending.

## Available delivery adapter

[`guard-report/`](guard-report/) implements public report encoding, `runtime.report()` → `EVMClient.writeReport()`, Guard identity checks and receipt / state verification. A separate integration function accepts public output from `TeeRuntime.usingTheDons()`. The current entry point is an ordinary public cron fixture, with SDK mock tests and a WASM build; it is not proof of DON or TEE execution.

Use Bun in that package; it is intentionally outside the pnpm workspace. The [runbook](guard-report/README.md) includes unsigned simulation Guard deployment data and a paused-report preparation command. The team currently has no CRE account or Confidential Workflows access, so CLI simulation / broadcast and production confidential execution remain pending. See the [selected B transport and verification boundary](../docs/CRE-GUARD-INTEGRATION.md).

## Target scope

- Take encrypted inputs from the Provider (strategy logic) and the Maker (budget, exposure limits), plus market data.
- Decide inside the enclave; output only derived values the Guard needs: swap directions, per-swap amount caps, absolute inventory caps and expiry. The current v1 has no remaining cumulative budget counter. Raw Provider logic and original Maker limits must not be published.
- Deliver the report through the Keystone forwarder to the Guard's `onReport(bytes metadata, bytes report)`.
- A CLI simulation (`cre workflow simulate --broadcast`) milestone must change state onchain and be labelled as simulation. The full confidential product needs separate real TEE evidence.

## Agree first

The [Guard report v1 proposal](../docs/GUARD-REPORT-V1.md) provides a draft ABI and shared encoding fixture for review with the contracts owner. Its fields and initial template are not yet agreed.

The report format between this workflow and the Guard contract. Keep the agreed schema in [`docs/`](../docs/) so both sides build against the same thing.

## Background

- [What Aqua can enforce per swap, and the Guard design](../docs/AQUA-STRATEGY-DEEP-DIVE.md)
- [Product spec and interfaces](../docs/PRODUCT-HANDOFF.md)
