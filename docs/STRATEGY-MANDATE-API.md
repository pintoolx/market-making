# Frontend strategy mandate API

Status: active integration contract. This is PinTool's orchestration and status service, not an official Chainlink or 1inch endpoint. `NEXT_PUBLIC_MANDATE_API_URL` supplies its base URL.

The implementation lives in `orchestrator/`. Its current defaults verify the existing Base Sepolia contract flow. It connects to the Chainlink and Aqua execution side through the stdin runner protocol and verifies report and activity receipts through an independent RPC. Maker policy is forwarded only to the confidential runner; it is never written to service state or ordinary logs. When the Ethereum Sepolia deployment is ready, the HTTP contract remains unchanged. Update the runner, chain ID, RPC and explorer settings together.

The frontend creates mandates and reads confirmed state and activity. Workflow and contract tooling drive market fixtures, CRE delivery and test-taker swaps; these are not exposed as product actions. The service must never present an expected outcome as confirmed evidence.

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

`providerStrategyIds` must contain at least one entry; the product does not require exactly two. Initial onboarding submits the strategy chosen on its detail page. Makers may add compatible strategies later. The filmed ETHOnline flow uses the two fixtures above to demonstrate an authorization switch.

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

## Required invariants

- A strategy set contains at least one strategy and at most one `active` strategy.
- Chain ID, network, token pair, strategy hash and Explorer URL come from the same deployment.
- Sequence increases monotonically. `expiresAt` corresponds to the report accepted by the Guard.
- Every transaction hash resolves to a receipt through an independent RPC.
- `swap-settled` requires a successful receipt. `swap-rejected` requires an actual reverted or failed receipt and cannot be inferred by the UI.
- The service never returns private policy, Provider thresholds, model chain of thought or secret sources to the frontend.
