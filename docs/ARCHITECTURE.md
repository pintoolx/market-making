# Architecture

PinTool Market Making connects private strategy policies to self-custodial liquidity on 1inch Aqua.

## Roles

- A **Strategy Provider** publishes a public listing and keeps its activation rules, market thresholds and sizing policy confidential.
- A **Maker** selects one strategy product, supplies liquidity from their own wallet and defines private capital, inventory, fill and validity limits.
- A strategy product may compile to several immutable Aqua execution profiles. The current Adaptive Market Maker uses tight, defensive and paused profiles; these are states of one Provider strategy, not separate marketplace purchases.
- The **confidential workflow** intersects both policies and the current market observation. It may narrow the Maker's limits but cannot expand them, then authorizes the compatible execution profile.
- **PinTool Guard** accepts the resulting short-lived public authorization and enforces it during every Aqua swap.

## Runtime flow

```text
Provider policy in Vault DON ─────┐
                                  ├─ Chainlink Confidential Workflow
Browser-sealed Maker limits ──────┘              │
                                             ▼
                                  GuardReportV1 + receipt
                                             │
Maker wallet ── Aqua execution profiles ── PinTool Guard ── SwapVM execution
```

The web application calls the PinTool mandate service. The service delegates confidential work to an isolated runner and independently verifies every transaction receipt before returning public state. It never creates placeholder transaction hashes or treats a planned action as confirmed.

The workflow supports scheduled evaluation and an authorized HTTP trigger. Evaluation and report publication are event-driven: initial activation, a material condition or policy change, explicit reevaluation, pause, or renewal near expiry. Reading status never invokes CRE and never publishes a report. HTTP trigger input is visible to Workflow DON nodes, so Maker limits are sealed in the browser with an ephemeral X25519 key and XChaCha20-Poly1305. Authenticated context binds the envelope to its Maker address, preventing reuse for another wallet. Provider-published policies can use the same transport with a separate Provider-address context; pre-provisioned policies remain Vault DON secrets. The trigger carries only public execution identity, market observations and ciphertext. After execution enters the TEE, the workflow fetches the envelope private key, opens the submitted envelopes and computes the intersection. The mandate service stores sealed inputs separately from public mandate state and never returns them to the web application.

## Components

| Component | Location | Responsibility |
|---|---|---|
| Web application | `frontend/` | Provider Studio, strategy marketplace, Maker mandate and confirmed activity |
| Mandate service | `orchestrator/` | API validation, confidential runner transport, public state and independent receipt verification |
| Confidential workflow | `workflow/market-maker-auth/` | Provider–Maker policy intersection and public Guard report generation |
| Report delivery | `workflow/guard-report/` | DON report encoding and Guard delivery verification |
| Aqua executor | `contracts/aqua-executor/` | Compile, ship, swap, rebalance, monitor, dock and recover Aqua strategies |
| PinTool Guard | `contracts/aqua-executor/contracts/` | Authenticate reports and enforce direction, amount, inventory and expiry bounds per swap |

## Privacy boundary

The confidential inputs are Provider rules and Maker limits. Strategy names, deployed programs, authorization bounds, transaction receipts and completed trades are public. Repeated public outputs may reveal information about confidential inputs over time. Short authorization lifetimes limit future use but do not erase history or provide a quantified resistance-to-inference guarantee.

The workflow source and compiled binary are public. Confidential Workflows protect the data processed in the TEE, not the source code itself. No plaintext private value may be logged, returned from the TEE or placed directly in an HTTP trigger payload.

## Execution invariants

- Assets remain in the Maker wallet and are made available to Aqua through virtual balances and token approvals.
- A report is bound to one chain, Guard, router, Maker, strategy hash and token pair.
- A Guard authorization expires, uses a strictly increasing nonce and cannot exceed the Maker-approved public envelope.
- A strategy product contains at least one Aqua execution profile. AquaGuardV2 maintains one active profile hash per Maker; accepting another active report atomically replaces it, while a paused report clears only that same profile if it is active.
- The service reports an accepted authorization or swap only after an independent RPC confirms its receipt and status.
- Risk limits constrain execution; they do not guarantee profit or a maximum loss.

## Deployment state

The checked-in Ethereum Sepolia deployment uses canonical WETH, Circle testnet USDC, Aqua and the pinned SwapVM router. The current Guard V2 `maker-active-v1` receiver is `0xfadc3165abeb127a0815d5ea4e2862ed430e1f70`. Public records verify two execution profiles sharing one Maker balance, successful guarded swaps, Maker-scoped atomic profile switching and rejection of an inactive profile. The separate [live acquisition run](../workflow/verification/live-market-guard/README.md) verifies CRE CLI reports, a CLMM trade and a mined direction rejection with public synthetic policies. These are local simulations with testnet delivery; real DON/TEE execution remains unverified.

A production Chainlink deployment also requires Confidential Workflows access, Vault DON secrets, an authorized HTTP trigger signing key and a Guard configured for the official forwarder and workflow identity. Network, contract and Explorer evidence must always resolve to the same chain.

For the executable Aqua lifecycle, current CLMM scope and evidence boundaries, see [Aqua flow and CLMM](AQUA-FLOW-AND-CLMM.md). A validated public market observation can now feed the existing policy evaluator through the [market adapter](../workflow/src/market-observation.ts); the main confidential handler now acquires observations itself in live mode and shares the validated report delivery adapter. The separate [local preview](../workflow/scripts/preview-market-observation.ts) still produces no delivery.
