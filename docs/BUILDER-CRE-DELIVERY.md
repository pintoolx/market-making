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
   by the operator. The workflow recomputes current terms, including source health. An expired candidate
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

Migrations 018 and 019 add wallet execution history and persisted subscription
health transitions. Migration `017_cre_delivery_attempts.sql` adds the broadcaster attempt journal
and enforces one enabled subscription per Maker. It deliberately fails if an
older installation already has multiple enabled subscriptions for one Maker;
resolve that invalid selection before retrying instead of silently choosing one.
Keep workers off while applying migrations and do not roll back to older worker
code while an attempt remains unresolved. Never delete an uncertain attempt to
unblock the lane: recover its receipt or establish a terminal fence first.

Stopping automatic updates cancels unsent work, but a started delivery remains
tracked until resolved. Direct Guard revocation and Aqua dock remain distinct
Maker wallet actions. The reader rejects revoked/docked strategies before new
work. Monitoring degradation alone does not revoke an existing standing report. The
optional signed outage policy below can request a pause report; it takes effect
only after verified chain acceptance.

## Public sources and consented outage handling

`BUILDER_EVENT_MARKET_ENABLED=true` adds the fixed public `market.kraken`
ETH/USDC proxy source. `BUILDER_EVENT_MARKET_POLL_MS` defaults to 30000 and
accepts 15000-60000. Its bounded request has an 8-second timeout and a 16 KiB
body limit. A changed price or completed minute wakes evaluation; unchanged
observations are deduplicated. A skipped poll never refreshes source health.
The workflow independently fetches its authoritative market inputs. An event's
price is not authorization. Polling sources does not periodically renew reports.

For multiple EVM contracts, set `BUILDER_EVENT_EVM_ADDRESSES` to a JSON array of
unique addresses from the selected profile (Aqua, Router, Guard, WETH, USDC) and
set `BUILDER_EVENT_EVM_FROM_BLOCK` explicitly. Do not combine this with the
legacy singular address setting. Source IDs are `chain.<chainId>.<lowercase-address>`.
The singular form retains its existing source ID for cursor compatibility.
EVM reads check chain identity and head freshness, use bounded request timeouts,
and process at most five block ranges per poll. Backfill health reflects the
last processed block, so an old cursor does not pretend to be caught up.

A new Maker consent may include `outagePolicy`: 1-16 exact source IDs, a freshness
limit of 60-3600 seconds and `onRecovery: "reevaluate"`. The UI offers the currently
observed sources and five minutes when the configured local CRE worker supports
this feature. The selection is part of the signed digest/message. Old consents
are never silently expanded; stop and sign a new consent to add the policy.

The worker records health transitions in `builder.subscription_health` and
queues only the affected still-selected subscriptions. Missing, stale, failed or
invalidly future observations request a report with zero directions and all caps
zero. Repeated unhealthy observations do not create repeated transition jobs.
Recovery reevaluates the same valid consent; it does not unconditionally allow
trading, clear direct revocation, select another strategy or send assets.

The pause branch bypasses market fetches and policy decryption, so an unavailable
market or decryption key does not prevent it from constructing zero authority.
Both phases reload trusted consent and health; the browser and event payload
cannot choose this report. If delivery terms changed or a candidate expired,
a durable terminal not-broadcast fence may request a fresh evaluation, with a
new identity/nonce, a five-second delay and at most three automatic refreshes.
Ambiguous broadcasts retain their original identity and are never rebroadcast.

This is best-effort monitoring and delivery. A busy, stopped or failed worker,
unresolved broadcaster attempt or unavailable chain can delay or prevent the
pause. A standing report does not automatically expire during an outage or when
consent expires. The UI distinguishes a requested pause from an accepted pause;
Maker Guard revocation and dock remain separate wallet controls.

## Verification and limits

`node workflow/scripts/simulate-builder-public.mjs` runs the actual CLI with
public synthetic fixtures and no broadcast. For signed template/consent and
PostgreSQL integration, run:

```sh
# CRE CLI login, Bun/WASM tooling and workflow dependencies must already work.
# This account must be able to create disposable localhost databases.
BUILDER_TEST_DATABASE_URL=postgresql://pintool_test@127.0.0.1:55442/postgres \
  node workflow/scripts/verify-builder-pg-evaluation.mjs \
  docs/builder-cre-verification/postgres-cli-outage.json
```

The probe creates/drops its own database, uses unfunded synthetic Provider/Maker
wallets and public encryption fixtures, verifies signatures and compiles an
instance. Actual CLI evaluation uses live Kraken/Sepolia reads. It then drives
healthy -> pause -> recovery with exact database nonces 1 -> 2 -> 3; the pause
succeeds even with an invalid decryption key. Candidates remain pending and no
broadcaster attempt or public-chain transaction is created. The candidate's
provisional nonce is not the database delivery nonce; delivery must preserve
the latter exactly. See the committed [CLI evidence](builder-cre-verification/postgres-cli-outage.json).

[Integration verification](BUILDER-INTEGRATION-VERIFICATION.md) records the service,
workflow, actual model and browser checks. The ordinary browser mode uses
synthetic model/inventory/settlement adapters. Separate [wallet fork acceptance](BUILDER-WALLET-EXECUTION.md)
executes actual transactions in an isolated chain with synthetic report authority.
Neither proves public-chain report acceptance or live DON/TEE execution.

The current Guard recipes are [zero-fee only](BUILDER-FEE-GUARD-LIMITATION.md).
Funded public-wallet and resident-worker acceptance, rollout and full continuous
requirement-to-settlement evidence remain in [the PR checklist](BUILDER-REMAINING-PR.md).
No new public-chain transaction, Railway rollout, CRE deployment, activation or
secret upload was performed. PR #102 remains unmerged pending the user's instruction.
