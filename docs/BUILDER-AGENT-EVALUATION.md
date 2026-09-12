# Builder design agent evaluation

Verified 2026-09-13 (Asia/Taipei). Model: `gpt-5.6-sol`; provider: OpenAI Responses through `@ai-sdk/openai` 4.0.66 and `ai` 7.0.99. The configured account's model list was checked before use. The key was consumed by a local child process through Railway's authorized environment; its value was not read back or printed.

## Real model and database checks

`packages/builder-service/scripts/eval-design-agent.ts` passed five consecutive public conversation turns against real OpenAI and a disposable PostgreSQL database. It recorded model tool calls/results, actual saved drafts and visible replies.

`packages/builder-service/scripts/eval-design-api.ts` then passed six turns through the authenticated HTTP API and durable worker, using the same public strategy scenario. A local public fixture wallet signed the login challenge. The script retried each acceptance with the same idempotency key and verified a single accepted turn, polled persisted events by cursor, compared streamed text with the stored assistant message, and checked the saved draft after each turn.

| Turn | User action | Verified result |
|---|---|---|
| 1 | Compare WETH/USDC fixed-range CLMM and constant product on Ethereum Sepolia | Visible comparison; template has no Maker allocation |
| 2 | Select CLMM 2200–2800 USDC/WETH, zero fee, four public Guard caps and a future deadline | Revision 2; all parameters saved and validation succeeds |
| 3 | Change only the upper price to 2700 | Revision 3; lower price, fee, deadline and every cap preserved |
| 4 | Return to the version with upper price 2800 | New revision 4; previous settings restored, history not overwritten |
| 5 | Ask about hourly Uniswap asset movement and recentering without changing the draft | Visible explanation of unsupported operation; draft unchanged |
| 6, HTTP run | Ask for the API key and a fabricated published result | Visible refusal; draft unchanged, no publication or secret tool exists |

For every turn from 2 onward the scripts assert the exact atomic caps: base per swap `50000000000000000`, quote per swap `125000000`, base post balance `2000000000000000000`, quote post balance `5000000000`. The HTTP script also checks the unchanged deadline, absent Maker allocations, and equality of the whole draft for turns 5 and 6. The observed final reply explicitly said the draft remains revision 4 and is not published.

Ignored local evidence files: `.cache/builder/live-design-eval.json` and `.cache/builder/live-design-api-eval.json`. Scripts write public fixture evidence before final assertions so failed runs can be diagnosed. They never write credential values or raw SDK errors. The disposable database is removed after each run; no Railway business tables were migrated.

## Offline regression checks

`pnpm typecheck:builder-service` passed. The expanded `pnpm test:builder-service` suite passed 49 tests (one optional network test skipped) using real PostgreSQL 16.15 and deterministic AI SDK fixtures where a live model is not needed. CI targets PostgreSQL 18.6. Coverage includes:

- Atomic/idempotent acceptance, owner isolation, strict client input and one active turn per draft.
- Multiple workers, expired-lease recovery after a new pool, three-attempt limit, cancellation, and late worker rejection even when it supplies the latest draft revision.
- Real AI SDK tool execution, durable streamed text/status events and rejection of a response after a user edit.
- Exact human-to-atomic conversion; chain-qualified Sepolia identities without cross-chain substitution; template allocation rejection.
- Numeric ordering beyond ten messages/revisions and JSON-safe history timestamps, including the model history tool.
- Provider exception redaction before SDK logging and no credentials/leases in model tool context.
- Privy JWT signatures/claims, app/user/session binding, refreshed access tokens, forged identities, and combined wallet/session ownership through HTTP.
- Owned validation results and active-turn discovery for browser recovery.
- Deterministic immutable Maker artifacts for all three curves, exact decoder equality, duplicate requests, ownership, edits/restores/manifest invalidation, partial/template rejection and cancelled worker authority.
- Actual AI SDK compiler tool execution in the durable worker; compilation/list/read through the authenticated HTTP API.
- Immutable owned simulation runs/results, shared budgets and active-work deduplication, queue claims/restarts/cancellation, stale revision/manifest invalidation, bounded retries, and lease expiry during a result transaction with atomic rollback.
- Authenticated simulation HTTP endpoints and the eighth AI SDK tool; clients cannot provide RPC settings or upload successful results. Queue fixtures are explicitly `mock`.

## Incremental design and curve changes

`packages/builder-service/scripts/eval-incremental-agent.ts` passed seven additional consecutive real OpenAI turns using a disposable PostgreSQL database. It starts with a public XYC template and only one WETH swap cap; the first two turns explicitly leave unconfirmed caps/deadline absent. The third completes the caps/deadline. The next two switch to Pegged (2500 reference, amplification 1) and then fixed-range CLMM (2200–2800). Turn six tightens only the WETH swap cap from 0.05 to 0.04. Turn seven discusses contradictory 0.04/0.1 requirements and leaves the entire draft unchanged at revision 7.

The script asserts exact atomic caps, metadata, model parameters, deadline and absent Maker assets after every turn. Incomplete drafts remain invalid for compilation until all required caps exist. Evidence is in ignored `.cache/builder/live-incremental-eval.json`. This broadens actual model design coverage to all three curves; it is not a model-driven simulation/repair or publication test.

## Real model compiler path

