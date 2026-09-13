# Builder requirements and acceptance

The Builder helps users develop an executable market-making strategy through iterative discussion, capability discovery, revision, preview and simulation. It supports immutable Provider publication and Maker-controlled instantiation. English is the product and repository language.

This is the delivery contract, not a completion report. Each capability needs implementation and evidence tied to the final commit and deployment profile. Earlier baseline test counts, plans and fixtures do not establish cloud deployment, live model integration or production TEE attestation.

## Product outcome

```text
Describe objectives, constraints and preferences
  -> identify known requirements and unresolved questions
  -> discover compatible SwapVM / Guard capabilities
  -> propose concrete alternatives and explain tradeoffs
  -> edit the existing draft and show a revision diff
  -> validate, preview and simulate
  -> refine against feedback and confirmed requirements
  -> publish an immutable template or review a Maker transaction plan
```

A fixed-template selector or one-shot JSON generator does not meet this requirement. Templates are publication and reuse formats. A user may design a template and also instantiate it as a Maker.

| Role | Required experience |
|---|---|
| Designer | Start from a desired strategy, compare mechanisms, revise constraints, restore earlier versions and resume conversations |
| Provider | Publish signed immutable versions, configure private policy in a separate encrypted editor and withdraw versions |
| Maker | Pin a Provider version, adjust permitted fields and allocations, preview/simulate, review wallet plans and explicitly activate event management |
| Active Maker | Receive event-driven evaluation while the browser is closed; unchanged effective authorization produces no new report |
| Maker managing risk | Inspect registration, authorization, funds, input freshness, monitoring health and delivery state; directly revoke, reactivate after a fresh report, dock or separately revoke allowance |
| Operator | Reproduce builds and tests, apply migrations, recover persistent work and inspect public operational evidence without leaking private policy |

## Architecture and scope

Use TypeScript, the existing static Next/Cloudflare frontend, authenticated Node services, Railway PostgreSQL, OpenAI API and Vercel AI SDK. Use one constrained design agent, not a multi-agent trading framework. Keep CRE's Bun/WASM toolchain separate. Pin and verify installed SDK, Node, React, compiler, ABI and deployment versions rather than treating historical research versions as current facts.

The target is Ethereum Sepolia with verified WETH/USDC, Aqua, router and standing Guard. A fixed, verified Guard Extruction is required. Excluded: arbitrary external targets, custom AquaApps/routers/opcodes/hooks, protocol or dynamic fees, unverified special-token behavior, exact-out under the current Guard profile, resolver development or guaranteed aggregator inclusion, auto-rebalance/recenter/DCA, cross-protocol asset operations and backend custody.

XYC, fixed-range CLMM and verified Pegged are required starting curves. Complete zero-fee lifecycles before guarded fixed LP input fees. Fixed input fees remain a required later deliverable: they must not be silently dropped or enabled with unverified accounting. Decay, native access/direction modifiers and optional deadline omission require source, encoding and composition verification before exposure.

## Iterative design requirements

Persist `StrategyIntent` and a requirement list independently of chat history. Each requirement has a stable ID, source turn, confirmation status, priority or hard-constraint flag, mapped mechanism, actual enforcement scope, validation outcome and an unmet reason where relevant. Editing one setting must preserve unrelated constraints.

Discover capabilities from the registry, including compatible curves, fixed input fees, deadlines, verified modifiers, Guard directions and caps, conditional private policy evaluation, event updates and revocation. Do not substitute a prompt containing three curve names for capability discovery. Distinguish CRE's price decisions from Guard's onchain checks.

Offer concrete alternatives when range width, inventory, fill limits or update latency creates a meaningful tradeoff. Retain candidate revisions and previews. Ask only about missing or contradictory inputs. Support requests such as changing one field, becoming more conservative, restoring an earlier revision or comparing a different curve. Convert vague preferences into reviewable changes; never infer a profit or safety guarantee.

Every turn uses current domain state to show differences, requirement coverage and next actions. Validation/simulation failures should lead to a reasoned correction in the same conversation. A Maker cannot exceed a pinned Provider version's permissions; offer a separate owned strategy when necessary without silently removing restrictions. Registered strategy edits create a new draft and appropriate lifecycle operations.

