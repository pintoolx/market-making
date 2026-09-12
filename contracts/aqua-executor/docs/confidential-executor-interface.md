# Confidential workflow to Aqua executor interface

The Aqua executor accepts validated JSON requests from the confidential workflow and performs durable `ship`, `rebalance`, `swap`, `monitor` and `dock` operations. The currently verified Base Sepolia lifecycle includes approve → ship → swap → rebalance → swap → dock → revoke. Both strategies were docked after verification and all Maker allowances were revoked.

[Transaction evidence](base-sepolia-demo.md) · [Deployment manifest](../deployments/84532.json) · [Execution and recovery contract](execution-recovery.md)

The confidential workflow supplies the following `AquaStrategyParams` value as the `strategy` field of a `ship` or `rebalance` request. The executor validates, encodes and executes it.

```ts
export type Hex = `0x${string}`

export interface AquaStrategyParams {
  /** Pins the deployed router's opcode table and ABI (swap-vm v1.0.2, NOT swap-vm main). */
  schema: 'aqua-swapvm-v1.0.2'
  chainId: number
  maker: Hex
  /** Exact token list shipped, and later docked. */
  tokens: Hex[]
  /** Raw units, same order as `tokens`. */
  amounts: string[]
  program: {
    /** Constant product x*y=k with a flat fee taken from amountIn. */
    kind: 'xyc'
    feeBps: number
    /** Unix seconds. */
    deadline: number
    /** uint64. A new salt gives a new strategyHash, which is required to ship again after a dock. */
    salt: string
  }
  meta: { producer: 'fixed-params' | 'tee'; strategyVersion: number; paramsRevision: number }
}
```

The following evidence snapshot is the exact `strategies[0].params` value from a successful Base Sepolia lifecycle. Its addresses are deployed test tokens and its amounts use atomic units. The strategy is already docked; a new execution must use a future deadline and a fresh salt.

```json
{
  "schema": "aqua-swapvm-v1.0.2",
  "chainId": 84532,
  "maker": "0x32F79282124EaFc681601cDCa2883C672C72D340",
  "tokens": [
    "0x051a2cae44c673c576b75b5df6f8543bf5d5cc13",
    "0xa66378d3f585fd34e875cccea69061c46bce5ecc"
  ],
  "amounts": [
    "2000000000000000000",
    "5000000000"
  ],
  "program": {
    "kind": "xyc",
    "feeBps": 30,
    "deadline": 1789151470,
    "salt": "9720735114401419293"
  },
  "meta": {
    "producer": "fixed-params",
    "strategyVersion": 1,
    "paramsRevision": 1
  }
}
```

## Field contract

- `chainId`, `maker` and `tokens` must match the target deployment and execution network.
- `tokens` contains exactly two distinct addresses. `amounts` contains positive atomic-unit integers in the same order. The snapshot uses 2 mWETH with 18 decimals and 5,000 mUSDC with 6 decimals.
- `feeBps: 30` means 0.30%. `deadline` is a future Unix timestamp. `salt` is a decimal uint64 and must change for each strategy version; a docked strategy hash cannot be shipped again.
- TEE-produced parameters set `meta.producer` to `tee`. `strategyVersion`, `paramsRevision` and `chainId` are tracking metadata and are not encoded into the SwapVM order. Changing only those fields does not change the strategy hash.
- This interface currently supports `xyc`. Aqua virtual balances constrain liquidity and the SwapVM deadline enforces expiry. The separate [loss monitor](risk-monitor.md) docks a strategy after its configured loss threshold relative to HODL is reached. It is a reaction mechanism, not an onchain maximum-loss guarantee.
- The Maker approves Aqua; the taker approves the router. `buildTx.*` exposes unsigned lifecycle transactions. Contract deployment and taker gas funding still use the Maker signer directly.

## Durable execution

Call `executeRequest(ctx, deployment, request, options)`. Every new operation uses a unique `requestId`; exact retries reuse the same ID and content. The initial `ship` request sets the session's `RiskPolicy`; later rebalances cannot replace it. Every non-ship request includes the previous result's `expectedStrategyHash` to prevent execution against the wrong strategy.

Use `watchExecution()` or `npm run execute -- --session <id> --watch` with `createChainlinkPrices()` for continuous monitoring. A watcher resumes pending work and recognizes a rebalance confirmed by another process. Every process controlling the same Maker and taker must share one state directory. The legacy `createMonitorSession()` and `npm run monitor` path has no durable transaction journal and must not sign concurrently with the controller.

The existing public testnet evidence uses mock tokens. Recovery behavior is separately verified with local Anvil, forced process interruption and CLI restart. Setting `meta.producer: 'tee'` is metadata and does not constitute TEE attestation.
