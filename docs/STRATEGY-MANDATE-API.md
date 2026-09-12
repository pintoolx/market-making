# Frontend strategy mandate API

Status: active integration contract. This is PinTool's orchestration and status service, not an official Chainlink or 1inch endpoint. `NEXT_PUBLIC_MANDATE_API_URL` supplies its base URL.

The implementation lives in `orchestrator/`. It connects to Chainlink and Aqua through the runner protocol and verifies report and activity receipts through an independent Ethereum Sepolia RPC. Maker policy is forwarded only to the confidential runner; it is never written to service state or ordinary logs. Update the runner, chain ID, RPC and Explorer settings together.

The frontend creates mandates and reads confirmed state and activity. Workflow and contract tooling drive market fixtures, CRE delivery and test-taker swaps; these are not exposed as product actions. The service must never present an expected outcome as confirmed evidence.

For the hackathon path, configure `MANDATE_RUNNER` with `orchestrator/bin/cre-local-simulation-runner`. Each create or add-strategy request invokes the confidential HTTP handler through `cre workflow simulate --broadcast`, waits for the matching `ReportAccepted` event on Ethereum Sepolia, verifies the receipt, and only then returns the public mandate state. This path requires CRE CLI authentication and a funded Sepolia signer, but it does not require a deployed workflow or Confidential Workflows deployment access.

Raw Provider policy and Maker limits must use a verified confidential input path. When that transport is unavailable, the service must reject the request and must not leave plaintext in ordinary backend logs.

## Create a mandate

`POST /v1/mandates`

```json
{
  "maker": "0x...",
  "providerStrategyIds": [
    "featured-tight-market",
    "featured-defensive-market"
  ],
  "policy": {
    "capitalBudgetUsdc": "1000",
    "maxWethExposurePct": "60",
    "maxWethInventoryUsdc": "350",
    "maxSwapUsdc": "100",
    "validityMinutes": "10"
  }
}
```

`providerStrategyIds` must contain at least one entry; the product does not require exactly two. Initial onboarding submits the strategy chosen on its detail page. Makers may add compatible strategies later.

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
