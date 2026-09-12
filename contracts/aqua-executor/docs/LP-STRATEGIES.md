# LP programs on the pinned Aqua router

All programs target swap-vm `32c687c2b73101fc26549e48fa1ff8a4d73afbac` (v1.0.2), SDK 0.4.4. These opcodes do not match upstream main. Existing XYC bytes, deployments and Guard v1 artifacts are unchanged.

## PeggedSwap

Replace the `program` in a regular executor strategy with:

```json
{
  "kind": "pegged",
  "feeBps": 5,
  "deadline": 2000000000,
  "salt": "9001",
  "linearWidth": "1000000000000000000000000000",
  "referenceBalances": ["1000000000", "1000000000000000000000"],
  "rates": ["1000000000000", "1"]
}
```

This example pairs a 6-decimal dollar token with an 18-decimal dollar token, with 1,000 units of each as references. Both arrays follow `tokens[]`; the compiler handles address sorting. References are independent of the currently funded amounts. They define the curve's normalization and must not be recomputed from inventory after each trade. `linearWidth` is A scaled by 1e27, at most 5000e27. Initial normalized reserves and references must be positive and at most 1e30, the pinned implementation's documented arithmetic domain. Large subsequent trades may revert on arithmetic or liquidity limits.

Regular programs support fees and the existing `execute` JSON ship/swap/rebalance/monitor/dock and journal recovery. Supply a price provider covering **both actual token addresses**; the default ETH/USDC Chainlink provider does not cover arbitrary stablecoins. No automatic assumption that a stablecoin is worth $1 is made by the executor.

`compileGuarded(params, guard, caps)` also supports PeggedSwap with **zero fee**, returning `guarded-pegged-v1`. Reports use the existing 512-byte report-v1 ABI. Missing, expired, disabled or over-limit authorization reverts quote and swap. This does not itself detect a depeg; the report issuer or offchain risk monitor must supply that decision. Legacy JSON execution deliberately rejects the specialized marker instead of silently dropping the Guard; retain the compiled object when using the transaction builders.

Run the real-router local fixture with:

```sh
ANVIL=/path/to/anvil node --test test/pegged.test.ts
```

The fixture deploys a separate 18-decimal mock stablecoin and uses explicitly synthetic prices/reports. It covers byte encoding, reversed addresses, 6/18 decimals, two trade directions, inventory veto, a mined reverted swap, fees, idempotent execution and atomic replacement preserving the HODL baseline. It is not a CRE/TEE delivery test or a public-chain deployment.

Contract math: [pinned PeggedSwap source](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/PeggedSwap.sol).
