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

The generic preparation queue uses `FOR UPDATE SKIP LOCKED`, expiring leases and lease tokens. A worker that lost its lease cannot renew or complete the job. Queue payloads/results contain public references and error codes, not arbitrary private inputs. **This is not yet the event report delivery state machine:** per-Maker generation selection, broadcaster nonce coordination, receipt reconciliation, subscriptions and an outbox consumer remain required. Never broadcast a transaction on the authority of a generic queue lease alone.

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
| POST `/drafts/:id/patch` | `{ expectedRevision, patch }` |
| POST `/drafts/:id/restore` | `{ expectedRevision, revision }`; appends a revision |
| POST `/conversations/:id/messages` | `{ content }`; public user text only |
| GET `/conversations/:id/messages?before=<sequence>` | Latest 100 messages before optional cursor, returned in chronological order |
| POST `/conversations/:id/turns` | `{ expectedRevision, content }`; atomically accepts one message and durable design turn, returns 202; requires `designEnabled: true` in the server configuration |
| GET `/turns/:id` | Current owned state, attempt count and resulting revision/message |
| GET `/turns/:id/events?after=<sequence>` | Replayable public text/tool-status events, 100 per page; numeric cursor |
| POST `/turns/:id/cancel` | `{}`; idempotently stops queued/running authority; already committed draft edits remain in revision history |

Missing/foreign resources return the same 404. Stale revisions or template permission conflicts return 409. Unknown SQL and driver failures return a generic 503 without input values or credentials. Requests have a 64 KiB byte limit. Signature endpoints have a bounded per-process socket-address limit; no proxy headers are trusted. Design acceptance has a shared database limit of 60 turns per wallet per hour and one active turn per draft. Deployment still needs ingress limits and simulation budgets.

## Public design agent

The provider uses `@ai-sdk/openai` 4.0.66 and `ai` 7.0.99, with `ToolLoopAgent`, eight model steps maximum, 3,000 output tokens per step, bounded recent server history and an authoritative draft read. Default model `gpt-5.6-sol` was verified against the configured account; operators may set `BUILDER_OPENAI_MODEL`. The API key is consumed only in the server provider. Responses storage is disabled with `store: false`; that setting is not a claim of zero data retention. Provider exceptions are redacted before SDK logging.

Seven tools are currently wired: capabilities, token resolution, patch/restore, validation, compilation, inspection and non-executable public draft export. Amount edits use human token units and convert exactly using pinned token decimals. A draft can save one Guard limit or one Maker allocation at a time; validation identifies each missing field and the compiler still requires complete limits and allocations. Untouched settings persist; template tools reject Maker allocation. Pair changes cannot silently relabel existing amounts or price intent. Inventory, scenario preview, lifecycle simulation, registration and cancellation preparation remain to be wired.

Compilation uses the `aqua-executor/builder` package entry, which imports the pure Guard compiler, not wallet configuration or contract-artifact loaders. Maker compiles are serialized with the draft revision and any active agent lease; identical revision/profile requests return the same immutable artifact. A durable request receipt retains its original revision after an edit. Read the artifact's current flag before using it; restoring an old specification creates a new revision and does not make its old artifact current. Current compilation does not authorize registration: simulation, user review and current wallet/chain checks remain separate gates. Provider templates are not compiled with invented Maker allocations; template preparation/instantiation is still pending.

Agent work survives HTTP disconnects. A separate process claims queued/expired turns; each attempt has a lease, and a draft mutation checks the current lease and last revision in the same transaction. User edits or new standalone user messages supersede the old turn. Cancellation prevents late events, mutations and assistant completion; it does not erase an already committed revision. A process restart can reclaim an expired turn up to three attempts; graceful shutdown leaves the lease available for recovery. A `started` event resets provisional text for the new attempt. Ordinary model failure is terminal for that turn and leaves the draft reviewable; the user can submit a new turn against its current revision.

Text and allowlisted tool name/success events are persisted for replay. No raw SDK event, reasoning trace, credential, private-policy input or tool output object goes to the client stream. Owner and lease identifiers do not go into model tool context. The chat is explicitly for public strategy goals and public parameters; the private-policy editor is a separate future boundary.

## Browser workspace

`/builder` uses the existing Privy wallet provider and displays owned conversations, streamed Markdown replies, current parameters, missing settings, immutable revision diffs and restore actions. The Builder bearer token stays in browser memory; Privy refreshes its access token for each request. Reloading requires wallet proof again and reopens saved work. Failed authentication returns to wallet verification. Lost acceptance responses can recover the active turn through the conversation list. Stopping generation preserves committed edits and cancels the worker's remaining authority.

The Provider navigation link is gated by `NEXT_PUBLIC_BUILDER_ENABLED=true`; leave it unset until the API/worker is mounted and verified. The page currently designs public Provider drafts. Publication, private editing and Maker execution are subsequent stages, and the UI does not represent a draft as deployed.

The browser fixture bundles the actual workspace with a public local wallet and synthetic Privy JWT. Its server uses a disposable local PostgreSQL database, the real handler/worker/tools, and a deterministic model. It never adds a fixture route to the application. Install Python Playwright/Chromium in the test environment, then from the repository root:

```sh
pnpm --package esbuild@0.28.2 dlx esbuild packages/builder-service/test/browser/entry.jsx --bundle --format=esm --platform=browser --jsx=automatic --conditions=style --external:/hero.svg --outdir=.cache/builder/browser '--define:process.env.NEXT_PUBLIC_MANDATE_API_URL="http://127.0.0.1:3311"' '--define:process.env.NODE_ENV="development"'
# Set BUILDER_TEST_DATABASE_URL to disposable localhost PostgreSQL, start this in one terminal:
node packages/builder-service/test/browser/server.mjs
# In another terminal:
python3 packages/builder-service/test/browser/run.py
```

The Python checks cover login, streamed text, two turns of CLMM edits, preserved caps, restoration, cancellation, a committed request with a lost response, reopening saved work, expired-session recovery, and mobile layout. Screenshots go to ignored `.cache/builder/`. These are browser/API/database checks with a fixture identity and model, not live Privy sign-in or live OpenAI browser acceptance.

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
