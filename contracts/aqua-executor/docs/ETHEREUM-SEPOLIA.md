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
pnpm sepolia deploy-guard --execute
pnpm sepolia fund --execute
pnpm lifecycle --network ethereum-sepolia --rebalance
pnpm demo:guard --network ethereum-sepolia
```

Without `--execute`, Sepolia commands are read-only preflights. `sepolia deploy`
initializes the complete environment and writes `deployments/11155111.json`.

After Guard source changes, use `sepolia deploy-guard --execute` to reuse the verified
Aqua and router while deploying only the current Guard artifact. The command derives a
durable request ID from the bytecode and writes a versioned manifest named
`deployments/11155111.guard-<address>.json`; it never overwrites the public record of an
earlier run. Simulation uses the directory-listed forwarder and a zero workflow identity.
For a production receiver, provide all immutable identity fields explicitly:

```bash
pnpm sepolia deploy-guard --execute --production \
  --forwarder 0x... --workflow-id 0x... --workflow-owner 0x...
```

The old `deploy --network ethereum-sepolia` command refuses to create mocks. Guard V2
allows simulation only on local, Base Sepolia and Ethereum Sepolia; its production
identity checks are unchanged.


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

## Receiver revision and recovery

`upgrade-guard` is the fixed, recoverable operation used for the recorded
Maker-active replacement below; it updates the current bundle. For future
artifact or production identity changes, use `deploy-guard` and its versioned
manifest. These are separate journal requests; do not run both expecting the
same creation transaction.

The current artifact includes Maker-scoped `activeStrategyHash` enforcement.
The simulation receiver was replaced at [`0xfadc3165abeb127a0815d5ea4e2862ed430e1f70`](https://sepolia.etherscan.io/address/0xfadc3165abeb127a0815d5ea4e2862ed430e1f70)
using source commit `c15642de33a87d97042a88b4311642a7204fab6c`.
See [the separate revision proof](ethereum-sepolia-guard-revision.json) and
[creation receipt](https://sepolia.etherscan.io/tx/0x2b2ba81e2ed1e68dd7e8e88cbea2ce9f95d1a59517370702ecf06c1556e01567).
This adds one successful deployment to the earlier run; it does not rerun the
40-transaction demo.
The original 40-transaction run used an earlier V2 revision without this getter;
its receipts and source manifest remain historical. For an existing deployment,
run `pnpm sepolia upgrade-guard --execute` with the **same state directory**.
This deploys only a replacement simulation Guard, retains the Router and assets,
and uses its own durable `sepolia-guard-maker-active-v1` request. Repeating it
recovers the same creation hash. Do not delete the original deployment journal
to bypass the bytecode mismatch check. Fresh setups continue to use `deploy`.

A replacement has empty report state. Recompile future guarded programs with
the new address and obtain fresh strategy hashes and reports; existing programs
still reference the old immutable receiver. The original recorded strategies
are already docked. Replacement does not activate a strategy or deliver a CRE
report. Both workflow publishers reject receivers without the active-strategy
getter before writing.

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

Real CRE account access, confidential execution, public A/B mandate-switch
verification and frontend evidence integration remain separate acceptance items
in the [architecture](../../../docs/ARCHITECTURE.md). Local contract tests cover
atomic A/B switching. A successful asset migration
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
deployment/wrapping/receiver replacement recovery, repeated initialization without new transactions,
the 13-transaction lifecycle and concentrated Guard success/veto with unchanged
wallet/Aqua balances on rejection. Fork records are not public-chain evidence.
