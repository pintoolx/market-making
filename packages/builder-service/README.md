# Builder persistence and API foundation

Node 24+, PostgreSQL 16+ (Railway and CI target 18.6). This package exports an authenticated HTTP handler and durable repositories; it is not yet mounted in the deployed orchestrator. Public messages are persisted, but this batch does not run an agent or dispatch its outbox. No Railway migration or application deployment has been performed by this batch.

## Verification and migration

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck:builder-service
# Configure BUILDER_TEST_DATABASE_URL for a disposable PostgreSQL server, then:
pnpm test:builder-service
# Deployment operator configures DATABASE_URL privately, then:
pnpm --filter @pintool/builder-service migrate
```

The integration test requires CREATE DATABASE permission. It creates a unique `pintool_builder_test_*` database and removes only that database afterward. It does not silently skip when PostgreSQL is unavailable. Tests exercise migrations, concurrent writers and retries, owner isolation, restoring revisions, a fresh pool reading persisted records, job lease recovery, actual wallet signatures and HTTP requests. Local verification used PostgreSQL 16 from the distribution packages; CI uses the pinned official 18.6 image. None of these tests use public-chain writes or user credentials.

Migrations use the dedicated `builder` schema, an advisory transaction lock and recorded checksums. Applied SQL files must not be edited. Add new numbered migrations for subsequent changes. An application rollback leaves the additive schema and history intact; it never runs a destructive down migration. Take a database backup before production schema upgrades, and validate compatibility against the rollback application version. Legacy JSON mandate state and Provider registries are untouched.

## Ownership and transaction boundaries

The API derives `owner = wallet:<verified lowercase address>` from a server session. Existing Privy-connected EOA wallets can sign the generated ERC-4361 challenge without assets. Challenges expire after five minutes and are consumed atomically once. The signed session duration is at most 24 hours. Message text, domain, chain and address come from the server; sessions are bound to the configured origin and chain. Database rows store token hashes, and logout revokes the session. Smart-contract wallet signatures are not supported by this initial EOA adapter.

Clients must keep the returned bearer token out of URLs, logs and model input. Mount this handler with the same explicit HTTPS frontend origin used by the application's wallet UI. Browser requests send `Authorization` and `Idempotency-Key` headers. CORS is not authentication. The handler rejects client-supplied owners, message roles/tool history and unsupported fields. New Maker drafts use the session wallet and cannot be retargeted to an unverified address.

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
| GET `/conversations` | Latest 100 owned conversations |
| GET `/drafts/:id` | Owned draft |
| GET `/drafts/:id/history` | Latest 100 immutable revision summaries |
| POST `/drafts/:id/patch` | `{ expectedRevision, patch }` |
| POST `/drafts/:id/restore` | `{ expectedRevision, revision }`; appends a revision |
| POST `/conversations/:id/messages` | `{ content }`; public user text only |
| GET `/conversations/:id/messages?before=<sequence>` | Latest 100 messages before optional cursor, returned in chronological order |

Missing/foreign resources return the same 404. Stale revisions or template permission conflicts return 409. Unknown SQL and driver failures return a generic 503 without input values or credentials. Requests have a 64 KiB byte limit. Signature endpoints have a bounded per-process socket-address limit; no proxy headers are trusted. Production ingress quotas and per-user model/simulation budgets will be added with the agent service, before rollout.

Sources: [node-postgres transactions](https://node-postgres.com/features/transactions), [pooling](https://node-postgres.com/features/pooling), [PostgreSQL locking](https://www.postgresql.org/docs/18/sql-select.html), [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361).