Finalization requires confirmed requirements to be satisfied, explicitly unsupported or replaced by a user-accepted alternative. Conversational agreement is separate from signing a concrete transaction.

## Capability evidence

For every candidate instruction, trait, recipe, Guard feature and evaluator condition, record `sourceImplemented`, `sdkEncodable`, `runtimeVerified`, `compositionTested`, `productEnabled` and `routingCompatible`. Include schema, units, constraints, preconditions, side effects, source and compatible recipes. Do not collapse these layers into a single supported flag.

If an approved capability exists on the target deployment and is compatible with Guard but lacks Builder wiring, add the adapter/schema/UI and tests. If it is unavailable, semantically incompatible, unsafe or outside scope, record why and offer a feasible alternative. Unknown opcodes, reserved gaps, arbitrary jumps or targets and Guard-bypass paths must be rejected.

Private rule shape, ordering, thresholds and decrypted traces stay out of OpenAI requests, history, tool outputs and public streams. The encrypted browser editor owns private policy. The model receives only necessary completion state; policy preview and error handling must also respect this boundary.

## Delivery sequence

| Stage | Deliverable | Required evidence |
|---|---|---|
| 0 | Deployment profiles, full capability inventory, intent/requirements and compatible toolchain | Fixed-block bindings/code evidence; discoverable capabilities and explicit blocked reasons |
| 1 | PostgreSQL migrations/store, authentication, wallet ownership, revisions, idempotency and jobs | Real persistence/restart, cross-owner rejection, concurrency and migration tests without overwriting existing data |
| 2 | XYC schema, standing Guard recipe, validator/compiler/independent decoder, preview and isolated lifecycle simulation | Reproducible bytes; actual upstream router/Guard success and rejection in both directions |
| 3 | Multi-turn OpenAI agent, twelve bounded tools, streaming, revisions/diffs, private editor and publication | Real model evaluations of revisions, error recovery, alternatives and requirement coverage; private-data exclusion |
| 4 | Fixed-range CLMM and verified Pegged with recipes, decoding, preview, simulation and template UI | Decimal/order reversal, snapshot, asymmetric inventory, boundary and bidirectional tests |
| 5 | Maker instances, limited approve/ship/dock/revoke plans, wallet review, receipts and trusted onboarding | A new valid hash obtains authorization without manual catalog edits; wrong owner/version/hash/signature and withdrawal rejected |
| 6 | Persistent event subscriptions, outbox, jobs, market/log adapters, health handling and change-only CRE delivery | No unchanged report; browser closure, restart, multi-worker, reorg, missed-event, switch and late-receipt recovery |
| 7 | End-to-end zero-fee Provider/Maker/event/Guard/settlement lifecycle on the existing application | Browser evidence; new Sepolia report, successful trade, rejected trade and rejection after stopping/revoking/docking as applicable |
| 8 | Guarded fixed LP input fees and verified modifiers | Gross/net/inventory accounting, bidirectional boundary/sequence tests and no cap bypass; reviewed migration if a new Guard is needed |
| 9 | Integration fixes, CI, deployment/recovery documentation and final review | Evidence matches the final commit/profile; rollout health verified; unresolved work remains explicit |

Stages 2 and 3 form the first XYC vertical slice. Stage 7 is the first zero-fee release, not completion of the full delivery contract. Split commits and PRs into reviewable functional changes without reducing required scope.

## Data, identity and permissions

Keep distinct `StrategyDraft`, `ValidatedStrategy`, `CompiledStrategy`, `SimulationReport` and `TransactionPlan` models. Add intent/requirements, candidate revisions, Provider templates/versions, Maker instances, authorization bindings, automation consent and event/delivery state.

PostgreSQL stores public messages, revisions, immutable versions, instances, artifacts, jobs, plans/confirmations, bindings, consent, event inbox/outbox/subscriptions, deliveries and chain cursors. Use namespaces, constraints, indexes, transactions, pools and versioned migrations. Test upgrades and rollback compatibility without destructive data resets. Plaintext private policy must not be stored in ordinary columns or logs; protected ciphertext/commitments use separate authorized paths.

