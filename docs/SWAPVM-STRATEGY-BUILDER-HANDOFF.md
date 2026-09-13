# Builder integration guide

The Builder supports iterative strategy design, immutable Provider templates and Maker-owned instances. The product language is English. This guide identifies integration boundaries; it is not a deployment-completion report.

## Read first

1. [Builder requirements and acceptance](SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md)
2. [Event-driven authorization](SWAPVM-BUILDER-EVENT-TRIGGERS.md)
3. [AI integration](SWAPVM-BUILDER-AI-IMPLEMENTATION.md)
4. [Deployment and execution boundaries](SWAPVM-STRATEGY-BUILDER-DISCUSSION.md)
5. [Database infrastructure](BUILDER-DATABASE.md)
6. [LP releases](LP-RELEASES.md) and [Aqua/CLMM flow](AQUA-FLOW-AND-CLMM.md)

## Product contract

Provider design is a multi-turn conversation about public parameters, not a one-shot JSON generator or a fixed-template selector. Private rules belong in the encrypted policy editor, never in the model request, history or tool output. Makers pin immutable versions and adjust only permitted fields before reviewing their own allocations and transactions.

Use OpenAI with Vercel AI SDK, Railway PostgreSQL, the existing static Next frontend and authenticated service APIs. Runtime event evaluation is deterministic and does not call the design LLM. Keep the CRE Bun/WASM workspace separate from Node/browser compiler modules.

A fixed, verified Guard Extruction is required. Arbitrary external targets, hooks, opcodes, routers and AquaApps remain excluded. XYC, fixed-range CLMM and verified Pegged are the initial curves. Complete zero-fee lifecycles before enabling guarded fixed input fees; fee support still requires full accounting and composition evidence.

Event-driven automation requires explicit Maker consent, a persistent worker, trusted fresh inputs, change-only report delivery and receipt/readback verification. A manual evaluation button or browser polling alone does not satisfy that requirement. Automatic evaluation does not authorize asset signing, swaps, recentering or rebalancing.

## Identity and state

- Templates and versions belong to Providers; Maker instances contain allocations, limits and compiled hashes. A Provider update cannot retarget an existing Maker.
- Keep JSON `specHash` separate from `programHash`. For the selected Aqua profile, `orderHash = router.hash(order) = keccak256(abi.encode(order)) = strategyHash`.
- Guard V2 permits one active hash per Maker. Enabling B replaces A; previews and GET requests do not activate anything.
- Standing report schema 2 uses `validUntil = 0`. Legacy schema 1, program deadlines and confirmation expiry have separate semantics.
- The standing-v2 Guard target is `0x64f6e18e85dae5ec2ee44fe7f9fc66cf2a1f056f`. Verify the current manifest; changing a target changes program/order identity.
- Worker failure does not expire standing authorization. Display monitoring health separately. Direct revocation persists; removing it requires a fresh report to reactivate.
- Guard caps constrain per-swap atomic amounts and actual post-settlement Aqua inventory. They do not guarantee daily totals, minimum inventory, continuous percentage exposure or maximum losses.
- Ship does not deposit funds. Do not sum virtual balances as capital. Maker approves Aqua; the existing EOA taker path approves Router.
- Stopping a worker, revoking Guard authorization, docking and revoking allowance are different actions.

## Code map

| Responsibility | Source |
|---|---|
| Schemas, capabilities, validation | `packages/strategy-builder/src` |
| Persistence, agent, jobs and API | `packages/builder-service/src` |
| Compile, curves and Guard encoding | `contracts/aqua-executor/src` |
| Guard | `contracts/aqua-executor/contracts/AquaGuardV2.sol` |
| Existing registry, readiness and CRE runner | `orchestrator/src` |
| Policy intersection and report delivery | `workflow/src/intersect.ts`, `workflow/guard-report/delivery.ts` |
| Existing CLMM release schema | `shared/lp-release.mjs` |
| Builder UI | `frontend/src/app/builder` |
| Ethereum account integration | `frontend/src/app/providers/useAccount.ts` |

The legacy Solana ChatPanel is not the EVM design agent. Existing CLMM publication schemas do not replace Builder template/instance schemas. Extract pure prepare/read functionality rather than exposing executor signing contexts to the model.

## Verification boundaries

Use package manifests and lockfiles for dependency versions. The Aqua adapter uses saved ABI/viem; do not invent an installed Aqua SDK version. Historical readbacks and local tests retain their original deployment/profile scope. A simulation run is not production DON/TEE attestation, routing inclusion or a completed cloud rollout.

Preserve existing work and transaction journals. Do not read credentials into logs or require private keys in chat. Wallet signing is a separate user action. Current implementation and environment evidence determine completion; earlier planning documents and baseline test counts do not.
