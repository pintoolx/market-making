# Frontend strategy mandate API

Status: active integration contract. This is PinTool's orchestration and status service, not an official Chainlink or 1inch endpoint. `NEXT_PUBLIC_MANDATE_API_URL` supplies its base URL.

The implementation lives in `orchestrator/`. It connects to Chainlink and Aqua through the runner protocol and verifies report and activity receipts through an independent Ethereum Sepolia RPC. Maker limits are encrypted in the browser. The service validates and forwards the sealed envelope, stores it separately from public mandate state and never receives plaintext. Update the runner, chain ID, RPC and Explorer settings together.

The frontend creates mandates, explicitly requests strategy reevaluation and reads confirmed state and activity. Workflow and contract tooling drive live market acquisition, CRE delivery and test-taker swaps; these are not exposed as ordinary product actions. The service must never present an expected outcome as confirmed evidence.

For the hackathon path, configure `MANDATE_RUNNER` with `orchestrator/bin/cre-local-simulation-runner`. Each create or reevaluation request invokes the confidential HTTP handler through `cre workflow simulate --broadcast`. Changed authorizations wait for a matching `ReportAccepted` event on Ethereum Sepolia and verified receipt; unchanged standing authorizations reuse independently verified evidence. Only then does the service return public mandate state. This path requires CRE CLI authentication and a funded Sepolia signer, but it does not require a deployed workflow or Confidential Workflows deployment access.

Raw Provider policy and Maker limits must use a verified confidential input path. The current web application seals Maker limits for a Vault DON key before calling this API. When that transport is unavailable, the frontend rejects the request instead of sending plaintext to an ordinary backend.

## List executable strategies

`GET /v1/strategies`

Returns the public execution profiles that have both a provisioned Provider policy and an Aqua strategy hash for the configured network. The product UI may group several profiles under one marketplace strategy:

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
    "featured-tight-market"
  ],
  "makerLimitsEnvelope": {
    "version": 1,
    "ephemeralPublicKey": "64 hexadecimal characters",
    "nonce": "48 hexadecimal characters",
    "ciphertext": "authenticated XChaCha20-Poly1305 ciphertext"
  }
}
```

Initial onboarding submits the first provisioned execution profile of the strategy selected on its detail page. Tight and defensive profiles belong to the same Adaptive Market Maker product and inherit the same Maker mandate; the Maker does not purchase or configure them separately. The encrypted plaintext uses Maker limits schema v3: token1-denominated capital, WETH-value and per-swap ceilings, with explicit `authorization: "until-changed"`. Older schema-1/2 envelopes retain bounded lifetimes. The TEE converts value ceilings to WETH atomic units at the same market snapshot used for strategy evaluation.

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
    }
  ],
  "evidence": {
    "chainId": 11155111,
    "networkName": "Ethereum Sepolia",
    "reportDigest": "0x...",
    "reportTransactionHash": "0x...",
    "reportExplorerUrl": "https://sepolia.etherscan.io/tx/0x...",
    "sequence": "1",
    "expiresAt": null
  },
  "events": []
}
```

## Read current state

`GET /v1/mandates/:mandateId`

Returns the same `MandateState`. This is a read-only operation: it never invokes CRE and never broadcasts a Guard report. The service re-verifies stored transaction evidence and refreshes the short-lived Guard, Aqua and funding readiness snapshot:

- `regime`: `normal | high-volatility | unknown`
- each strategy's `status`: `active | standby | paused`
- `evidence.sequence`, expiry, digest and report transaction
- `events`: `report-accepted | authorization-unchanged | strategy-activated | swap-settled | swap-rejected`

Each event contains `id`, `type`, `title`, `detail` and `occurredAt`. Events backed by an onchain transaction also include `transactionHash` and `explorerUrl`.

## Reevaluate an execution profile

`POST /v1/mandates/:mandateId/strategies`

```json
{ "providerStrategyId": "featured-defensive-market" }
```

The route retains its original path for compatibility, but the product uses it to evaluate another pre-provisioned profile of the same marketplace strategy. The service reuses the existing encrypted Maker policy. Changed terms require a confirmed Guard update; unchanged standing terms reuse verified existing evidence and produce an `authorization-unchanged` event without broadcasting. An enabled report for a new profile atomically changes the active Guard hash; a non-matching profile remains paused and cannot trade. Reevaluation does not move assets out of the Maker wallet, and at most one profile may be `active` at a time.

Report publication is separate from state polling. Initial activation and explicit reevaluation compare the derived authorization with Guard state. Unchanged standing terms and active-profile selection produce no new transaction; changed terms, pause or reactivation require a report. Standing authorization has no periodic expiry renewal. Legacy bounded reports retain their expiry. Ordinary status reads remain transaction-free.

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

The wallet trading page normally stops when a quote is rejected. For an explicitly
reviewed enforcement check, a decoded `StrategyNotActive` error exposes a separate
submission form. It requires a positive minimum output, sufficient Taker balance
and another inactive-strategy preflight before asking the wallet to sign. If
allowance is insufficient, the user can separately approve exactly the input
amount; approval confirmation never submits the verification swap automatically.
The user pays Sepolia gas; authorization changing before mining can still
allow a trade at that minimum. The browser verifies the submitted calldata and
failed receipt and never treats a successful transaction as rejection evidence.
A failed receipt proves a revert, not its precise cause; the decoded preflight
error is separate evidence and is not a mined execution trace.

## Required invariants

- A strategy product contains at least one execution profile and at most one `active` profile for a Maker.
- Chain ID, network, token pair, strategy hash and Explorer URL come from the same deployment.
- `evidence.sequence` is the accepted report nonce, strictly increasing per `(maker, strategyHash)`, not a global mandate counter. Switching the evidence to another profile can display a lower nonce. `expiresAt` is `null` for standing reports and the accepted deadline for bounded reports.
- Every transaction hash resolves to a receipt through an independent RPC.
- `swap-settled` requires a successful receipt. `swap-rejected` requires an actual reverted or failed receipt and cannot be inferred by the UI.
- The service never returns private policy, Provider thresholds, model chain of thought or secret sources to the frontend.
