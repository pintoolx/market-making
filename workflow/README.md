# Confidential workflow (Chainlink TEE)

Owner: ㄍㄨㄢ材

A Chainlink CRE workflow whose confidential part runs in a TEE. It reads the Provider's private logic and the Maker's private limits, checks whether they fit together, and writes a report onchain for the Guard contract in [`contracts/`](../contracts/).

## Scope

- Take encrypted inputs from the Provider (strategy logic) and the Maker (budget, exposure limits), plus market data.
- Decide inside the enclave; output only the minimal derived values the Guard needs (for example: which swap directions are allowed, remaining amounts, an expiry time). Never write the raw Provider logic or Maker limits onchain.
- Deliver the report through the Keystone forwarder to the Guard's `onReport(bytes metadata, bytes report)`.
- CLI simulation (`cre workflow simulate`) is acceptable for the demo; the result must still change state onchain.

## Agree first

The report format between this workflow and the Guard contract. Keep the agreed schema in [`docs/`](../docs/) so both sides build against the same thing.

## Background

- [What Aqua can enforce per swap, and the Guard design](../docs/AQUA-STRATEGY-DEEP-DIVE.md)
- [Product spec and interfaces](../docs/PRODUCT-HANDOFF.md)
