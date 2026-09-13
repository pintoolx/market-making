# Builder platform wiring

The Railway `mandate-service` is the single HTTP process for both the original
mandate API and Builder. `orchestrator/src/server.mjs` delegates
`/v1/builder/*` to the Builder handler; no second listener or proxy is needed.

When `DATABASE_URL` is configured, `orchestrator/src/builder-runtime.mjs`
creates one bounded PostgreSQL pool and runs the additive migrations before the
server starts. The migration runner takes the existing advisory lock and checks
checksums, so two restarted instances cannot apply a migration twice. Mount
`/data` for the existing mandate state and keep the service at one replica when
using filesystem-backed state.

The runtime can own three durable loops:

- the design loop claims agent turns and runs the OpenAI/AI SDK worker;
- the simulation loop claims fork jobs when `BUILDER_SIMULATION_ENABLED=true`;
- the event loop claims revision-bound evaluations and lease-based outbox rows
  when `BUILDER_EVENT_WORKER_ENABLED=true`.

The design loop only starts when `OPENAI_API_KEY` is present and
`BUILDER_DESIGN_ENABLED` is not `false`. The key is passed directly to the
server-side OpenAI provider and is never included in a tool context or log.
The simulation loop uses the existing `forkSimulationAdapter`; a completed
simulation remains labeled fork/mock evidence and does not authorize a wallet
or a Guard report.

Event ingress is independent from event evaluation. Set
`BUILDER_EVENT_INGRESS_SECRET` to enable the HMAC-authenticated
`POST /v1/builder/events/ingest` and `/health` routes. Events are validated,
deduplicated and retained with block/transaction/log identity before they reach
the worker. Set `BUILDER_EVENT_EVALUATOR_URL`,
`BUILDER_EVENT_DELIVERY_URL` and `BUILDER_EVENT_GATEWAY_TOKEN` together before
enabling `BUILDER_EVENT_WORKER_ENABLED`. The runtime uses the HTTPS event
gateway adapter for the two trusted operations:

Authenticated Maker sessions can read public source-health summaries at
`GET /v1/builder/events/health?limit=N`. The response contains source, chain,
last observation, block hash and health state only; it does not return the
cursor or any private policy input.

For an EVM log trigger, set `BUILDER_EVENT_EVM_ADDRESS` and
`BUILDER_EVENT_EVM_FROM_BLOCK` together. The resident worker then polls
`BUILDER_EVENT_EVM_RPC_URL` (or the mandate RPC), waits for
`BUILDER_EVENT_EVM_CONFIRMATIONS` (default `2`), chunks backfill requests and
persists its cursor and a bounded block hash history. A changed history hash
marks the old inbox identities reorged before replaying the affected range.
`BUILDER_EVENT_EVM_TOPIC0` is an optional first-topic filter. This adapter only
provides public log facts; the evaluator still fetches trusted state and the
delivery gateway remains required.

```json
{
  "schemaVersion": 1,
  "operation": "evaluate",
  "owner": "wallet:0x...",
  "draftId": "...",
  "revision": 4,
  "artifactId": "...",
  "consentId": "...",
  "generation": 2,
  "strategyHash": "0x...",
  "manifestHash": "0x...",
  "contentDigest": "0x...",
  "guard": "0x...",
  "router": "0x...",
  "event": { "source": "market.gateway", "eventId": "...", "kind": "market.updated", "payload": {}, "observedAt": "..." }
}
```

The evaluator returns a strict public `EvaluationResult`. A `changed` result
must include both a 32-byte `reportHash` and a public report object. Delivery
receives the revision-bound report hash and nonce and must return a verified
transaction hash. Both `deliver` and `reconcile` include the same durable
`deliveryId`. The gateway must persist this identity, bind it to the exact
owner/subscription/generation/report hash/nonce, and reject conflicting reuse.
It must not broadcast twice for a duplicate identity. A transaction hash alone
is insufficient evidence of acceptance: confirm the Guard receipt and readback
before returning the successful receipt shape.

