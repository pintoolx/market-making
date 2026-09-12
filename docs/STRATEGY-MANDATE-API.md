# Frontend strategy mandate API

Status: active integration contract. This is PinTool's orchestration and status service, not an official Chainlink or 1inch endpoint. `NEXT_PUBLIC_MANDATE_API_URL` supplies its base URL.

The implementation lives in `orchestrator/`. It connects to Chainlink and Aqua through the runner protocol and verifies report and activity receipts through an independent Ethereum Sepolia RPC. Maker limits are encrypted in the browser. The service validates and forwards the sealed envelope, stores it separately from public mandate state and never receives plaintext. Update the runner, chain ID, RPC and Explorer settings together.

The frontend creates mandates and reads confirmed state and activity. Workflow and contract tooling drive market fixtures, CRE delivery and test-taker swaps; these are not exposed as product actions. The service must never present an expected outcome as confirmed evidence.

For the hackathon path, configure `MANDATE_RUNNER` with `orchestrator/bin/cre-local-simulation-runner`. Each create or add-strategy request invokes the confidential HTTP handler through `cre workflow simulate --broadcast`, waits for the matching `ReportAccepted` event on Ethereum Sepolia, verifies the receipt, and only then returns the public mandate state. This path requires CRE CLI authentication and a funded Sepolia signer, but it does not require a deployed workflow or Confidential Workflows deployment access.

Raw Provider policy and Maker limits must use a verified confidential input path. The current web application seals Maker limits for a Vault DON key before calling this API. When that transport is unavailable, the frontend rejects the request instead of sending plaintext to an ordinary backend.

## List executable strategies

`GET /v1/strategies`

Returns the public catalog entries that have both a provisioned Provider policy and an Aqua strategy hash for the configured network:

```json
{
  "maker": "0x...",
  "strategies": [
    {
      "id": "featured-tight-market",
      "name": "Tight Market",
      "provider": "PinTool Strategies",
      "strategyHash": "0x..."
    }
  ]
}
```

The `maker` is the wallet encoded into every returned Aqua strategy. The Maker application requires the connected wallet to match it before showing a listing as accepting liquidity. It also uses this catalog as the authority for whether a listing is currently executable. A listing may remain discoverable without appearing in this response, but it cannot create or join a mandate until its Provider policy and Maker-specific Aqua execution have been provisioned.

## Create a mandate

`POST /v1/mandates`

```json
{
  "maker": "0x...",
  "providerStrategyIds": [
    "featured-tight-market",
    "featured-defensive-market"
  ],
  "makerLimitsEnvelope": {
    "version": 1,
    "ephemeralPublicKey": "64 hexadecimal characters",
    "nonce": "48 hexadecimal characters",
    "ciphertext": "authenticated XChaCha20-Poly1305 ciphertext"
  }
}
```

`providerStrategyIds` must contain at least one entry; the product does not require exactly two. Initial onboarding submits the strategy chosen on its detail page. Makers may add compatible strategies later. The encrypted plaintext uses Maker limits schema v2: token1-denominated capital, WETH-value, per-swap and validity ceilings. The TEE converts value ceilings to WETH atomic units at the same market snapshot used for strategy evaluation.

The response must represent an initial report already accepted by the Guard:

```json
{
  "mandateId": "mandate-01",
  "regime": "normal",
  "strategies": [
    {
      "listingId": "featured-tight-market",
      "name": "Tight Market",
      "provider": "PinTool Strategies",
      "strategyHash": "0x...",
      "status": "active",
      "maxAmountPerSwapAtomic": "100000000"
    },
    {
      "listingId": "featured-defensive-market",
      "name": "Defensive Market",
      "provider": "PinTool Strategies",
      "strategyHash": "0x...",
      "status": "standby",
      "maxAmountPerSwapAtomic": "100000000"
    }
  ],
  "evidence": {
    "chainId": 11155111,
    "networkName": "Ethereum Sepolia",
    "reportDigest": "0x...",
    "reportTransactionHash": "0x...",
    "reportExplorerUrl": "https://sepolia.etherscan.io/tx/0x...",
    "sequence": "1",
    "expiresAt": "2026-09-12T00:00:00Z"
  },
  "events": []
}
```

## Read current state

`GET /v1/mandates/:mandateId`

Returns the same `MandateState`. When the CRE report, Guard state or Aqua receipt changes, the service rereads verifiable sources and updates:

- `regime`: `normal | high-volatility | unknown`
- each strategy's `status`: `active | standby | paused`
- `evidence.sequence`, expiry, digest and report transaction
- `events`: `report-accepted | strategy-activated | swap-settled | swap-rejected`

Each event contains `id`, `type`, `title`, `detail` and `occurredAt`. Events backed by an onchain transaction also include `transactionHash` and `explorerUrl`.

## Add a strategy

`POST /v1/mandates/:mandateId/strategies`

```json
{ "providerStrategyId": "featured-defensive-market" }
```

The service reevaluates the strategy set against the existing Maker policy and returns an updated `MandateState` only after the Guard accepts the new report. Adding a strategy does not move assets out of the Maker wallet, and at most one strategy may be `active` at a time.

## Record an Aqua execution

`POST /v1/mandates/:mandateId/executions`

```json
{
  "providerStrategyId": "featured-defensive-market",
  "transactionHash": "0x...",
  "outcome": "settled"
}
```

`outcome` is `settled` or `rejected`. The service fetches both the transaction and receipt
from Ethereum Sepolia, requires the configured Aqua Router as the target, decodes the swap
order, recomputes its strategy hash and checks it against the mandate. A settlement must
contain the matching `Swapped` event; a rejection must have a failed receipt and no such
event. Only this verified evidence is appended to the activity shown by the frontend.

## Required invariants

- A strategy set contains at least one strategy and at most one `active` strategy.
- Chain ID, network, token pair, strategy hash and Explorer URL come from the same deployment.
- Sequence increases monotonically. `expiresAt` corresponds to the report accepted by the Guard.
- Every transaction hash resolves to a receipt through an independent RPC.
- `swap-settled` requires a successful receipt. `swap-rejected` requires an actual reverted or failed receipt and cannot be inferred by the UI.
- The service never returns private policy, Provider thresholds, model chain of thought or secret sources to the frontend.
