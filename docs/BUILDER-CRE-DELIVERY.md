# Builder CRE simulation bridge

The resident Builder worker can now call the existing confidential workflow in
separate evaluate/deliver phases. This adapter uses **local CRE simulation**. It
does not provide production DON/TEE attestation or enroll/deploy a workflow.

## Flow

1. A Provider signs an immutable template version and encrypted policy. A Maker
   applies that version, confirms requirements and compiles an instance.
2. The Maker signs standing-report consent for that exact revision, manifest,
   artifact and strategy hash. A template instance without an existing report
   binding can enable event management; this queues its first evaluation.
   The database does not invent an accepted binding or chain transaction.
3. The trusted worker reloads consent, rechecks its signature, recompiles the
   artifact, verifies template permissions and the Provider signature, and pins
   the ciphertext digest and workflow public key. It generates an ephemeral
   configuration for this Maker/hash. No manual catalog entry is needed.
4. `cre workflow simulate market-maker-auth --target staging-settings` runs the
   HTTP evaluation entry. It decrypts the Provider policy inside the simulated
   confidential handler and intersects it with the public Maker atomic caps.
   The evaluation phase cannot call report delivery. Only the public result is
   returned to the worker; ciphertext is never put in jobs/outbox/model history.
5. The worker reads actual Guard state, skips unchanged effective terms, stores
   the candidate and allocates a uint64 nonce above both chain and database
   baselines. Chain state changes can require a new report even with identical
   terms. This is event-driven: there is no timer that renews standing reports.
6. Delivery reloads all trust inputs, fixes the saved nonce and issuance time,
   and invokes the delivery phase with `--broadcast` only when explicitly enabled
   by the operator. The workflow recomputes current terms. An expired candidate
   (older than 300 seconds), changed terms or consumed nonce cannot be silently
   replaced under the stored delivery identity.
7. The shared broadcaster has a separate durable lane across Makers. A started
   attempt is committed before CRE starts. A timeout or lost response occupies
   that lane until reconciliation; it cannot cause automatic rebroadcast.
8. Receipt verification checks chain identity, canonical block, successful
   receipt, exact `ReportAccepted` event/digest/nonce and Guard readback. Historical
   receipt lookup starts at the saved pre-evaluation block, so a later report does
   not erase earlier evidence. A higher nonce in the same block is recorded as
   superseded readback, with acceptance proven by the exact receipt event.

The browser shows queued, awaiting receipt, accepted and failed deliveries
separately. Accepted reports and Aqua registration are independent: ship still
requires the Maker wallet. Legacy manually provisioned Maker drafts retain their
verified binding flow; this automatic input loader requires a Provider template.

## Operational configuration

Keep `BUILDER_EVENT_WORKER_ENABLED=false` until an operator has provisioned the
simulator, authentication and sources. For this adapter, configure:

- `BUILDER_EVENT_ADAPTER=cre-simulation`
- `BUILDER_CRE_PROJECT_DIRECTORY`: the checked-out `workflow/` project containing
  the existing staging configuration, dependencies and WASM tooling.
- `BUILDER_WORKFLOW_PUBLIC_KEY`: the public X25519 key used for the signed version.
- `BUILDER_CRE_EXCLUSIVE_BROADCASTER=true`: use a report signer dedicated to this
  adapter. Do not run the legacy mandate broadcaster against the same signer.
- `BUILDER_CRE_BROADCAST_ENABLED=true` only after separately approving funded
  testnet report delivery. The default does not broadcast.
- `BUILDER_CRE_ENV_FILE`, if needed: an operator-managed file consumed opaquely
  by CRE. The adapter defaults to `/dev/null`; do not put credentials in config.
- `BUILDER_EVENT_LEASE_MS=300000`. The simulator timeout is 120000 ms; the lease
  includes public RPC checks before/after it. Values below 240000 are rejected.

Do not configure HTTP gateway URLs/token alongside this adapter. Normal public
source options and signed ingress remain available. EVM events are decoded and
filtered by chain, emitting contract, Maker, strategy and Aqua app; token events
must concern the Maker, and approvals must target Aqua. A source match alone
cannot schedule every Maker. Event payloads cannot supply authoritative prices.

Migration `017_cre_delivery_attempts.sql` adds the broadcaster attempt journal
and enforces one enabled subscription per Maker. It deliberately fails if an
older installation already has multiple enabled subscriptions for one Maker;
resolve that invalid selection before retrying instead of silently choosing one.
Keep workers off while applying migrations and do not roll back to older worker
code while an attempt remains unresolved. Never delete an uncertain attempt to
unblock the lane: recover its receipt or establish a terminal fence first.

Stopping automatic updates cancels unsent work, but a started delivery remains
tracked until resolved. Direct Guard revocation and Aqua dock remain distinct
Maker wallet actions. The reader rejects revoked/docked strategies before new
work. Monitoring degradation alone does not revoke an existing standing report.

## Verification and limits

`node workflow/scripts/simulate-builder-public.mjs` runs the actual CLI with
public synthetic policy/encryption fixtures, no wallet key and no broadcast.
`docs/builder-cre-verification/public-cli-evaluate.json` records its public result.
For the full read-only integration probe, run:

```sh
BUILDER_TEST_DATABASE_URL=postgresql://pintool_test@127.0.0.1:55442/postgres \
  node workflow/scripts/verify-builder-pg-evaluation.mjs \
  docs/builder-cre-verification/postgres-cli-evaluate.json
```

The database account needs permission to create disposable databases. This probe
accepts localhost only, creates and drops its own database, and uses unfunded
synthetic Provider/Maker wallets and a public encryption fixture. It publishes a
signed template, compiles a Maker instance, verifies signed consent, queues the
first evaluation and invokes the actual bridge and CLI. Public Kraken/Sepolia
reads are live, including the Guard nonce and activation state. The recorded
delivery remains `pending`, with no broadcaster attempt and no chain write.
The candidate's timestamp nonce is provisional; the database allocates the
delivery nonce, which the delivery phase must preserve exactly.

Bun tests cover the workflow/ABI/protocol; PostgreSQL tests cover signed input
loading, first authorization, exact large nonces, multiple Makers and uncertain
broadcast recovery. Process and RPC tests exercise invalid output, bounded
execution, receipt mismatches, reorgs and later reports.

The three browser acceptance flows cover design, Provider publication and Maker
preparation against the local API/database. Preparation includes first consent
without a pre-existing report binding and signed cancellation of automatic
updates. The browser harness uses deterministic model/inventory/simulation
adapters; it is not evidence of real wallet asset transactions or settlement.

Review validation for this batch: 96 Builder service tests passed (one optional
fork test skipped), 58 orchestrator tests passed (one optional test skipped),
66 workflow tests and 16 report-delivery tests passed, and all three browser
flows passed. Builder/frontend/workflow/report type checks passed. GitHub checks
are tracked on the PR separately from these local results.

These changes do not complete the entire product goal. Full wallet transaction
execution/replacement recovery, consented source-outage pause/recovery, complete
requirement-to-settlement acceptance and the new public Sepolia lifecycle matrix
remain to be completed. Existing unsigned plans and source-health displays must
not be described as those completed features. No new public-chain transactions,
Railway rollout, CRE deployment, activation or secret upload were performed for
this implementation. The user requires explicit permission before PR merge.