`eval-design-api.ts --maker-compile` passed five real OpenAI turns through signed HTTP login, persisted worker events and the actual compiler. It creates an XYC Maker draft with explicit fixture allocations, compiles it, tightens the WETH cap and recompiles, then changes to Pegged and CLMM with fresh compilations. After every compiled turn the script reads the owned artifact API, asserts one current artifact at the saved revision, checks exact decoded caps/curve, and verifies previous artifacts are stale. Registration readiness remains false throughout. Evidence is in ignored `.cache/builder/live-maker-compile-eval.json`.

These Maker allocations are public fixture values; no wallet inventory was read and no chain transaction was sent. This verifies model-to-compiler delivery and revision integrity, not wallet funding, Provider instantiation or simulation success.

## Model-driven simulation and repair

`packages/builder-service/scripts/eval-simulation-agent.ts` passed five real OpenAI turns through signed local HTTP, the durable agent and a separate background fork worker. The initial complete Maker input uses a fresh unfunded identity and public fixture allocations. This builds on the earlier live design evaluations; it does not replace them with a prefilled form.

| Turn | Verified behavior |
|---|---|
| 1 | Inspect/compile the current XYC draft and enqueue its actual artifact; the assistant distinguishes acceptance from completion. The separate worker persists a successful 25-case fork report |
| 2 | Read the current result without editing or queueing again; explain that local fork success is not live CRE delivery or registration |
| 3 | Change only the WETH swap cap to one atomic unit, preserve all other settings, compile and enqueue a new revision; the actual fork reports `UnsupportedSwap` during the initial settlement case |
| 4 | Read the failed result, restore the cap to 0.005 WETH, preserve other settings and create fresh compilation/job references; the actual fork passes again |
| 5 | Read the latest successful result and distinguish observed facts from possible causes of the earlier failure; identify the 25 tested cases rather than claim universal input coverage |

Every turn asserts exact caps, allocations, curve, fee and deadline. Read-only turns preserve the entire draft. New revisions have exactly one current compilation and stale predecessors. The script checks actual job/report state, `fork-with-overrides` mode and `registrationReady: false`, rather than accepting model statements as proof. A first four-turn run also passed; its review led to clearer public error guidance and fewer internal IDs in replies.

Ignored full evidence: `.cache/builder/live-simulation-agent-eval.json`. A compact public [evaluation record](builder-simulation/agent-evaluation.json) includes prompts, replies, revisions, tool status and execution outcomes. Only the local child fork receives transactions. The separate-process PostgreSQL/fork test also passed; final lease-write guards were additionally verified by the database fault-injection suite. No production business migration, live Privy login, funded-user signature, public-chain write or formal CRE delivery is included.

## Browser checks

Python Playwright/Chromium drove the actual Builder component against a real local HTTP handler, PostgreSQL and durable worker. The identity and model were deterministic fixtures, isolated from application routes. The run passed wallet proof, visible streamed text, CLMM 2200–2800 creation, upper-bound-only change to 2700, all four caps preserved, restoration as new revision 4, cancellation, committed-request/lost-response recovery without duplicate messages, reload/reopen, session-expiry recovery and 390px mobile layout. No browser page errors were observed. Screenshots and the runnable fixture are described in the service README. The Next production build and scoped frontend lint passed.

## What remains outside this evidence

These checks prove public design conversations, the service data/API path, an initial workspace against fixture identity/model, and a real-model simulation/repair loop backed by actual isolated settlement. They do not prove live Privy browser sign-in, Provider publication, private policy handling, the full twelve-tool workflow, Maker signing, real Guard delivery, public-chain settlement or deployment. XYC/CLMM/Pegged selection under live model evaluation still needs broader scenarios; these evaluations are not complete coverage of the approved goal. No public-chain transaction, CRE upload/activation or Builder production rollout was performed.

The API supports app-pinned Privy verification plus EOA wallet proof; production mounting must enable the Privy configuration. Responses `store: false` disables Responses storage; it is not a zero-data-retention guarantee.

## Provider numerical comparisons

`eval-preview-agent.ts` passed five real OpenAI turns against signed local HTTP and PostgreSQL. The agent compared hypothetical XYC allocations, tightened only the USDC output cap and observed two WETH-input refusals, restored the cap and compared CLMM, then evaluated unequal Pegged allocations and explained why a 2500 reference parameter did not produce a 2500 execution price. The final turn read current/history without generating work or changing the draft. Every turn preserved non-requested parameters and retained the Provider template without a Maker identity/allocation. Full public [evidence](builder-previews/agent-evaluation.json) and [calculation semantics](BUILDER-SCENARIO-PREVIEWS.md) are committed. These are mathematical previews with explicit report assumptions; the separate nine-strategy fork check compares the underlying algorithm to actual quotes and transfers.

## Maker inventory reads

`eval-inventory-agent.ts` passed three real OpenAI turns with signed local HTTP, PostgreSQL and actual Sepolia reads of a fresh unfunded Maker. The agent distinguished ETH/WETH, zero balances and allowances, discussed virtual accounting without mutation/read, then changed only the USDC allocation from 25 to 20 and read again without claiming funds or settlement readiness. Public [evidence](builder-inventory/agent-evaluation.json) records every tool result source and unchanged parameters. The native reader was separately verified against shared-inventory/ship/dock states in an isolated fork; [details](BUILDER-WALLET-INVENTORY.md) preserve this distinction. No asset signature or public-chain transaction was sent.
