# Ethereum Sepolia: WETH / Circle testnet USDC

This is the current demo asset route (chain ID **11155111**). The [public run](ethereum-sepolia-demo.md) is complete: 39 successful transactions and one expected Guard revert. Base Sepolia mock
records remain historical regression evidence. There is no token renaming or
minting in the Ethereum Sepolia deployment/funding path.

## Assets and funding

| Contract | Ethereum Sepolia address | Source |
|---|---|---|
| Aqua registry | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` | Existing registry, checked with RPC before execution |
| WETH9, 18 decimals | `0xfff9976782d46cc05630d1f6ebab18b2324d6b14` | [Uniswap deployment list](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments) |
| Circle testnet USDC, 6 decimals | `0x1c7d4b196cb0c7b01d743fbc6116a902379c7238` | [Circle contract list](https://developers.circle.com/stablecoins/usdc-contract-addresses) |
| CRE simulation forwarder | `0x15fc6ae953e024d975e77382eeec56a9101f9f88` | [Chainlink directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts) |

As checked on 2026-09-12, [Circle's faucet](https://faucet.circle.com/) offers 20
USDC per address/network every two hours. [ETHGlobal's Sepolia faucet](https://ethglobal.com/faucet/sepolia-11155111-eth)
lists 0.05 ETH/day with login. Availability and eligibility can change. WETH is
obtained by depositing Sepolia ETH 1:1, with separate native ETH kept for gas.

Target an initial 0.05 native ETH and 20 USDC in the maker. Funding wraps only the
shortfall needed for **0.005 maker WETH + 0.001 taker WETH**, sends the taker up to
5 USDC and 0.005 ETH, and requires at least 10 USDC plus a 0.012 ETH operational
reserve to remain in the maker before funding gas. These are demo allocations,
not protocol minimums or guaranteed gas estimates. Extra tokens stay in the maker.

`params/sepolia.json` ships 0.004 WETH / 10 USDC, uses zero LP fees and swaps 0.5
USDC at a time. Its 2500 USDC/WETH reference is an **explicit recording fixture**,
not a live price or test-token valuation. The concentrated Guard demo derives its
2000–3000 range with `concentrationBounds()` and scales fill/inventory limits to
the same small allocation. Each demo docks and revokes its allowances on success.

## Commands

From `contracts/aqua-executor/`, set `MAKER_PK`, `TAKER_PK` and optionally
`ETHEREUM_SEPOLIA_RPC_URL` in an ignored `.env`. Do not use local Anvil keys on a
public chain. Status requires no keys and accepts public address overrides:

```bash
pnpm sepolia status
pnpm sepolia status --maker 0x... --taker 0x...
pnpm sepolia deploy --execute
pnpm sepolia fund --execute
pnpm lifecycle --network ethereum-sepolia --rebalance
pnpm demo:guard --network ethereum-sepolia
```

Without `--execute`, `sepolia deploy` and `sepolia fund` are read-only preflights.
The old `deploy --network ethereum-sepolia` command refuses to create mocks.
The new deployment command reuses Aqua/WETH/USDC, deploys pinned SwapVM v1.0.2
and AquaGuardV2, and writes `deployments/11155111.json`. The bundle includes the
CRE simulation receiver identity. Guard V2 allows simulation only on local,
Base Sepolia and Ethereum Sepolia; its production identity checks are unchanged.

Deployment and funding save signed bytes **before broadcast** in
`.state/sepolia/<maker>/`. Retry the same command and state directory after an
interruption. It recovers the same hashes/nonces instead of creating another
Router or depositing ETH twice. Funding saves one initial allocation: rerunning
it later does not replenish assets spent by subsequent demos. Do not delete the
journal or switch state directories to work around an unresolved transaction.
An external transaction consuming a saved nonce fails closed for inspection.

Durable public JSONL exports are under the state directory's `records/`; signed
bytes remain in its ignored SQLite journal. Lifecycle and Guard demo records go
to `records/11155111/`. Preserve failed-run records too. The fixed lifecycle and
Guard demo themselves are not resumable controllers: inspect active strategies
and allowances before restarting an interrupted run. The JSON execution entry
remains the supported strategy-operation recovery interface.

## Guard and workflow boundary

There are two separately identified receivers:

- `deployment.guard` trusts Chainlink's **simulation** forwarder and is prepared
  for CRE CLI delivery. It uses zero workflow identity. This is not a production
  DON configuration. Confirm tenant-specific `cre workflow supported-chains`
  output after login before using it with the actual CLI.
- `demo:guard` creates a separate AquaGuardV2 with the project's owner-controlled
  test forwarder. Its synthetic reports exercise real swaps and an actual mined
  revert. The summary records this receiver separately and does not overwrite
  the CRE receiver. This proves enforcement, not CRE delivery or TEE execution.

`workflow/guard-report` now reads the Sepolia deployment bundle when preparing
unsigned deployments or paused probes. It uses the same 16-field report ABI and
checks receiver identity/receipt/digest. `workflow/market-maker-auth` takes its
Guard and Router from public workflow config, rather than embedding old Base
addresses. Its examples are dry-run fixtures; fill them from the confirmed
deployment and current guarded strategy hash before broadcasting. The
orchestrator defaults to Sepolia RPC/explorer/chain ID. The UI shows WETH / USDC
with Ethereum Sepolia identification and small suggested limits.

Real CRE account access, confidential execution, atomic A/B mandate switching,
and frontend evidence integration are separate acceptance items in
[`WINNING-FLOW.md`](../../../docs/WINNING-FLOW.md). A successful asset migration
does not establish those milestones. Existing `demo:risk` intentionally remains
restricted to the old mock fixture; the generic monitor/controller can use the
new assets and deployment with an explicit price source.

## Verification

```bash
pnpm typecheck
ANVIL=/path/to/anvil pnpm test
SEPOLIA_FORK_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  ANVIL=/path/to/anvil node --test test/sepolia-fork.test.ts
SOLC=/path/to/solc-0.8.30 pnpm build:guard:v2 --check
```

The optional fork test uses the real WETH9, Circle USDC proxy/implementation,
and Aqua from Sepolia. It impersonates USDC's issuer **only on its child Anvil**
to create a 20-USDC fixture; upstream RPC calls are read-only. It checks interrupted
deployment/wrapping recovery, repeated initialization without new transactions,
the 13-transaction lifecycle and concentrated Guard success/veto with unchanged
wallet/Aqua balances on rejection. Fork records are not public-chain evidence.
