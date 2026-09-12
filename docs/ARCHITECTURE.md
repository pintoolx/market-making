# Architecture

PinTool Market Making connects private strategy policies to self-custodial liquidity on 1inch Aqua.

## Roles

- A **Strategy Provider** publishes a public listing and keeps its activation rules, market thresholds and sizing policy confidential.
- A **Maker** selects a strategy, supplies liquidity from their own wallet and defines private capital, inventory, fill and validity limits.
- The **confidential workflow** intersects both policies. It may narrow the Maker's limits but cannot expand them.
- **PinTool Guard** accepts the resulting short-lived public authorization and enforces it during every Aqua swap.

## Runtime flow

```text
Provider policy in Vault DON ─┐
                              ├─ Chainlink Confidential Workflow
Maker limits in Vault DON ────┘              │
                                             ▼
                                  GuardReportV1 + receipt
                                             │
Maker wallet ── Aqua strategy ── PinTool Guard ── SwapVM execution
```

The web application calls the PinTool mandate service. The service delegates confidential work to an isolated runner and independently verifies every transaction receipt before returning public state. It never creates placeholder transaction hashes or treats a planned action as confirmed.

The workflow supports scheduled reevaluation and an authorized HTTP trigger. HTTP trigger input is visible to Workflow DON nodes, so it contains only public execution identity and market observations. Provider policy and Maker limits remain Vault DON secrets fetched after execution enters the TEE.

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

The workflow source and compiled binary are public. Confidential Workflows protect the data processed in the TEE, not the source code itself. No private value may be logged, returned from the TEE or placed directly in an HTTP trigger payload.

## Execution invariants

- Assets remain in the Maker wallet and are made available to Aqua through virtual balances and token approvals.
- A report is bound to one chain, Guard, router, Maker, strategy hash and token pair.
- A Guard authorization expires, uses a strictly increasing nonce and cannot exceed the Maker-approved public envelope.
- A strategy set contains at least one strategy and at most one active strategy.
- The service reports an accepted authorization or swap only after an independent RPC confirms its receipt and status.
- Risk limits constrain execution; they do not guarantee profit or a maximum loss.

## Deployment state

The checked-in Base Sepolia deployment provides the currently verified Aqua, SwapVM and Guard transaction evidence. Ethereum Sepolia with WETH and Circle test USDC is the target deployment. Network migration must update the deployment manifest, workflow domain, runner, RPC, explorer and frontend-visible evidence together. Mixed-network evidence is rejected.

Production Chainlink deployment also requires Confidential Workflows access, Vault DON secrets, an authorized HTTP trigger signing key and a Guard configured for the official forwarder and workflow identity.
