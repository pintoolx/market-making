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

`compileGuarded(params, guard, caps)` also supports PeggedSwap with **zero fee**, returning `guarded-pegged-v1`. Reports use the existing 512-byte report-v1 ABI. Missing, expired, disabled or over-limit authorization reverts quote and swap. This does not itself detect a depeg; the report issuer or offchain risk monitor must supply that decision. The legacy compiler still rejects specialized markers. For durable execution, supply the explicit Guard recipe described below.

Run the real-router local fixture with:

```sh
ANVIL=/path/to/anvil node --test test/pegged.test.ts
```

The fixture deploys a separate 18-decimal mock stablecoin and uses explicitly synthetic prices/reports. It covers byte encoding, reversed addresses, 6/18 decimals, two trade directions, inventory veto, a mined reverted swap, fees, idempotent execution and atomic replacement preserving the HODL baseline. It is not a CRE/TEE delivery test or a public-chain deployment.

Contract math: [pinned PeggedSwap source](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/PeggedSwap.sol).


## Concentrated liquidity

Use `kind: "concentrated"`, `sqrtPriceMin` and `sqrtPriceMax` canonical integer strings in addition to fee/deadline/salt. The bounds are 1e18 fixed-point square roots of **raw tokenGt/tokenLt** prices. `concentrationBounds(tokens, decimals, "2000", "3000")` converts human token1/token0 prices, accounts for token decimals and address inversion, and rounds inward using integer math. For WETH/USDC, pass `[18, 6]`. Funds remain in the maker wallet; this is the pinned Aqua concentration instruction, not a Uniswap NFT position.

Both token amounts must be positive in this executor version. Exhausted one-sided inventory requires manual handling. The implied spot depends on inventory as well as bounds. Changing bounds does not guarantee that spot equals the external oracle. Quotes and preflight may revert for unusable ranges or amounts outside the deployed math's arithmetic/liquidity domain.

The curve emits Concentrate opcode 18, then XYC opcode 17. Concentrate changes VM balance registers to **virtual pricing reserves**. Therefore `compileGuardedV2` requires the separate `AquaGuardV2` contract, whose terminal gate reads actual inventory from `router.AQUA().rawBalances`. It preserves all VM registers and only checks the proposed real post-swap balances. Version-2 envelopes fail on Guard v1; existing Guard v1 deployment artifacts are not upgraded. Guarded templates remain zero-fee because the flat-fee instruction temporarily exposes net input to nested instructions.

Build and verify this independent artifact:

```sh
SOLC=/path/to/solc-0.8.30 node scripts/build-guard-v2.ts --check
ANVIL=/path/to/anvil node --test test/concentrated.test.ts
```

No public Guard v2 deployment is included. Deploy it with the same forwarder/router/workflow identity configuration as v1; its constructor discovers and pins Aqua from the router. The report ABI remains report-v1. Test forwarders and synthetic reports do not supply TEE attestation or DON authentication.

## Durable Guard recipes

For `execute` JSON or monitor plans, add a `guard` field to the ordinary strategy:

```json
{
  "address": "0xYOUR_DEPLOYED_GUARD_ADDRESS",
  "version": 2,
  "caps": {
    "maxAmount0PerSwap": "1000000000000000000",
    "maxAmount1PerSwap": "1000000000",
    "maxPostBalance0": "3000000000000000000",
    "maxPostBalance1": "6000000000"
  }
}
```

Version 1 accepts XYC/Pegged; version 2 accepts concentrated. Set feeBps to 0. `compileExecution` reconstructs the exact guarded bytecode from the persisted recipe; unknown fields, invalid versions and old specialized markers are rejected. Normal ship/rebalance/swap/dock/monitor requests and recovery use this compiler. **Every new strategyHash needs its own report**, including after changing range, salt or caps. Atomic dock/ship succeeds without a report but trading remains disabled until the authorized transport delivers one. The controller never fabricates that authorization.

Historical source snapshots preserve original testnet evidence; the new artifact and tests are separate evidence. Pinned math: [XYCConcentrate](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/XYCConcentrate.sol).
