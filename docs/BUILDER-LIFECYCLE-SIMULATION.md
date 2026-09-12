# Builder lifecycle simulation

The Node adapter `aqua-executor/builder-simulation` recompiles the exact saved Maker revision before starting an owned Anvil process. It uses a finalized Ethereum Sepolia block and checks the manifest, six deployed runtime hashes, Guard/router bindings, token metadata, and the Circle USDC implementation address and runtime. Compilation mismatch fails before contacting RPC. Wrong deployments fail before funding or shipping.

This is **`fork-with-overrides` evidence**, with `registrationReady: false`. The upstream RPC is read-only. The child forks the deployed Aqua/router/Guard and canonical WETH/USDC; local impersonation provides synthetic funds, Maker/Taker signatures and forwarder authority. No real wallet funding, signed CRE report, DON/TEE attestation or public transaction is proven. Two virtual-inventory stress cases also impersonate the router locally to exhaust an Aqua balance through `pull`; they do not claim the deployed router exposes that action to a user.

The user-controlled public draft supplies the pair, curve, allocation, deadline, salt and immutable caps. RPC URL, Anvil executable, profile and historical block selection are trusted worker configuration, never model or HTTP request fields. The adapter is not yet mounted in the API, durable job queue or agent tools.

## Current matrix

Each of XYC, fixed-range CLMM and Pegged has 25 named checks and 11 successful swaps in the checked-in acceptance fixtures:

- Ship the exact compiled strategy; reject a swap without a report.
- Settle both directions and sequential trades; compare quote, swap event, Maker/Taker ERC20 transfers and Aqua virtual balances.
- Reject above either token's amount cap, disabled direction and inventory cap. For each direction, accept exactly at all four report caps, then reject one atomic unit above each limit. The immutable program envelope still clamps reports.
- Reject exact-out in both directions using correctly denominated output amounts.
- Reject wrong chain/Guard/router report domains, wrong report sender and wrong token pair. Identical report submission emits no duplicate event; conflicting reuse of a nonce reverts.
- Switch the active hash; pausing inactive A leaves active B unchanged. Restore A with a new report.
- Preserve schema-1 expiry at 600 seconds; schema-2 standing authorization still settles after one hour without increasing caps.
- Show that virtual inventory can quote when a Maker wallet cannot settle, in both directions. Separately exhaust virtual output inventory and require an actual reverted receipt.
- Settle before and exactly at the program deadline; reject afterward. Maker revoke blocks new authorization, unrevoke alone does not reactivate, a fresh report restores trading, and dock invalidates the strategy.

Rejected receipts must leave ERC20 balances, Aqua balances and the relevant Guard report/active hash unchanged. Native gas is excluded. Snapshots isolate cases; successful swaps also retain the report unchanged. Quote and settlement use identical timestamps, with receipt block readback verifying this. Receipt polling does not use a monotonic block watcher because snapshots rewind block numbers.

`passed` means every applicable check in this matrix passed. `coverageComplete` additionally requires that none were skipped. Short program deadlines can make the ten-minute legacy-expiry or one-hour standing check inapplicable; those have `passed: null`, not a fabricated pass. Tiny amounts, inconsistent caps or exhausted liquidity can produce a failed case for the user to revise. This finite matrix is not a proof of every possible curve input or all requirements in the complete Builder goal.

## Run and inspect

From `contracts/aqua-executor`, with the repository-pinned Node/pnpm and Anvil toolchain installed:

```bash
node scripts/eval-builder-simulation.ts xyc
node scripts/eval-builder-simulation.ts concentrated
node scripts/eval-builder-simulation.ts pegged
```

`ANVIL` optionally points to the binary. `BUILDER_FORK_RPC_URL` optionally configures a Sepolia read endpoint; the default is `https://ethereum-sepolia-rpc.publicnode.com`. `BUILDER_FORK_BLOCK` optionally selects an already finalized historical block. No `.env` or wallet credential file is loaded. Fresh, unfunded public identities are generated for these fixtures; their private keys are never used for signing.

Full public inputs, compiled bytes and case results are written to ignored `.cache/builder/lifecycle-{curve}.json` at repository root. Local transaction hashes belong only to the destroyed child fork and must not be linked to Etherscan. Snapshots can repeat transaction hashes in different states; retain case name and receipt block hash.

The standard executor test suite includes fail-closed compilation/profile/abort tests, proxy implementation validation and an actual child fork against a read-only RPC proxy. A network acceptance test is optional:

```bash
BUILDER_FORK_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  node --test test/builder-simulation.test.ts
```

Every fork has a five-minute abort budget. Completion, failure and cancellation terminate and await the owned child, with a bounded forced-kill fallback. Infrastructure failures are not accepted as contract vetoes, and raw provider errors are not exported.

## Evidence and remaining work

The committed [acceptance records](builder-simulation/) preserve public fixture inputs and complete results. These run deployed Sepolia bytecode on a local fork. Source-to-runtime rebuilding, full curve/range/extreme-input coverage, real-context funding/allowances and live Sepolia delivery remain separate gates. Durable simulation leases/results/API/tools/UI, previews, wallet plans and cloud worker rollout are still pending; successful standalone evaluation does not complete those items.

The time-control RPC is documented in [Foundry's API](https://foundry-rs.github.io/foundry/anvil/eth/api/struct.EthApi.html#method.evm_set_block_timestamp_interval). Circle's [UpgradeabilityProxy source](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol) defines the legacy implementation slot used by the verifier. The pinned Aqua source defines `ship`, `dock` and `pull`; the pinned SwapVM Controls source accepts timestamps equal to the deadline. Runtime acceptance, source pins and synthetic setup are recorded separately.