Reconciliation returns `null` for an unknown or still-pending outcome. Network
timeouts, HTTP errors and invalid response bodies leave the service row in
`broadcast`; they block later reports for that Maker and are never blindly
resent. A failure proven to occur before any network request can be retried
with the same ID. Reconciliation also accepts these terminal outcomes:

- `{ "status": "reverted", "transactionHash": "0x...", "receipt": {} }`
  records a confirmed reverted transaction and releases the ordering barrier.
- `{ "status": "not-broadcast" }` requires a durable terminal gateway fence
  that rejects any delayed `deliver` for this ID. An absent request/receipt in
  a lookup does not prove this outcome; return `null` unless the fence exists.

Both terminal outcomes retain the failed delivery. A subsequent event may
reevaluate the current strategy and create a new ID and report nonce. The
adapter sends no Maker private policy, signature or private key.
With no adapter the worker fails closed and never fabricates a report; queued
events and any already-created delivery rows remain recoverable through their
leases.

The runtime also installs a read-only Sepolia RPC verifier for authorization
bindings. Before creating a Maker signing intent it locates the Guard's latest
accepted report, checks its `ReportAccepted` log and stored report at the same
domain, then matches the supplied digest, transaction hash, nonce, Maker,
Guard, Router, strategy hash and token pair. RPC/provider failures are reduced
to stable `binding-proof-unavailable` errors; no receipt or report payload is
copied into public logs.

Required production checks:

1. Set Railway `DATABASE_URL=${{Postgres.DATABASE_URL}}`, deploy, and confirm
   `/health` plus the Builder authenticated session route.
2. Confirm the migration table contains 001–016 and that the Builder service
   uses a database role with only the application schema permissions.
3. Run one real multi-turn request with the configured OpenAI key and inspect
   only public draft/tool events.
4. Inject and review the CRE evaluator/delivery adapter before enabling event
   processing. It must validate the exact Maker, artifact, report domain,
   nonce and receipt, and must not accept browser-provided private policy or
   transaction calldata.
5. Exercise restart recovery with a queued event and an outbox lease. A healthy
   HTTP response alone is not evidence of CRE, TEE or onchain authorization.

No CRE upload, activation or public-chain transaction is performed by this
wiring change.

Migration 015 preserves delivery history, replaces historical report-hash
uniqueness with evaluation-job uniqueness, and widens report nonces to exact
uint64-compatible decimal columns. Take a database backup before applying it.
When rolling the application back to a version before 015, keep event delivery
disabled: that version's insert targets the removed hash constraint and cannot
resume delivery against the new schema. Retain the schema/history and deploy a
compatible event worker before reenabling the gateway.

Migration 016 retains orphaned evaluation history and limits event deduplication
to non-orphaned occurrences. It also cancels existing unsent reports whose
source event is already noncanonical; broadcast and accepted records remain
untouched. Back up before applying it. A pre-016 worker's event insert cannot
infer the new partial unique index: disable event ingress and workers before
rolling back that application, keep the newer schema/history, and reenable only
with a compatible worker. Local upgrade tests cover pre-existing pending,
broadcast and accepted reports. The production gateway must support the durable
delivery identity and terminal fencing contract before event delivery is enabled.

## Rollout evidence

On 2026-09-13, Railway deployment
`34b5b223-5550-4628-9cf6-9f59c46de03f` (main commit `6a9a2e03`) reached
`SUCCESS` with one running replica. The service log showed the Builder design
worker ready, and `GET /health` returned `status: ok`, chain `11155111` and
network `Ethereum Sepolia`. An unauthenticated Builder capabilities request
returned `authentication-required`; an unsigned event-ingress request returned
`event-ingress-unavailable`, confirming the route is mounted while ingress stays
disabled until its HMAC secret is configured. No event gateway variables are
configured, so the event worker remains off and cannot fabricate reports.