Authorization bindings include signed Provider version, Maker consent, spec/recipe/profile digests, program/order hashes, chain/router/Guard, policy and limit commitments, revision and generation. Verify signatures, recompile and decode server-side. Supporting new hashes does not authorize arbitrary submitted hashes or removal of workflow binding checks. Each simulation job has an isolated approved config snapshot; production gateway delivery verifies its own trusted source.

The twelve tools are `getCapabilities`, `resolveTokens`, `getWalletInventory`, `createOrPatchDraft`, `validateStrategy`, `compileStrategy`, `previewScenarios`, `simulateLifecycle`, `prepareRegistration`, `inspectStrategy`, `prepareCancellation` and `exportStrategy`. They propose or prepare; they do not expose unrestricted signing, approval, Solidity execution or calldata broadcast. Recheck owner, revision, stage and profile on every operation. Reject client-supplied system/tool histories and ownership claims.

Provider design must not demand nonexistent Maker assets. Maker instantiation fixes wallet, allocation and any relative-price snapshot. Classify requirements as `onchain_enforced`, `preflight_only`, `informational` or `unsupported` through deterministic validation, never model assertion.

Material revisions invalidate old artifacts, simulations and unsent confirmations. Track broadcast transactions independently until reconciliation. ENS display names must not replace pinned identity. Frontend navigation and authentication must remain compatible with the rest of the application.

## Event and recovery acceptance

An always-running worker receives events and invokes CRE through a verified delivery adapter. Native CRE log workflows are optional; the first implementation can use HTTP-triggered evaluation. Runtime evaluation does not call the design LLM.

| Scenario | Required result |
|---|---|
| Activation, explicit switch or limit change | Check binding and consent; program changes return to compile/wallet review |
| Public data update | Fetch trusted fresh data; event payload is not a price/report authority |
| Token/Aqua/Guard logs | Filter by Maker/strategy, persist block/hash/log index, deduplicate, backfill and handle reorgs |
| Unchanged terms | No onchain write; retain accepted identity and update evaluation metadata |
| Changed terms | Compare complete effective fields and active hash; confirm receipt and readback before showing effective state |
| Idle | No periodic renewal; data/health polling and reconciliation timers are allowed |
| Provider withdrawal | Stop new applications; pause existing instances only under consented terms, with actual delivery tracked |
| New Provider version | Existing Maker remains pinned; no silent hash switch or relaxed limits |
| Source outage | Show degraded monitoring; attempt consented pause without pretending old standing authority expired |
| Recovery | Reevaluate only a still-consented, selected, non-revoked, non-docked instance |
| Maker stop/revoke/dock | Distinguish actions; invalidate unsent jobs, reconcile broadcast jobs; direct revoke does not depend on worker |
| Switch or delayed work | Serialize per Maker and recheck generation; paused B must not be presented as paused A |
| Multiple workers, timeout or restart | Persist leases, request/report IDs and pending transactions; reconcile before retrying; separately coordinate broadcaster nonce |
| Own report event | Reconcile without an endless evaluation loop or duplicate side effect |

Standing reports remain valid offline until their actual caps, deadline or revocation prevent execution. A heartbeat cannot guarantee delivery during an outage. Atomic caps derived from USD or percentage policies use the evaluation price, not a fresh Guard oracle per trade. Price changes can change caps without changing regime; do not ignore tightening changes to save gas.

## Compiler, simulation and wallet acceptance

Use bigint or verified exact arithmetic for raw amounts, square-root prices, reciprocals, token ordering and fee encoding; serialize large integers as decimal strings. Test 6/18 decimals, reciprocal-bound swapping, rounding and extreme amounts. No hidden wrapping, asset swaps or 50/50 inventory assumptions.

