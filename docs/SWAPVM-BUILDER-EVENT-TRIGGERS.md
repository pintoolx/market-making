# Event-driven Builder authorization

The design uses standing authorization and event-driven reevaluation. It does not renew reports every ten minutes. This specification defines worker and recovery requirements; deployed behavior must be supported by implementation and environment evidence.

The Builder service currently implements the consent, event subscription, inbox/outbox, evaluation lease, change-only delivery, trusted binding, retry, cursor/reorg health, lease-based outbox dispatch and resident worker persistence in migrations 010–013. Signed event ingress, market/log normalizers and a confirmed EVM log source with bounded backfill/reorg replay are available as deployment adapters; CRE and chain delivery adapters remain deployment-provided, and without a verified delivery adapter the service fails closed.

## Contract and delivery semantics

- Report schema 2 uses `validUntil = 0`; legacy schema 1 retains bounded validity. Program deadlines and confirmation expiry are separate. A deadline opcode value of zero does not mean unlimited duration.
- Compare all effective authorization fields and the Maker's active hash, excluding bookkeeping nonce and `validAfter`. Unchanged terms preserve the accepted report digest, nonce and transaction; update evaluation metadata only.
- Changed terms require an ordered report, successful receipt and Guard readback before the UI marks them effective. Nonce must exceed the stored value; timestamp ordering alone is insufficient for multiple workers.
- GET requests are read-only. Drafts, previews and status refreshes do not evaluate or broadcast.
- SwapVM Extruction synchronously checks accepted Guard state. It does not wait for a webhook or CRE request. A swap event cannot retroactively reject the trade that produced it.

The standing-v2 Sepolia profile uses Guard `0x64f6e18e85dae5ec2ee44fe7f9fc66cf2a1f056f` and router `0x47a875f39ba4b0d0beaa928bb071d4b4da0b4092`. Guard version is 2, report schema 2, Maker input schema 3 and envelope schema 2. This is a simulation profile, not production DON/TEE attestation. Verify deployment manifests before using addresses. Changing the embedded Guard target changes program/order identity.

## Event processing

```text
Verified Provider template + explicit Maker consent
  -> authenticated event intake
  -> PostgreSQL inbox/outbox and per-Maker queue
  -> verify binding generation and fetch fresh trusted inputs
  -> deterministic CRE evaluation of encrypted private policy
  -> compare effective authorization terms
  -> changed terms only: deliver, confirm receipt and read back Guard
  -> SwapVM checks accepted state on every trade
```

Events request evaluation; they are not trusted prices, reports or authorization. The first worker can use a CRE HTTP adapter. Local CLI simulation and authorized production HTTP delivery have different trust guarantees. Native CRE EVM log triggers are an optional adapter, not a reason to duplicate event processing.

| Source | Required behavior |
|---|---|
| Maker activation, switch or limit change | Check consent and current binding; program changes require a new compiled instance and wallet review |
| Public market update | Fetch fresh trusted data; do not trust webhook prices or expose private thresholds to the watcher |
| Token, Aqua or Guard logs | Filter relevant instances; record block hash, transaction hash, log index and cursor |
| Provider withdrawal | Stop new applications; for existing instances, pause only under explicit accepted withdrawal terms and confirm actual onchain effect |
| Provider new version | Keep existing Maker versions pinned; no automatic hash replacement |
| Maker revoke or dock | Cancel unsent work and reconcile broadcast work; direct wallet revocation must not depend on the worker |
| Source stale or unavailable | Publish monitoring-health changes and attempt a consented pause; do not claim the old authorization expired |
| Source recovery | Reevaluate only if consent remains valid, the instance is selected, and it is neither revoked nor docked |
| Own report event | Reconcile state without an endless evaluation/report loop |

Public data polling, health checks and missed-event reconciliation may use timers. Timers must not become periodic report renewal. Verify any streaming adapter independently; the original implementation used Kraken HTTP and did not establish a production market stream.

## Persistence and concurrency

Persist automation consent, event subscriptions, inbox/outbox, evaluation jobs, deliveries and chain cursors. Use transactional outbox writes, deduplication keys, leases, retries, backfill and reorg handling. Event delivery is not inherently exactly once; make side effects safely reconcilable.

Serialize work per Maker and recheck active binding generation immediately before delivery. Switching A to B must prevent stale A work from reactivating A. A paused report for B does not pause currently active A. A database cancellation cannot undo a transaction already broadcast; retain pending identities and reconcile late receipts before retrying. Coordinate a shared broadcaster's transaction nonce separately from report nonces.

Keep `lastEvaluatedAt`, `lastInputObservedAt`, `lastChangedAt` and `lastAcceptedReport` distinct. Show monitoring health separately from current onchain authorization.

## Risk and stopping behavior

Standing authorization survives a worker outage, subject to its onchain caps, program deadline and revocation. Heartbeats cannot guarantee a pause if the delivery path itself is down. Direct Maker `setStrategyRevoked(hash, true)` persists and rejects subsequent enabled reports. Removing revocation does not reactivate a strategy; a fresh enabled report is required. Stopping a worker, revoking Guard authority, docking Aqua and revoking ERC-20 allowance are distinct operations.

USD or percentage limits become atomic token caps using the evaluation price. Guard does not fetch a new oracle price for each trade. For example, a 1,000 USDC limit at 2,500 USDC/WETH becomes 0.4 WETH; at 3,000, that same cap represents 1,200 USDC. Price changes may therefore change effective terms even when the named policy regime is unchanged. Do not ignore a tightening change to save gas. Conservative price bands and bounded update latency require separate design and validation.

Guard has one active hash per Maker. Registration, report acceptance, quote availability, settlement readiness and routing inclusion must remain separate states.

## Acceptance matrix

Verify unchanged evaluations produce no transaction; tightened terms produce a confirmed update; idle periods cause no renewal; standing reports remain valid after an hour while caps and program deadlines still apply; legacy expiry remains correct; browser closure and worker restart do not stop event processing; multiple workers preserve ordering; source outage/recovery, reorg/backfill, withdrawal, revoke/unrevoke and dock behave correctly; old results cannot override new selections; unresolved receipts do not cause duplicate side effects.

The earlier baseline at `1d7f6a2` recorded 45 workflow, 26 orchestrator and 6 local Guard tests passing. Those 77 checks establish the baseline only, not completion of this event service, a new Builder lifecycle or production TEE enrollment.

## References

- [CRE HTTP trigger](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/overview-ts)
- [CRE EVM log trigger](https://docs.chain.link/cre/guides/workflow/using-triggers/evm-log-trigger-ts)
- [Builder requirements](SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md)
