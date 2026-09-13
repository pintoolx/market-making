# Builder design service

Node 24+, PostgreSQL 16+ (Railway and CI target 18.6). This package exports an authenticated HTTP handler, durable repositories and an OpenAI/Vercel AI SDK design worker. It is not yet mounted in the deployed orchestrator. No Railway business migration or Builder application rollout has been performed by this batch.

## Verification and migration

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck:builder-service
# Configure BUILDER_TEST_DATABASE_URL for a disposable PostgreSQL server, then:
pnpm test:builder-service
# Deployment operator configures DATABASE_URL privately, then:
pnpm --filter @pintool/builder-service migrate
# After configuring DATABASE_URL and OPENAI_API_KEY privately:
node packages/builder-service/scripts/design-worker.ts
```

The integration test requires CREATE DATABASE permission. It creates a unique `pintool_builder_test_*` database and removes only that database afterward. It does not silently skip when PostgreSQL is unavailable. Tests exercise migrations, concurrent writers and retries, owner isolation, restoring revisions, a fresh pool reading persisted records, job lease recovery, actual wallet signatures and HTTP requests. Local verification used PostgreSQL 16 from the distribution packages; CI uses the pinned official 18.6 image. None of these tests use public-chain writes or user credentials.

Migrations use the dedicated `builder` schema, an advisory transaction lock and recorded checksums. Applied SQL files must not be edited. Add new numbered migrations for subsequent changes. An application rollback leaves the additive schema and history intact; it never runs a destructive down migration. Take a database backup before production schema upgrades, and validate compatibility against the rollback application version. Legacy JSON mandate state and Provider registries are untouched.

## Ownership and transaction boundaries

The API derives `owner = wallet:<verified lowercase address>` from a server session. Existing Privy-connected EOA wallets can sign the generated ERC-4361 challenge without assets. Challenges expire after five minutes and are consumed atomically once. The signed session duration is at most 24 hours. Message text, domain, chain and address come from the server; sessions are bound to the configured origin and chain. Database rows store token hashes, and logout revokes the session. Smart-contract wallet signatures are not supported by this initial EOA adapter.

Production mounting must set `privyAppId` to the frontend's existing Privy app. The handler verifies `X-Privy-Access-Token` against that app's public JWKS using ES256, issuer `privy.io`, the app audience, required user/session/issued/expiry claims and a two-hour maximum token age. Identity tokens are rejected. Both the challenge and Builder session are bound to this Privy app, user and login session; a fresh token for the same session works, a different session does not. The wallet still signs its own challenge. No Privy app secret is required. Without this configuration the EOA-only adapter remains available for local scripts; it is not the production Builder authentication configuration.

Clients must keep both tokens out of URLs, logs and model input. Mount this handler with the same explicit HTTPS frontend origin used by the application's wallet UI. Browser requests send `Authorization`, `X-Privy-Access-Token` and `Idempotency-Key` headers. CORS is not authentication. The handler rejects client-supplied owners, message roles/tool history and unsupported fields. New Maker drafts use the session wallet and cannot be retargeted to an unverified address.

Every owner-facing repository query filters by owner. Composite foreign keys prevent attaching another owner's child records. These repositories are server-internal and do not expose SQL or a direct client database connection. This batch uses application authorization and constraints, not per-user PostgreSQL RLS. Use dedicated application database credentials in deployment; migration/operator credentials and worker internals must not be exposed through the API or model tools.

Draft mutations acquire one connection and a transaction, lock the expected draft revision, record an immutable revision and its outbox event, and commit the idempotent response together. A duplicate request returns the same JSON; reuse with different input is rejected. A failed mutation rolls back its request key, so a corrected retry can proceed. Restoring history creates a new revision. Pending obsolete simulation jobs are cancelled; running work must reconcile before any result is accepted as a current artifact.

The generic preparation queue uses `FOR UPDATE SKIP LOCKED`, expiring leases and lease tokens. A worker that lost its lease cannot renew or complete the job. Queue payloads/results contain public references and error codes, not arbitrary private inputs. Event delivery uses a separate revision/generation-bound inbox, evaluation lease, per-Maker/strategy nonce sequence, change-only delivery record, receipt reconciliation seam and resident worker. It never signs Maker asset transactions; a delivery adapter must verify the Guard receipt/readback before marking a report accepted.

## Initial endpoints

All paths are relative to `/v1/builder`. All mutation bodies are strict JSON. Draft/message mutations require an idempotency key; auth endpoints do not.

| Method and path | Body / behavior |
|---|---|
| POST `/auth/challenge` | `{ address }`; server returns exact SIWE message |
| POST `/auth/login` | `{ challengeId, signature }`; returns session token and actor |
| GET `/auth/session` | Current authenticated actor |
| POST `/auth/logout` | Revokes this session |
| GET `/capabilities` | Current domain capability evidence, not a deployment-readiness claim |
| POST `/conversations` | `{ title, kind: "template" \| "maker" }`; creates conversation and draft |
| GET `/conversations` | Latest 100 owned conversations, including active turn ID/state for recovery |
| GET `/drafts/:id` | Owned draft |
| GET `/drafts/:id/history` | Latest 100 immutable revision summaries |
| GET `/drafts/:id/validation` | Authoritative validation and requirement assessment for the current revision and pinned profile |
| POST `/drafts/:id/compile` | `{ expectedRevision }`; owned Maker instance only; stores decoded compilation and returns its reference |
| GET `/drafts/:id/artifacts` | Owned immutable compilation references, newest revision first |
| GET `/artifacts/:id` | Compiled bytes/decoded public parameters, current/stale flag and explicit `registrationReady: false` |
| POST `/artifacts/:id/simulations` | `{ expectedRevision }`; returns 202 with an owned background job reference; requires server `simulationEnabled: true` |
| GET `/drafts/:id/simulations` | Latest 20 owned job summaries, current/stale flag, evidence mode and failed/skipped cases |
| GET `/simulations/:id` | Owned durable job state and immutable completed evidence; readiness remains false |
| POST `/simulations/:id/cancel` | `{}` plus idempotency key; cancels pending/running authority and rejects late results |
| POST `/drafts/:id/requirement-review` | `{ expectedRevision }`; prepares an immutable public requirement interpretation |
| GET `/drafts/:id/requirement-review?revision=N` | Current user-confirmed requirement receipt, if one exists |
| POST `/requirement-reviews/:id/confirm` | `{ digest, decisions }`; explicit per-requirement confirmation or limitation acceptance |
| POST `/drafts/:id/registration-plan` | `{ expectedRevision, artifactId }`; immutable unsigned ERC20 approve + Aqua ship plan |
| POST `/drafts/:id/cancellation-plan` | `{ expectedRevision, artifactId }`; immutable unsigned Aqua dock plan |
| POST `/drafts/:id/automation-consent` | `{ expectedRevision, artifactId }`; prepares an explicit Maker standing-delivery consent message |
| GET `/drafts/:id/automation-consent?revision=N` | Current active signed automation consent |
| POST `/automation-consents/:id/confirm` | `{ digest, signature }`; verifies the Maker signature and enables no asset transaction |
| POST `/automation-consents/:id/revoke` | `{ signature }`; permanently revokes the signed delivery consent and stops its event subscription |
| POST `/drafts/:id/event-subscription` | `{ expectedRevision, artifactId, consentId }`; enables a revision-bound resident event subscription |
| GET `/drafts/:id/event-subscription?revision=N` | Current event subscription state and last evaluation/report identity |
| POST `/event-subscriptions/:id/stop` | `{}`; stops event delivery only; it is not a Guard revoke or Aqua dock |
| POST `/drafts/:id/authorization-binding` | `{ expectedRevision, artifactId, reportDigest, reportTransactionHash, reportNonce }`; verifies trusted Guard evidence and prepares the Maker binding message |
| GET `/drafts/:id/authorization-binding?revision=N` | Current exact artifact/report binding |
| POST `/authorization-bindings/:id/confirm` | `{ digest, signature }`; records the Maker's explicit signature after trusted report verification |
| POST `/drafts/:id/patch` | `{ expectedRevision, patch }` |
| POST `/drafts/:id/restore` | `{ expectedRevision, revision }`; appends a revision |
| POST `/conversations/:id/messages` | `{ content }`; public user text only |
| GET `/conversations/:id/messages?before=<sequence>` | Latest 100 messages before optional cursor, returned in chronological order |
| POST `/conversations/:id/turns` | `{ expectedRevision, content }`; atomically accepts one message and durable design turn, returns 202; requires `designEnabled: true` in the server configuration |
| GET `/turns/:id` | Current owned state, attempt count and resulting revision/message |
| GET `/turns/:id/events?after=<sequence>` | Replayable public text/tool-status events, 100 per page; numeric cursor |
| POST `/turns/:id/cancel` | `{}`; idempotently stops queued/running authority; already committed draft edits remain in revision history |

Missing/foreign resources return the same 404. Stale revisions or template permission conflicts return 409. Unknown SQL and driver failures return a generic 503 without input values or credentials. Requests have a 64 KiB byte limit. Signature endpoints have a bounded per-process socket-address limit; no proxy headers are trusted. Design acceptance has a shared database limit of 60 turns per wallet per hour and one active turn per draft. Simulation acceptance has a shared limit of 12 jobs per wallet per hour, counting failures/cancellations; active identical artifact requests deduplicate. Deployment still needs ingress limits.

## Public design agent

The provider uses `@ai-sdk/openai` 4.0.66 and `ai` 7.0.99, with `ToolLoopAgent`, eight model steps maximum, 3,000 output tokens per step, bounded recent server history and an authoritative draft read. Default model `gpt-5.6-sol` was verified against the configured account; operators may set `BUILDER_OPENAI_MODEL`. The API key is consumed only in the server provider. Responses storage is disabled with `store: false`; that setting is not a claim of zero data retention. Provider exceptions are redacted before SDK logging.

Ten tools are wired: capabilities, token resolution, owned Maker inventory reads, patch/restore, validation, compilation, numerical scenario previews, background lifecycle simulation, inspection and non-executable public draft export. Enabling simulation requires a configured worker and `runDesignTurn(..., signal, { simulationEnabled: true })`; otherwise the tool returns `simulation-unavailable`. Inspection can read historical/current simulation summaries without enqueueing. Amount edits use human token units and convert exactly using pinned token decimals. A draft can save one Guard limit or one Maker allocation at a time; validation identifies each missing field and the compiler still requires complete limits and allocations. Untouched settings persist; template tools reject Maker allocation. Pair changes cannot silently relabel existing amounts or price intent. Registration and cancellation preparation remain to be wired.

Compilation uses the `aqua-executor/builder` package entry, which imports the pure Guard compiler, not wallet configuration or contract-artifact loaders. Maker compiles are serialized with the draft revision and any active agent lease; identical revision/profile requests return the same immutable artifact. A durable request receipt retains its original revision after an edit. Read the artifact's current flag before using it; restoring an old specification creates a new revision and does not make its old artifact current. Current compilation does not authorize registration: simulation, user review and current wallet/chain checks remain separate gates. Provider templates are not compiled with invented Maker allocations; template preparation/instantiation is still pending.

Agent work survives HTTP disconnects. A separate process claims queued/expired turns; each attempt has a lease, and a draft mutation checks the current lease and last revision in the same transaction. User edits or new standalone user messages supersede the old turn. Cancellation prevents late events, mutations and assistant completion; it does not erase an already committed revision. A process restart can reclaim an expired turn up to three attempts; graceful shutdown leaves the lease available for recovery. A `started` event resets provisional text for the new attempt. Ordinary model failure is terminal for that turn and leaves the draft reviewable; the user can submit a new turn against its current revision.

Text and allowlisted tool name/success events are persisted for replay. No raw SDK event, reasoning trace, credential, private-policy input or tool output object goes to the client stream. Owner and lease identifiers do not go into model tool context. The chat is explicitly for public strategy goals and public parameters; the private-policy editor is a separate future boundary.

## Background lifecycle worker

Apply additive migration 005 with the migration role, then run a dedicated process:

```bash
# DATABASE_URL is supplied by the server environment; no .env file is loaded.
BUILDER_SIMULATION_ENABLED=true pnpm --filter @pintool/builder-service worker:simulation
```

`ANVIL` optionally selects the executable. `BUILDER_SIMULATION_RPC_URL` configures the upstream Sepolia **read** endpoint, defaulting to publicnode. These are operator settings and cannot be supplied in an HTTP request or model call. The worker checks the applied migration at startup; it does not run DDL. It handles one owned fork at a time, independently of the HTTP server or browser. Cloud deployment/health endpoints and application database roles remain part of the later rollout.

Immutable run inputs reference an owned compiled artifact; completed evidence has its own immutable table and digest. Acceptance locks the draft, checks revision/manifest/agent authority, deduplicates and commits the queue row plus outbox event atomically. Claim/heartbeat/finish use the same draft-before-job lock order, database-clock leases and lease tokens. Before starting a fork, the worker recompiles and compares the entire saved artifact. Before saving its result it rechecks current revision, manifest and authority. Obsolete or cancelled work cannot publish a late result; completed old evidence remains readable with `current: false`.

Infrastructure failure retries with backoff for at most three attempts. Process shutdown aborts the owned fork and leaves an expiring lease that a new process can reclaim. A completed contract-rejection matrix is a terminal failed result with inspectable cases, allowing the agent/user to revise the strategy. Repeating an old accepted request key retrieves that original job; use a new key for an explicit new run after completion/cancellation.

Readiness stays false even when all [fork cases](../../docs/BUILDER-LIFECYCLE-SIMULATION.md) pass. `current` describes the artifact binding, not whether a job passed. `coverageComplete` describes only the cases in this engine's matrix. `mock` queue fixtures and `fork-with-overrides` execution remain distinct; neither proves real wallet funding, CRE delivery or live authorization. There is no endpoint for a client to upload a successful result. The Maker simulation UI and wallet plans remain pending. Numerical scenario previews are described below.

`test/simulations.test.ts` covers queue/revision/lease/ownership and HTTP/model boundaries with real PostgreSQL. Setting `BUILDER_FORK_RPC_URL` additionally launches a separate worker process, runs actual fork settlement and reads the saved result back. This optional acceptance uses fresh unfunded identities and sends no transaction to the public RPC.

## Browser workspace

Maker conversations also expose [inventory, compilation and background simulation controls](../../docs/BUILDER-MAKER-PREPARATION.md). To run all browser acceptance suites against a fresh disposable local database, use `bash packages/builder-service/test/browser/run-all.sh` from the repository root; it builds the fixtures and owns server cleanup. The browser CI job runs this wrapper. It requests no asset signature and keeps mock/fork/live evidence distinct.

`/builder` uses the existing Privy wallet provider and displays owned conversations, streamed Markdown replies, current parameters, missing settings, immutable revision diffs and restore actions. The Builder bearer token stays in browser memory; Privy refreshes its access token for each request. Reloading requires wallet proof again and reopens saved work. Failed authentication returns to wallet verification. Lost acceptance responses can recover the active turn through the conversation list. Stopping generation preserves committed edits and cancels the worker's remaining authority.

The Provider navigation link is gated by `NEXT_PUBLIC_BUILDER_ENABLED=true`; leave it unset until the API/worker is mounted and verified. The page supports public design, the separate encrypted Provider policy editor, signed version publication/withdrawal, catalog review and Maker conversations pinned to a version. Maker wallet execution/authorization remain subsequent stages; drafts are not represented as deployed. [Workflow and privacy boundaries](../../docs/BUILDER-TEMPLATE-WORKSPACE.md).

The browser fixture bundles the actual workspace with a public local wallet and synthetic Privy JWT. Its server uses a disposable local PostgreSQL database, the real handler/worker/tools, and a deterministic model. It never adds a fixture route to the application. Install Python Playwright/Chromium in the test environment, then from the repository root:

```sh
pnpm --package esbuild@0.28.2 dlx esbuild packages/builder-service/test/browser/private-check.mjs --bundle --platform=node --format=esm --outfile=.cache/builder/private-check.mjs
pnpm --package esbuild@0.28.2 dlx esbuild packages/builder-service/test/browser/entry.jsx --bundle --format=esm --platform=browser --jsx=automatic --conditions=style --external:/hero.svg --outdir=.cache/builder/browser '--define:process.env.NEXT_PUBLIC_MANDATE_API_URL="http://127.0.0.1:3311"' '--define:process.env.NEXT_PUBLIC_CONFIDENTIAL_WORKFLOW_PUBLIC_KEY=undefined' '--define:process.env.NODE_ENV="development"'
# Set BUILDER_TEST_DATABASE_URL to disposable localhost PostgreSQL, start this in one terminal:
node packages/builder-service/test/browser/server.mjs
# In another terminal:
python3 packages/builder-service/test/browser/run.py
python3 packages/builder-service/test/browser/templates.py
```

The Python checks cover login, streamed text, two turns of CLMM edits, preserved caps, restoration, cancellation, a committed request with a lost response, reopening saved work, expired-session recovery, and mobile layout. The template script also tests ordered private rules, encryption against the existing local workflow evaluator, public signature verification, publication/instance retry, pinned Maker edits and signed withdrawal. Start with a fresh fixture database and run the scripts sequentially after the ready log. Screenshots go to ignored `.cache/builder/`. These are browser/API/database checks with a fixture identity and model, not live Privy, OpenAI browser or TEE acceptance.

Live checks use disposable localhost PostgreSQL databases and public fixture conversations:

```sh
# Needs server-side OPENAI_API_KEY and local BUILDER_TEST_DATABASE_URL.
node packages/builder-service/scripts/eval-design-agent.ts
node packages/builder-service/scripts/eval-design-api.ts
node packages/builder-service/scripts/eval-incremental-agent.ts
node packages/builder-service/scripts/eval-design-api.ts --maker-compile
```

The first records model tool inputs/results for public fixtures. The second exercises signed HTTP login, idempotent acceptance, the durable worker, event replay and resulting database drafts. Evidence is saved under ignored `.cache/builder/`. These checks do not verify the frontend, publication, simulation, Guard delivery or onchain settlement.

Sources: [node-postgres transactions](https://node-postgres.com/features/transactions), [pooling](https://node-postgres.com/features/pooling), [PostgreSQL locking](https://www.postgresql.org/docs/18/sql-select.html), [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361).

Agent sources: [AI SDK agents](https://ai-sdk.dev/docs/agents/building-agents), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

## Numerical scenario previews

Migration 006 stores immutable, owned numerical preview inputs/results. POST `/drafts/:id/previews` accepts atomic-unit scenario inputs and an expected revision; GET `/previews/:id` reads full results and GET `/drafts/:id/previews` returns bounded current/history summaries. The ninth model tool accepts human amounts and converts exactly. A shared 60-input/hour wallet budget deduplicates identical revision/manifest/engine inputs.

Maker calculations use saved allocations. Provider comparisons require explicit hypothetical allocations and create no executable artifacts. The model assumes an active bidirectional report equal to the public caps; actual wallet funds and report authorization remain separate. All three curves were compared against 27 fixed-context fork quotes and settlements, and five real OpenAI turns passed multi-version comparisons and cap rejection. See [scenario semantics, API and evidence](../../docs/BUILDER-SCENARIO-PREVIEWS.md).

## Owned Maker inventory

GET `/drafts/:id/inventory?revision=2` and the tenth model tool read one recent verified block, separating ETH, token wallet balances, Aqua allowance and bounded known virtual inventory. They reject Provider templates and late results after an edit or cancelled agent lease. This is an on-demand read, not a persisted transaction confirmation; signing needs a fresh preflight.

Supply a trusted `nativeInventoryAdapter(profile, { rpcUrl })` to the handler/worker. The design worker CLI enables it with `BUILDER_INVENTORY_ENABLED=true` and optional `BUILDER_INVENTORY_RPC_URL`; simulation enqueueing uses `BUILDER_SIMULATION_ENABLED=true` and still requires the separate fork worker. No model/client can choose addresses or RPC configuration. See [semantics, limits and actual model/fork evidence](../../docs/BUILDER-WALLET-INVENTORY.md).

## Provider publications and Maker instances

Migration 007 adds immutable signed Provider versions, a separate private ciphertext table, permanent version withdrawal and Maker instances pinned to a public version/digest. Publication uses a five-minute intent plus a separate EIP-191 wallet signature. The server accepts no plaintext policy; ciphertext remains `encrypted-unverified`, and publishing/applying never sets registration readiness. The separate browser editor and version catalog are implemented; trusted delivery remains a later stage.

Opt in with `builderHandler(pool, config, { templates: { workflowPublicKey, price: krakenTemplatePrice } })`. The key is operator-supplied public configuration; no fallback exists. Fixed templates need no price adapter; relative CLMM requires a fresh server observation and freezes its paired range. The application exposes public catalog, prepare/publish/withdraw/instantiate endpoints under `/templates`; [complete API and signing protocol](../../docs/BUILDER-PROVIDER-TEMPLATES.md).

Maker edits/restores and agent tools enforce immutable stored Provider permissions. Original caps/range/deadline are the boundary, with personal title/allocations editable and Pegged adjustments requiring explicit ranges. Model inspection sees public permissions/baseline, never ciphertext. A newer Provider version cannot change an existing pin. Withdrawal prevents new instances but does not revoke an existing standing report; event delivery must perform and confirm that separate action. Migrations 011–013 add immutable public event inbox/cursors, mutable leases/subscriptions/delivery receipts and a lease-based application outbox. Supply evaluator/delivery adapters to `runEventWorker`; the default service deliberately fails closed without them. For a signed gateway, use `createSignedEventIngress(secret)` and mount it as `eventIngress`; `normalizeMarketUpdate` and `normalizeEvmLog` provide strict source adapters with reorg-safe log identity. `createHttpEventGateway` provides a bounded HTTPS boundary for the deployment-owned TEE/CRE evaluator and Guard broadcaster: it sends public identity and events only, validates changed reports and receipts, and redacts upstream errors. The production mandate service now mounts the handler and durable workers when `DATABASE_URL` is configured; set the three event-gateway variables together before enabling report delivery.