Separate application spec, program and order identity. For the selected Aqua profile, `orderHash = router.hash(order) = keccak256(abi.encode(order)) = strategyHash`. Same spec/manifest/recipe/salt produces the same bytes. Decode independently and reject unknown instructions, lengths, traits, hooks, unverified branches, backward jumps, duplicate fees or paths around the fixed Guard gate.

Distinguish mathematical previews, fixed-context quotes and full settlement simulations. Preserve `mock / local-upstream / fork-with-overrides / fork-real-context / live-read` evidence levels. Isolated simulation workers must never write to a public RPC. Compare quote/swap using the same initial state, timestamp and caller.

Test all three curves in both exact-in directions, sequential fills, low inventory, actual transfer paths, range/deadline boundaries and unchanged balances after reverts. Unsupported exact-out must reject. Verify standing reports beyond the old 600-second bound and after one hour, while caps still apply; retain legacy expiry tests. Include revoke/unrevoke, active-hash changes, absent/wrong-domain/wrong-pair reports and cap failures.

Generate transaction review from decoded payloads: chain, Maker, target, selector, parameters, digest, value, spender, limited allowance, estimated gas and prerequisites. Recheck revision/profile and state before signing. Maker approves Aqua; the existing EOA taker approves Router. Handle rejection, wrong chain, revert, timeout, replacement, retries and failed readback without false success.

Show wallet balance, allowance, virtual balances and known commitments separately. Ship is not a deposit; shared inventory is not additive or globally reserved. Registration, accepted report, quote, settlement and routing inclusion are independent states. Worker stop, Guard revoke, dock and allowance revoke are different operations.

## Fees and deployment boundaries

Before enabling fixed LP input fees, specify gross input, net pricing input, actual Aqua credits/debits, Maker revenue and both per-swap/post-inventory caps. Verify each enabled curve/fee recipe in both directions, at boundaries and across sequential trades. Unguarded fee tests are insufficient.

If the current Guard cannot enforce the accounting, complete a candidate contract, ABI/profile/compiler/decoder changes and local/fork tests first. A new public deployment and old-hash migration need a concrete reviewable payload/address/cost plan. Until verified, fees stay disabled and that deliverable stays incomplete.

Verify actual deadline semantics before offering no-deadline recipes. Standing `validUntil = 0` does not give the deadline opcode that meaning. Enable Decay/access modifiers only with pinned-source and composition evidence; otherwise retain an explicit blocked reason.

Deployable artifacts must include builds, migrations, environment templates, health/readiness, feature controls and rollback instructions for Cloudflare, Railway API/workers and PostgreSQL. Simulation and event workers may be separate processes. A browser-only or request-scoped loop does not meet persistent automation requirements. Do not change existing Maker positions as part of rollout.

Public Sepolia acceptance covers new templates/instances, report acceptance, unchanged/no-write, changed terms, successful/rejected fills and rejection after revoke/dock for all required curves. Event evidence includes browser closure and restart recovery. Local injected-event/time tests supplement, not replace, target-environment evidence.

Real model credentials and quota, cloud access and testnet funds are external dependencies. Missing access leaves those acceptance items incomplete while independent work continues. Keep secrets server-side and out of chat. Wallet signing belongs to the user. Simulation-profile delivery does not require production CRE enrollment, but it must never be presented as real DON/TEE attestation; formal workflow deployment is a separate authorization scope.

## Completion criteria

1. Multi-turn design produces a user-confirmed executable strategy with traceable requirements, revisions and results.
2. Provider/Maker flows, all three curves, fixed LP fees, registration/cancellation, trusted new-hash onboarding and event services have implementation and acceptance evidence.
3. Real model requests, PostgreSQL persistence, browser flow, environment health and Sepolia lifecycles are verified; unsupported capabilities remain explicit.
4. Change-only reports, per-Maker ordering, standing outage behavior, direct revocation and recovery pass, with unresolved transactions still tracked.
5. Relevant build, type, unit, integration, browser and CI checks pass against the final version; review defects are resolved.
6. Documentation, deployment/recovery guidance and evidence are committed, reviewed and merged; required rollout is verified.

An external blocker or a merged early-stage PR does not complete the whole scope. Only an explicit scope decision changes these requirements.
