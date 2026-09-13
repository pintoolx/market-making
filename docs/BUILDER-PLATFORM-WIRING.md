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
transaction hash; reconciliation may return `null` while a broadcast remains
unknown. The adapter sends no Maker private policy, signature or private key.
With no adapter the worker fails closed and never fabricates a report; queued
events and any already-created delivery rows remain recoverable through their
leases.

Required production checks:

1. Set Railway `DATABASE_URL=${{Postgres.DATABASE_URL}}`, deploy, and confirm
   `/health` plus the Builder authenticated session route.
2. Confirm the migration table contains 001–013 and that the Builder service
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
