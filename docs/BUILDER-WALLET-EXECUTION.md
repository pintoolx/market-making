# Builder Maker wallet execution

Implemented in Draft [PR #102](https://github.com/pintoolx/market-making/pull/102).
The preparation dialog supports explicit wallet transactions after reviewed
compilation and simulation. The service has only public RPC access; the browser's
connected Maker wallet signs and sends each transaction.

## Supported actions

| Action | Effect and prerequisites |
|---|---|
| Approve WETH / USDC | Sets the exact reviewed Aqua allowance, shared across this wallet's strategies |
| Ship | Registers compiled virtual balances in Aqua; needs balances and both allowances |
| Dock | Disables the exact historical strategy hash; does not revoke allowances |
| Guard revoke | Persists Maker revocation for that strategy |
| Guard unrevoke | Clears revocation; a new enabled report is still required. Legacy nonzero-fee artifacts are blocked |
| Revoke allowances | Sets both Aqua allowances to zero, affecting all strategies sharing them |

Registration requires the current Maker revision, matching immutable artifact
and plan, requirement review when requirements exist, and a completed successful
fork simulation with no skipped cases. Mock results cannot unlock signing.
The deadline must be more than 30 seconds away. Zero fees are the only supported
[Guard composition](BUILDER-FEE-GUARD-LIMITATION.md).

Dock/revoke and transaction recovery remain available for older, expired or
now-unsupported versions through a historical version selector. An old result
cannot authorize a new registration.

## Preflight and transaction evidence

Before opening the wallet, the service verifies chain identity and Guard/router/
forwarder binding, a fresh canonical head, pending and confirmed Maker nonce,
balances, allowances and Aqua state. It performs `eth_call`, estimates gas with
a margin, checks gas ETH and issues a request expiring after 30 seconds. The
browser independently decodes the plan, verifies Maker and Ethereum Sepolia,
and submits the exact destination, calldata, value and nonce. Every send needs
an explicit click and wallet prompt. Wallet confirmation can outlast preflight;
onchain checks still govern settlement, so this does not guarantee future success.

Migration `018_wallet_execution.sql` persists the request **before** the wallet
prompt. A Maker can have only one unresolved Builder request. The journal stores
owner, plan/step, request digest, nonce, start block, hash, state and evidence.
Optimistic versions prevent a late RPC result from replacing newer evidence.
An external pending wallet nonce also blocks new preparation.

States distinguish awaiting wallet, pending, unverified, confirmed, reverted,
replaced and explicitly rejected requests. The browser polls pending evidence,
retains public hash hints locally and reloads the journal after failures. A hash
alone does not prove success: reconciliation checks exact Maker/nonce, calldata,
destination/value, canonical receipt, expected event and contract readback.
Default public RPC confirmation depth is two blocks. Success is evidence at that
block, not current trading readiness. Missing readback/reorg stays unresolved.

For lost hashes, bounded historical nonce queries locate canonical consumption
and verify the mined transaction. Different replacement calldata is recorded as
replaced; an exact repriced transaction can confirm the original step. Users can
provide a public hash if their RPC cannot supply historical nonce state. Only an
explicitly closed/rejected unsigned request with an unused nonce is released
without a receipt. The service does not cancel or rebroadcast wallet transactions.

## Runtime and verification

`BUILDER_WALLET_ENABLED=true` enables RPC preflight/reconciliation.
`BUILDER_SIMULATION_ENABLED=true`, working Anvil tooling and a successful current
simulation are needed before registration. These flags were not enabled on
Railway for this PR. Apply migrations with workers off; retain unresolved wallet
and report journals when changing worker versions.

- `wallet-local.test.ts` executes actual transactions on an owned Anvil chain
  for all three curves and verifies receipts and recovery without a hash.
- RPC fixtures cover replacement/reorg/readback failures; PostgreSQL tests
  cover late-response races, owner isolation, unresolved requests and recovery
  after a revision change. These failure injections are synthetic.
- Playwright wallet mode drives the real UI/API/database/compiler, runs the
  actual simulation gate, then signs approve/ship/revoke/unrevoke/dock and zero
  allowances in a Sepolia fork. It tests successful and gated swaps, rejection,
  lost hash/response, reload and mobile UI.

The fork uses a public disposable Anvil EOA, synthetic funds and an impersonated
report forwarder. Local account-code overrides are disclosed. This is not
public Sepolia delivery, a live user wallet or DON/TEE evidence.

```sh
# Anvil and Playwright/Chromium must be installed.
# Set BUILDER_TEST_DATABASE_URL to a disposable localhost PostgreSQL service.
BUILDER_WALLET_LOCAL_TEST=1 pnpm test:builder-service
BUILDER_BROWSER_WALLET_FORK=1 bash packages/builder-service/test/browser/run-all.sh
```

`ANVIL` can specify the local binary path. Each fixture owns its database and
child chain. Public [fork evidence](builder-cre-verification/wallet-fork-browser.json)
and [remaining funded acceptance](BUILDER-REMAINING-PR.md) are tracked separately.
