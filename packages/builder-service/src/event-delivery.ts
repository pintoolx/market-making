import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { digestJson, hashSchema, idSchema, revisionSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { readCompiledArtifact } from './artifacts.ts'
import { readOwnedDraft } from './draft-persistence.ts'
import { transaction } from './database.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'
import { readActiveAutomationConsent, type AutomationConsent } from './automation.ts'
import { readAuthorizationBinding, type AuthorizationBinding } from './bindings.ts'
import { eventMatchesInstance } from './event-routing.ts'
import { cancelUnsentEventWork } from './event-control.ts'
import { readOutageState } from './outage-policy.ts'

const sourceSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const subscriptionSourceSchema = z.union([z.literal('*'), sourceSchema])
const eventIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const publicEventSchema = z.object({
  source: sourceSchema, eventId: eventIdSchema, kind: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  payload: z.record(z.string(), z.unknown()), observedAt: z.string().datetime({ offset: true }),
  chainId: z.number().int().positive().optional(), blockNumber: z.string().regex(/^[0-9]+$/).optional(),
  blockHash: hashSchema.optional(), transactionHash: hashSchema.optional(), logIndex: z.number().int().nonnegative().optional(),
}).strict()
const enableSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema, artifactId: idSchema, consentId: idSchema, source: subscriptionSourceSchema.default('*') }).strict()
const stopSchema = z.object({ subscriptionId: idSchema }).strict()
export type PublicEvent = z.infer<typeof publicEventSchema>
export const parsePublicEvent = (input: unknown) => publicEventSchema.parse(input)
type SubscriptionRow = { id: string; owner: string; draftId: string; revision: number; artifactId: string; consentId: string; source: string; generation: number; state: 'enabled' | 'paused' | 'stopped'; lastEventAt: string | null; lastInputObservedAt: string | null; lastEvaluatedAt: string | null; lastChangedAt: string | null; lastReportHash: `0x${string}` | null; lastReportNonce: string | null; stoppedAt: string | null }
type Snapshot = { subscription: SubscriptionRow; event: PublicEvent; draft: Awaited<ReturnType<typeof readOwnedDraft>>; artifact: Awaited<ReturnType<typeof readCompiledArtifact>>; consent: AutomationConsent; binding: AuthorizationBinding | null }
export type EvaluationResult = { status: 'unchanged' | 'changed' | 'paused' | 'failed'; reportHash?: `0x${string}`; report?: Record<string, unknown>; reason?: string; observedAt?: string; nonceFloor?: string; chainStateChanged?: boolean }
export type DeliveryReceipt = { transactionHash: `0x${string}`; receipt?: Record<string, unknown> }
export type DeliveryReconciliation = DeliveryReceipt | { status: 'not-broadcast'; reevaluate?: boolean } | { status: 'reverted'; transactionHash: `0x${string}`; receipt?: Record<string, unknown> } | null
/** Only use when no request could have reached the broadcaster. */
export class DeliveryNotSentError extends ServiceError {}
/** A busy broadcaster has not been contacted; defer without consuming a retry. */
export class DeliveryDeferredError extends DeliveryNotSentError {}
export type EventHealth = { source: string; chainId?: number; blockHash: `0x${string}` | null; observedAt: string | null; health: 'healthy' | 'stale' | 'recovered' | 'error'; errorCode?: string; updatedAt: string }
export type EventDeliveryDependencies = {
  evaluate?: (input: Snapshot) => Promise<EvaluationResult>
  deliver?: (input: { deliveryId: string; subscription: SubscriptionRow; report: Record<string, unknown>; reportHash: `0x${string}`; nonce: string }) => Promise<DeliveryReceipt>
  reconcile?: (input: { deliveryId: string; subscription: SubscriptionRow; reportHash: `0x${string}`; nonce: string }) => Promise<DeliveryReconciliation>
}

function asIso(value: Date | string | null) { return value === null ? null : value instanceof Date ? value.toISOString() : value }
function subscription(row: Record<string, unknown>): SubscriptionRow {
  return { id: String(row.id), owner: String(row.owner), draftId: String(row.draft_id), revision: Number(row.revision), artifactId: String(row.artifact_id), consentId: String(row.consent_id), source: String(row.source), generation: Number(row.generation), state: row.state as SubscriptionRow['state'],
    lastEventAt: asIso(row.last_event_at as Date | null), lastInputObservedAt: asIso(row.last_input_observed_at as Date | null), lastEvaluatedAt: asIso(row.last_evaluated_at as Date | null), lastChangedAt: asIso(row.last_changed_at as Date | null), lastReportHash: row.last_report_hash as `0x${string}` | null, lastReportNonce: row.last_report_nonce === null ? null : String(row.last_report_nonce), stoppedAt: asIso(row.stopped_at as Date | null) }
}
function eventValue(row: Record<string, unknown>): PublicEvent {
  return publicEventSchema.parse({ source: row.source, eventId: row.event_id, kind: row.kind, payload: row.payload,
    observedAt: (row.observed_at as Date).toISOString(), ...(row.chain_id === null ? {} : { chainId: Number(row.chain_id) }),
    ...(row.block_number === null ? {} : { blockNumber: String(row.block_number) }), ...(row.block_hash === null ? {} : { blockHash: row.block_hash }),
    ...(row.transaction_hash === null ? {} : { transactionHash: row.transaction_hash }), ...(row.log_index === null ? {} : { logIndex: Number(row.log_index) }) })
}
async function readSubscription(client: Pick<PoolClient, 'query'>, owner: string, id: string, lock = false) {
  const row = (await client.query(`SELECT * FROM builder.event_subscriptions WHERE id=$1 AND owner=$2${lock ? ' FOR UPDATE' : ''}`, [id, owner])).rows[0]
  if (!row) throw notFound()
  return subscription(row)
}
// Always lock the inbox occurrence before its job/subscription/delivery rows.
// Reorg, evaluation completion and broadcast claims share this short boundary;
// no external evaluator or broadcaster call holds a database lock.
async function lockJobEvent(client: PoolClient, jobId: string) {
  return (await client.query(`SELECT i.canonical FROM builder.event_inbox i
    JOIN builder.evaluation_jobs j ON j.source=i.source AND j.event_id=i.event_id
    WHERE j.id=$1 FOR UPDATE OF i`, [jobId])).rows[0]?.canonical === true
}
/** Durable event inbox, evaluation queue and change-only standing report delivery. */
export function createEventDelivery(pool: Pool, profile: DeploymentProfile, dependencies: EventDeliveryDependencies = {}) {
  async function acceptReceipt(deliveryId: string, receipt: DeliveryReceipt) {
    const saved = await pool.query(`UPDATE builder.report_deliveries SET status='accepted',transaction_hash=$2,receipt=$3,error_code=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND status='broadcast' RETURNING status`, [deliveryId, receipt.transactionHash, JSON.stringify(receipt.receipt ?? null)])
    if (saved.rowCount) return { status: 'accepted' as const, receipt }
    const current = (await pool.query('SELECT status FROM builder.report_deliveries WHERE id=$1', [deliveryId])).rows[0]
    if (!current) throw notFound()
    return { status: String(current.status) }
  }
  async function currentSnapshot(client: PoolClient, sub: SubscriptionRow, event: PublicEvent) {
    const live = await readSubscription(client, sub.owner, sub.id, true)
    if (live.state !== 'enabled' || live.generation !== sub.generation || live.revision !== sub.revision) throw conflict('event-subscription-stopped')
    const internalEvent = (event.source === 'builder.health' && event.kind === 'monitor.health') || (event.source === 'builder.retry' && event.kind === 'report.retry')
    if (live.source !== '*' && live.source !== event.source && !internalEvent) throw conflict('event-source-mismatch')
    const draft = await readOwnedDraft(client, sub.owner, sub.draftId, true)
    if (draft.revision !== sub.revision) throw conflict('event-subscription-stale')
    const artifact = await readCompiledArtifact(client, profile, sub.owner, sub.artifactId, true)
    if (!artifact.current || artifact.payload.draftId !== draft.id || artifact.payload.revision !== draft.revision) throw conflict('event-subscription-stale')
    const consent = await readActiveAutomationConsent(client, sub.owner, sub.draftId, sub.revision)
    if (!consent || consent.id !== sub.consentId) throw conflict('automation-consent-required')
    const binding = await readAuthorizationBinding(client, sub.owner, sub.draftId, sub.revision, sub.artifactId)
    if (!binding && !artifact.draft.templatePin) throw conflict('authorization-binding-required')
    if (binding && (binding.strategyHash.toLowerCase() !== artifact.payload.strategyHash.toLowerCase() || binding.manifestHash !== artifact.payload.manifestHash || binding.contentDigest !== artifact.payload.contentDigest || binding.guard.toLowerCase() !== profile.guard.toLowerCase() || binding.router.toLowerCase() !== profile.router.toLowerCase())) throw new ServiceError('authorization-binding-integrity', 500)
    return { subscription: sub, event, draft, artifact, consent, binding }
  }
  async function publicSubscription(owner: string, id: string) {
    ownerSchema.parse(owner); idSchema.parse(id)
    return transaction(pool, async client => readSubscription(client, owner, id))
  }
  return {
    async scheduleHealthEvaluations() {
      return transaction(pool, async client => {
        const rows = (await client.query(`SELECT s.* FROM builder.event_subscriptions s JOIN builder.automation_consents c ON c.id=s.consent_id AND c.owner=s.owner
          LEFT JOIN builder.automation_consent_revocations r ON r.consent_id=c.id
          LEFT JOIN builder.subscription_health h ON h.subscription_id=s.id
          WHERE s.state='enabled' AND c.expires_at>clock_timestamp() AND r.consent_id IS NULL AND c.payload ? 'outagePolicy'
          ORDER BY h.updated_at ASC NULLS FIRST,s.id FOR UPDATE OF s SKIP LOCKED LIMIT 100`)).rows
        let queued = 0
        for (const row of rows) {
          const sub = subscription(row), consent = await readActiveAutomationConsent(client, sub.owner, sub.draftId, sub.revision)
          if (!consent?.outagePolicy || consent.id !== sub.consentId) continue
          const health = await readOutageState(client, consent.outagePolicy)
          const previous = (await client.query('SELECT pause_required FROM builder.subscription_health WHERE subscription_id=$1', [sub.id])).rows[0]
          await client.query(`INSERT INTO builder.subscription_health(subscription_id,pause_required,unavailable) VALUES($1,$2,$3)
            ON CONFLICT(subscription_id) DO UPDATE SET pause_required=EXCLUDED.pause_required,unavailable=EXCLUDED.unavailable,updated_at=clock_timestamp()`, [sub.id, health.pauseRequired, JSON.stringify(health.unavailable)])
          if (previous?.pause_required === health.pauseRequired || (!previous && !health.pauseRequired)) continue
          const source = 'builder.health', eventId = randomUUID(), id = randomUUID(), observedAt = new Date().toISOString()
          const payload = { source, eventId, kind: 'monitor.health', payload: {}, observedAt }
          await client.query(`INSERT INTO builder.event_inbox(source,event_id,kind,payload,observed_at) VALUES($1,$2,'monitor.health','{}',$3)`, [source, eventId, observedAt])
          await client.query(`INSERT INTO builder.evaluation_jobs(id,subscription_id,owner,generation,source,event_id,input_digest,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, sub.id, sub.owner, sub.generation, source, eventId, digestJson({ subscriptionId: sub.id, generation: sub.generation, event: payload }), JSON.stringify(payload)])
          await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'monitoring.changed',$2,$3)", [sub.owner, id, sub.revision])
          queued++
        }
        return queued
      })
    },
    async enable(owner: string, requestId: string, input: unknown) {
      const value = enableSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'event-subscription.enable', value, async client => {
        // Select one strategy per Maker, including concurrent calls for different drafts.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['builder-selection:' + owner])
        // Other event operations lock subscription before draft; preserve that order.
        await client.query("SELECT id FROM builder.event_subscriptions WHERE owner=$1 AND state='enabled' ORDER BY id FOR UPDATE", [owner])
        const draft = await readOwnedDraft(client, owner, value.draftId, true)
        if (draft.revision !== value.expectedRevision) throw conflict('draft-changed')
        if (draft.kind !== 'maker' || draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
        const artifact = await readCompiledArtifact(client, profile, owner, value.artifactId, true)
        if (!artifact.current || artifact.payload.draftId !== draft.id || artifact.payload.revision !== draft.revision) throw conflict('artifact-stale')
        const consent = await readActiveAutomationConsent(client, owner, draft.id, draft.revision)
        if (!consent || consent.id !== value.consentId) throw conflict('automation-consent-required')
        const binding = await readAuthorizationBinding(client, owner, draft.id, draft.revision, value.artifactId)
        if (!binding && !artifact.draft.templatePin) throw conflict('authorization-binding-required')
        if (binding && (binding.strategyHash.toLowerCase() !== artifact.payload.strategyHash.toLowerCase() || binding.manifestHash !== artifact.payload.manifestHash || binding.contentDigest !== artifact.payload.contentDigest || binding.guard.toLowerCase() !== profile.guard.toLowerCase() || binding.router.toLowerCase() !== profile.router.toLowerCase())) throw new ServiceError('authorization-binding-integrity', 500)
        const existing = (await client.query(`SELECT * FROM builder.event_subscriptions WHERE owner=$1 AND draft_id=$2 AND revision=$3 AND artifact_id=$4 AND consent_id=$5 AND source=$6 AND state='enabled' ORDER BY generation DESC LIMIT 1`, [owner, draft.id, draft.revision, value.artifactId, value.consentId, value.source])).rows[0]
        if (existing) return { subscription: subscription(existing), registrationReady: false as const }
        const latest = (await client.query('SELECT COALESCE(MAX(generation),0)::bigint AS generation FROM builder.event_subscriptions WHERE owner=$1 AND draft_id=$2', [owner, draft.id])).rows[0]
        const id = randomUUID(), generation = Number(latest.generation) + 1
        const switched = await client.query(`UPDATE builder.event_subscriptions SET state='stopped',stopped_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE owner=$1 AND state='enabled' RETURNING id,revision`, [owner])
        for (const row of switched.rows) {
          await cancelUnsentEventWork(client, [String(row.id)])
          await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event-subscription.switched',$2,$3) ON CONFLICT DO NOTHING", [owner, row.id, row.revision])
        }
        const row = (await client.query(`INSERT INTO builder.event_subscriptions(id,owner,draft_id,revision,artifact_id,consent_id,source,generation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, owner, draft.id, draft.revision, value.artifactId, value.consentId, value.source, generation])).rows[0]
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event-subscription.enabled',$2,$3)", [owner, id, draft.revision])
        if (!binding) {
          // First authorization follows the exact signed template + Maker consent.
          // It is pending work, never fabricated evidence of an accepted report.
          const source = value.source === '*' ? 'builder.activation' : value.source, eventId = id + '-activation'
          const event = { source, eventId, kind: 'builder.activation', payload: {}, observedAt: new Date().toISOString() }
          await client.query("INSERT INTO builder.event_inbox(source,event_id,kind,payload,observed_at) VALUES($1,$2,$3,'{}',$4)", [source, eventId, event.kind, event.observedAt])
          await client.query(`INSERT INTO builder.evaluation_jobs(id,subscription_id,owner,generation,source,event_id,input_digest,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), id, owner, generation, source, eventId, digestJson({ subscriptionId: id, generation, event }), JSON.stringify(event)])
        }
        return { subscription: subscription(row), registrationReady: false as const }
      })
    },
    async current(owner: string, draftId: string, expectedRevision: number) {
      ownerSchema.parse(owner); idSchema.parse(draftId); revisionSchema.parse(expectedRevision)
      return transaction(pool, async client => {
        const draft = await readOwnedDraft(client, owner, draftId, true)
        if (draft.revision !== expectedRevision) throw conflict('draft-changed')
        const row = (await client.query(`SELECT * FROM builder.event_subscriptions WHERE owner=$1 AND draft_id=$2 AND revision=$3 ORDER BY generation DESC LIMIT 1`, [owner, draftId, expectedRevision])).rows[0]
        return { subscription: row ? subscription(row) : null, revision: draft.revision, registrationReady: false as const }
      })
    },
    async deliveries(owner: string, subscriptionId: string) {
      await publicSubscription(owner, subscriptionId)
      return (await pool.query(`SELECT id,nonce::text,status,transaction_hash AS "transactionHash",
        receipt->>'reportDigest' AS "reportDigest",payload->'candidate'->>'allowedDirections' AS "allowedDirections",error_code AS "errorCode",updated_at AS "updatedAt"
        FROM builder.report_deliveries WHERE owner=$1 AND subscription_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20`, [owner, subscriptionId])).rows
    },
    async stop(owner: string, requestId: string, input: unknown) {
      const value = stopSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'event-subscription.stop', value, async client => {
        const sub = await readSubscription(client, owner, value.subscriptionId, true)
        if (sub.state !== 'stopped') {
          await cancelUnsentEventWork(client, [sub.id])
          await client.query("UPDATE builder.event_subscriptions SET state='stopped',stopped_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND owner=$2", [sub.id, owner])
          await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event-subscription.stopped',$2,$3) ON CONFLICT DO NOTHING", [owner, sub.id, sub.revision])
        }
        return { subscription: { ...sub, state: 'stopped' as const, stoppedAt: new Date().toISOString() }, registrationReady: false as const }
      })
    },
    async ingest(input: unknown) {
      const event = publicEventSchema.parse(input)
      return transaction(pool, async client => {
        const inserted = await client.query(`INSERT INTO builder.event_inbox(source,event_id,kind,payload,observed_at,chain_id,block_number,block_hash,transaction_hash,log_index)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (source,event_id) DO UPDATE SET kind=EXCLUDED.kind,payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at,
            chain_id=EXCLUDED.chain_id,block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,transaction_hash=EXCLUDED.transaction_hash,log_index=EXCLUDED.log_index,canonical=true,reorged_at=NULL
            WHERE builder.event_inbox.canonical=false`, [event.source, event.eventId, event.kind, JSON.stringify(event.payload), event.observedAt,
          event.chainId ?? null, event.blockNumber ?? null, event.blockHash ?? null, event.transactionHash ?? null, event.logIndex ?? null])
        if (!inserted.rowCount) return { event, duplicate: true as const, jobs: [] as string[] }
        const subscriptions = (await client.query(`SELECT s.*,a.payload->>'strategyHash' AS strategy_hash FROM builder.event_subscriptions s
          JOIN builder.compiled_artifacts a ON a.id=s.artifact_id AND a.owner=s.owner JOIN builder.automation_consents c ON c.id=s.consent_id AND c.owner=s.owner
          LEFT JOIN builder.automation_consent_revocations r ON r.consent_id=c.id WHERE s.state='enabled' AND (s.source='*' OR s.source=$1) AND r.consent_id IS NULL AND c.expires_at>clock_timestamp()`, [event.source])).rows
        const jobs: string[] = []
        for (const row of subscriptions) {
          if (!eventMatchesInstance(event, profile, String(row.owner).slice(7), String(row.strategy_hash))) continue
          const sub = subscription(row), id = randomUUID(), payload = { source: event.source, eventId: event.eventId, kind: event.kind, payload: event.payload, observedAt: event.observedAt }, inputDigest = digestJson({ subscriptionId: sub.id, generation: sub.generation, event: payload })
          const result = await client.query(`INSERT INTO builder.evaluation_jobs(id,subscription_id,owner,generation,source,event_id,input_digest,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (subscription_id,generation,source,event_id)
            WHERE reorged_at IS NULL DO NOTHING RETURNING id`, [id, sub.id, sub.owner, sub.generation, event.source, event.eventId, inputDigest, JSON.stringify(payload)])
          if (result.rowCount) {
            jobs.push(String(result.rows[0].id))
            await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event.received',$2,$3) ON CONFLICT DO NOTHING", [sub.owner, event.source + ':' + event.eventId, sub.revision])
          }
        }
        return { event, duplicate: false as const, jobs }
      })
    },
    async claimEvaluation(leaseMs = 30000) {
      if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000) throw new ServiceError('invalid-request')
      const token = randomUUID()
      const row = (await pool.query(`WITH next_job AS (SELECT j.id FROM builder.evaluation_jobs j
        JOIN builder.event_subscriptions s ON s.id=j.subscription_id AND s.owner=j.owner
        WHERE s.state='enabled' AND j.reorged_at IS NULL AND j.available_at<=clock_timestamp()
        AND (j.state='pending' OR (j.state='running' AND j.lease_until<clock_timestamp()))
        AND NOT EXISTS (SELECT 1 FROM builder.evaluation_jobs active
          WHERE active.subscription_id=j.subscription_id AND active.owner=j.owner AND active.state='running' AND active.lease_until>clock_timestamp())
        ORDER BY j.available_at,j.created_at,j.id FOR UPDATE OF j,s SKIP LOCKED LIMIT 1)
        UPDATE builder.evaluation_jobs j SET state='running',lease_token=$1,lease_until=clock_timestamp()+$2::integer*interval '1 millisecond',attempts=attempts+1
        FROM next_job n WHERE j.id=n.id RETURNING j.*, $1 AS claimed_token`, [token, leaseMs])).rows[0]
      return row ? { id: String(row.id), token, owner: String(row.owner), subscriptionId: String(row.subscription_id), generation: Number(row.generation), source: String(row.source), eventId: String(row.event_id), payload: row.payload } : null
    },
    async evaluate(jobId: string, token: string) {
      idSchema.parse(jobId); idSchema.parse(token)
      const loaded = await transaction(pool, async client => {
        if (!await lockJobEvent(client, jobId)) throw conflict('event-reorged')
        const row = (await client.query(`SELECT s.*,j.source AS event_source,j.event_id FROM builder.evaluation_jobs j JOIN builder.event_subscriptions s ON s.id=j.subscription_id AND s.owner=j.owner
          WHERE j.id=$1 AND j.reorged_at IS NULL AND j.lease_token=$2 AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE`, [jobId, token])).rows[0]
        if (!row) throw conflict('lease-lost')
        const eventRow = (await client.query('SELECT * FROM builder.event_inbox WHERE source=$1 AND event_id=$2 AND canonical=true', [row.event_source, row.event_id])).rows[0]
        if (!eventRow) throw conflict('event-reorged')
        return { subscription: subscription(row), event: eventValue(eventRow) }
      })
      let result: EvaluationResult
      try {
        const snap = await transaction(pool, client => currentSnapshot(client, loaded.subscription, loaded.event))
        result = dependencies.evaluate ? await dependencies.evaluate(snap) : { status: 'failed', reason: 'evaluator-unavailable' }
      } catch (error) {
        result = { status: 'failed', reason: error instanceof ServiceError ? error.code : 'evaluation-failed' }
      }
      if (result.nonceFloor !== undefined && (typeof result.nonceFloor !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(result.nonceFloor) || BigInt(result.nonceFloor) > 18446744073709551615n)) result = { status: 'failed', reason: 'invalid-evaluation-nonce' }
      if (result.status === 'changed' && (!result.reportHash || !result.report || typeof result.report !== 'object')) result = { status: 'failed', reason: 'invalid-evaluation-result' }
      return transaction(pool, async client => {
        if (!await lockJobEvent(client, jobId)) throw conflict('event-reorged')
        const current = (await client.query(`SELECT s.*,j.attempts FROM builder.evaluation_jobs j JOIN builder.event_subscriptions s ON s.id=j.subscription_id AND s.owner=j.owner
          WHERE j.id=$1 AND j.reorged_at IS NULL AND j.lease_token=$2 AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE`, [jobId, token])).rows[0]
        if (!current) throw conflict('lease-lost')
        const sub = subscription(current), now = new Date().toISOString()
        if (sub.state !== 'enabled') {
          await client.query("UPDATE builder.evaluation_jobs SET state='cancelled',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code='subscription-stopped' WHERE id=$1 AND lease_token=$2", [jobId, token])
          return { result: { status: 'paused' as const, reason: 'subscription-stopped', observedAt: now } }
        }
        if (result.status === 'changed' && result.reportHash === sub.lastReportHash) {
          const latest = (await client.query(`SELECT status FROM builder.report_deliveries
            WHERE subscription_id=$1 AND generation=$2 AND nonce=$3`, [sub.id, sub.generation, sub.lastReportNonce])).rows[0]
          if (latest && latest.status !== 'failed' && !(result.chainStateChanged && latest.status === 'accepted')) result = { status: 'unchanged', observedAt: result.observedAt }
        }
        if (result.status === 'changed') {
          const artifactRow = (await client.query('SELECT payload FROM builder.compiled_artifacts WHERE id=$1 AND owner=$2', [sub.artifactId, sub.owner])).rows[0]
          const strategyHash = artifactRow?.payload?.strategyHash
          if (typeof strategyHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(strategyHash)) throw new ServiceError('event-subscription-integrity', 500)
          const binding = await readAuthorizationBinding(client, sub.owner, sub.draftId, sub.revision, sub.artifactId)
          if (!binding && !artifactRow?.payload?.params?.guard) throw conflict('authorization-binding-required')
          // Continue above both the verified onchain baseline and all locally
          // allocated nonces. Keep uint64 values as exact decimal strings.
          const floor = BigInt(result.nonceFloor ?? '0') > BigInt(binding?.reportNonce ?? '0') ? result.nonceFloor! : binding?.reportNonce ?? '0'
          const sequence = (await client.query(`INSERT INTO builder.maker_report_sequences(owner,strategy_hash,next_nonce)
            SELECT $1,$2,$3::numeric+1 WHERE $3::numeric<18446744073709551615
            ON CONFLICT(owner,strategy_hash) DO UPDATE
              SET next_nonce=GREATEST(builder.maker_report_sequences.next_nonce,$3::numeric)+1,updated_at=clock_timestamp()
              WHERE builder.maker_report_sequences.next_nonce<18446744073709551615
            RETURNING next_nonce`, [sub.owner, strategyHash, floor])).rows[0]
          if (!sequence) {
            result = { status: 'failed', reason: 'report-nonce-exhausted', observedAt: now }
            await client.query("UPDATE builder.evaluation_jobs SET state='failed',result=$3,error_code='report-nonce-exhausted',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2", [jobId, token, JSON.stringify(result)])
            return { result }
          }
          const nonce = String(sequence.next_nonce), deliveryId = randomUUID()
          await client.query(`INSERT INTO builder.report_deliveries(id,subscription_id,owner,generation,evaluation_job_id,report_hash,nonce,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [deliveryId, sub.id, sub.owner, sub.generation, jobId, result.reportHash, nonce, JSON.stringify(result.report)])
          await client.query(`UPDATE builder.event_subscriptions SET last_event_at=clock_timestamp(),last_input_observed_at=$2,last_evaluated_at=clock_timestamp(),last_changed_at=clock_timestamp(),last_report_hash=$3,last_report_nonce=$4,updated_at=clock_timestamp() WHERE id=$1 AND owner=$5`, [sub.id, result.observedAt ?? loaded.event.observedAt, result.reportHash, nonce, sub.owner])
          await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'report-delivery.pending',$2,$3) ON CONFLICT DO NOTHING", [sub.owner, deliveryId, sub.revision])
          result = { ...result, observedAt: result.observedAt ?? now }
          await client.query(`UPDATE builder.evaluation_jobs SET state='succeeded',result=$3,completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`, [jobId, token, JSON.stringify({ ...result, deliveryId, nonce })])
          return { result, deliveryId, nonce }
        }
        const failed = result.status === 'failed', terminal = failed && Number(current.attempts) >= 3
        await client.query(`UPDATE builder.event_subscriptions SET last_event_at=clock_timestamp(),last_input_observed_at=$2,last_evaluated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND owner=$3`, [sub.id, result.observedAt ?? loaded.event.observedAt, sub.owner])
        await client.query(`UPDATE builder.evaluation_jobs SET state=$3,result=$4,error_code=$5,completed_at=${terminal || !failed ? 'clock_timestamp()' : 'NULL'},available_at=${failed && !terminal ? "clock_timestamp()+((attempts * 2)::text || ' seconds')::interval" : 'available_at'},lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`, [jobId, token, terminal ? 'failed' : failed ? 'pending' : 'succeeded', JSON.stringify(result), failed ? (result.reason ?? 'evaluation-failed') : null])
        return { result }
      })
    },
    async deliver(deliveryId: string) {
      idSchema.parse(deliveryId)
      const claimed = await transaction(pool, async client => {
        const identity = (await client.query('SELECT evaluation_job_id FROM builder.report_deliveries WHERE id=$1', [deliveryId])).rows[0]
        if (!identity) return null
        const canonical = await lockJobEvent(client, String(identity.evaluation_job_id))
        const job = (await client.query('SELECT reorged_at FROM builder.evaluation_jobs WHERE id=$1', [identity.evaluation_job_id])).rows[0]
        if (!canonical || job.reorged_at !== null) {
          const cancelled = await client.query("UPDATE builder.report_deliveries SET status='failed',error_code='event-reorged',updated_at=clock_timestamp() WHERE id=$1 AND status='pending'", [deliveryId])
          return cancelled.rowCount ? { stale: true as const } : null
        }
        // Enforce ordering at the claim itself: callers can bypass the pending
        // list, and an old subscription may still have an unresolved broadcast.
        const row = (await client.query(`UPDATE builder.report_deliveries d SET status='broadcast',attempts=d.attempts+1,updated_at=clock_timestamp()
          WHERE d.id=$1 AND d.status='pending' AND d.next_attempt_at<=clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM builder.report_deliveries earlier
            WHERE earlier.owner=d.owner AND earlier.status IN ('pending','broadcast')
            AND (earlier.created_at<d.created_at OR (earlier.created_at=d.created_at AND earlier.id<d.id)))
          RETURNING d.*`, [deliveryId])).rows[0]
        if (!row) {
          const current = (await client.query('SELECT status FROM builder.report_deliveries WHERE id=$1', [deliveryId])).rows[0]
          return current?.status === 'pending' ? { waiting: true as const } : null
        }
        const sub = await readSubscription(client, String(row.owner), String(row.subscription_id))
        const live = await readSubscription(client, sub.owner, sub.id, true)
        const draft = live.state === 'enabled' ? await readOwnedDraft(client, live.owner, live.draftId, true) : null
        const artifact = draft && draft.revision === live.revision ? await readCompiledArtifact(client, profile, live.owner, live.artifactId, true) : null
        const consent = draft && artifact?.current ? await readActiveAutomationConsent(client, live.owner, live.draftId, live.revision) : null
        const binding = draft && artifact?.current ? await readAuthorizationBinding(client, live.owner, live.draftId, live.revision, live.artifactId) : null
        const ready = live.state === 'enabled' && live.generation === sub.generation && live.revision === sub.revision && !!draft && draft.revision === live.revision && !!artifact?.current && artifact.payload.draftId === draft.id && artifact.payload.revision === draft.revision && !!consent && consent.id === live.consentId && ((!binding && !!draft.templatePin) || (!!binding && binding.strategyHash.toLowerCase() === artifact.payload.strategyHash.toLowerCase() && binding.manifestHash === artifact.payload.manifestHash && binding.contentDigest === artifact.payload.contentDigest && binding.guard.toLowerCase() === profile.guard.toLowerCase() && binding.router.toLowerCase() === profile.router.toLowerCase()))
        if (!ready) {
          await client.query("UPDATE builder.report_deliveries SET status='failed',error_code='subscription-stale',updated_at=clock_timestamp() WHERE id=$1 AND status='broadcast'", [deliveryId])
          return { stale: true as const }
        }
        return { row, sub }
      })
      if (!claimed) return { status: 'already-processing' as const }
      if ('waiting' in claimed) return { status: 'waiting' as const }
      if ('stale' in claimed) return { status: 'stale' as const }
      try {
        if (!dependencies.deliver) throw new DeliveryNotSentError('delivery-unavailable', 503)
        const receipt = await dependencies.deliver({ deliveryId, subscription: claimed.sub, report: claimed.row.payload, reportHash: claimed.row.report_hash as `0x${string}`, nonce: String(claimed.row.nonce) })
        return await acceptReceipt(deliveryId, receipt)
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : 'delivery-outcome-unknown'
        // Timeouts, HTTP errors and malformed responses can all happen after a
        // successful broadcast. Only a definitely local failure is retryable.
        const deferred = error instanceof DeliveryDeferredError
        const status = deferred ? 'pending' : error instanceof DeliveryNotSentError ? Number(claimed.row.attempts) < 3 ? 'pending' : 'failed' : 'broadcast'
        await pool.query(`UPDATE builder.report_deliveries SET status=$2,error_code=$3,attempts=attempts-CASE WHEN $4 THEN 1 ELSE 0 END,next_attempt_at=clock_timestamp()+CASE WHEN $2='pending' THEN ((attempts * 2)::text || ' seconds')::interval ELSE interval '0' END,updated_at=clock_timestamp() WHERE id=$1 AND status='broadcast'`, [deliveryId, status, code, deferred])
        throw error
      }
    },
    async pendingDeliveries(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError('invalid-request')
      return (await pool.query(`SELECT d.id FROM builder.report_deliveries d
        WHERE d.status='pending' AND d.next_attempt_at<=clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM builder.report_deliveries earlier
          WHERE earlier.owner=d.owner AND earlier.status IN ('pending','broadcast')
          AND (earlier.created_at<d.created_at OR (earlier.created_at=d.created_at AND earlier.id<d.id)))
        ORDER BY d.created_at,d.id LIMIT $1`, [limit])).rows.map(row => String(row.id))
    },
    /**
     * Reports marked broadcast may have been sent successfully immediately
     * before the worker process stopped. They must be reconciled on restart
     * instead of being broadcast a second time.
     */
    async broadcastDeliveries(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError('invalid-request')
      return (await pool.query(`SELECT id FROM builder.report_deliveries WHERE status='broadcast' ORDER BY updated_at,created_at,id LIMIT $1`, [limit])).rows.map(row => String(row.id))
    },
    async reconcile(deliveryId: string) {
      idSchema.parse(deliveryId)
      const row = (await pool.query(`SELECT d.*,s.* FROM builder.report_deliveries d JOIN builder.event_subscriptions s ON s.id=d.subscription_id AND s.owner=d.owner WHERE d.id=$1`, [deliveryId])).rows[0]
      if (!row) throw notFound()
      if (row.status !== 'broadcast' || !dependencies.reconcile) return { status: row.status }
      const receipt = await dependencies.reconcile({ deliveryId, subscription: subscription(row), reportHash: row.report_hash as `0x${string}`, nonce: String(row.nonce) })
      if (!receipt) {
        await pool.query("UPDATE builder.report_deliveries SET updated_at=clock_timestamp() WHERE id=$1 AND status='broadcast'", [deliveryId])
        return { status: 'broadcast' as const }
      }
      if ('status' in receipt) {
        // not-broadcast is a terminal, persisted gateway fence: a delayed
        // request for this deliveryId must now be rejected by that gateway.
        const code = receipt.status === 'not-broadcast' ? 'delivery-not-broadcast' : 'delivery-reverted'
        return transaction(pool, async client => {
          const sub = await readSubscription(client, row.owner, row.subscription_id, true)
          const updated = await client.query(`UPDATE builder.report_deliveries SET status='failed',error_code=$2,transaction_hash=$3,receipt=$4,updated_at=clock_timestamp()
            WHERE id=$1 AND status='broadcast' RETURNING status`, [deliveryId, code, 'transactionHash' in receipt ? receipt.transactionHash : null, JSON.stringify('receipt' in receipt ? receipt.receipt ?? null : null)])
          // Only a trusted adapter's persisted no-send fence can request a new
          // evaluation. An ambiguous transaction keeps its original identity.
          if (updated.rowCount && receipt.status === 'not-broadcast' && receipt.reevaluate && sub.state === 'enabled') {
            const previousJob = (await client.query('SELECT payload FROM builder.evaluation_jobs WHERE id=$1', [row.evaluation_job_id])).rows[0]
            const attempt = previousJob?.payload?.source === 'builder.retry' ? Number(previousJob.payload.payload?.attempt ?? 0) + 1 : 1
            const consent = await readActiveAutomationConsent(client, sub.owner, sub.draftId, sub.revision)
            if (consent?.id === sub.consentId && Number.isSafeInteger(attempt) && attempt <= 3) {
              const source = 'builder.retry', eventId = deliveryId, id = randomUUID(), observedAt = new Date().toISOString()
              const event = { source, eventId, kind: 'report.retry', payload: { attempt }, observedAt }
              await client.query(`INSERT INTO builder.event_inbox(source,event_id,kind,payload,observed_at) VALUES($1,$2,'report.retry',$3,$4)`, [source, eventId, JSON.stringify(event.payload), observedAt])
              await client.query(`INSERT INTO builder.evaluation_jobs(id,subscription_id,owner,generation,source,event_id,input_digest,payload,available_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 seconds')`, [id, sub.id, sub.owner, sub.generation, source, eventId, digestJson({ subscriptionId: sub.id, generation: sub.generation, event }), JSON.stringify(event)])
              await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'report.reevaluation-requested',$2,$3)", [sub.owner, id, sub.revision])
            }
          }
          const status = updated.rows[0]?.status ?? (await client.query('SELECT status FROM builder.report_deliveries WHERE id=$1', [deliveryId])).rows[0]?.status
          return { status: String(status) }
        })
      }
      return acceptReceipt(deliveryId, receipt)
    },
    async markReorg(source: string, eventId: string) {
      sourceSchema.parse(source); eventIdSchema.parse(eventId)
      return transaction(pool, async client => {
        const result = await client.query(`UPDATE builder.event_inbox SET canonical=false,reorged_at=clock_timestamp() WHERE source=$1 AND event_id=$2 AND canonical=true`, [source, eventId])
        if (!result.rowCount) return { changed: false as const }
        await client.query(`UPDATE builder.evaluation_jobs SET reorged_at=clock_timestamp(),
          state=CASE WHEN state IN ('pending','running') THEN 'cancelled' ELSE state END,
          completed_at=COALESCE(completed_at,clock_timestamp()),lease_token=NULL,lease_until=NULL,error_code='event-reorged'
          WHERE source=$1 AND event_id=$2 AND reorged_at IS NULL`, [source, eventId])
        await client.query(`UPDATE builder.report_deliveries d SET status='failed',error_code='event-reorged',updated_at=clock_timestamp()
          FROM builder.evaluation_jobs j WHERE j.id=d.evaluation_job_id AND j.source=$1 AND j.event_id=$2 AND d.status='pending'`, [source, eventId])
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) SELECT owner,'event.reorged',$1,revision FROM builder.event_subscriptions WHERE state='enabled' AND (source='*' OR source=$2) ON CONFLICT DO NOTHING", [source + ':' + eventId, source])
        return { changed: true as const }
      })
    },
    async cursor(source: string) {
      sourceSchema.parse(source)
      const row = (await pool.query('SELECT source,chain_id,cursor,block_hash,observed_at,health,error_code FROM builder.event_cursors WHERE source=$1', [source])).rows[0]
      if (!row) return null
      return { source, chainId: row.chain_id === null ? undefined : Number(row.chain_id), cursor: z.record(z.string(), z.unknown()).parse(row.cursor), blockHash: row.block_hash as `0x${string}` | null, observedAt: asIso(row.observed_at as Date | null), health: row.health as 'healthy' | 'stale' | 'recovered' | 'error', errorCode: row.error_code === null ? undefined : String(row.error_code) }
    },
    async readHealth(limit = 100): Promise<EventHealth[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ServiceError('invalid-request')
      return (await pool.query(`SELECT source,chain_id,block_hash,observed_at,health,error_code,updated_at
        FROM builder.event_cursors ORDER BY source LIMIT $1`, [limit])).rows.map(row => ({
        source: String(row.source), chainId: row.chain_id === null ? undefined : Number(row.chain_id), blockHash: row.block_hash as `0x${string}` | null,
        observedAt: asIso(row.observed_at as Date | null), health: row.health as EventHealth['health'], errorCode: row.error_code === null ? undefined : String(row.error_code), updatedAt: (row.updated_at as Date).toISOString(),
      }))
    },
    async health(source: string, input: unknown) {
      sourceSchema.parse(source)
      const value = z.object({ chainId: z.number().int().positive().optional(), cursor: z.record(z.string(), z.unknown()), blockHash: hashSchema.optional(), observedAt: z.string().datetime({ offset: true }).optional(), health: z.enum(['healthy','stale','recovered','error']), errorCode: idSchema.optional() }).strict().parse(input)
      return transaction(pool, async client => {
        const previous = (await client.query('SELECT health FROM builder.event_cursors WHERE source=$1', [source])).rows[0]?.health
        await client.query(`INSERT INTO builder.event_cursors(source,chain_id,cursor,block_hash,observed_at,health,error_code) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(source) DO UPDATE SET chain_id=EXCLUDED.chain_id,cursor=EXCLUDED.cursor,block_hash=EXCLUDED.block_hash,observed_at=EXCLUDED.observed_at,health=EXCLUDED.health,error_code=EXCLUDED.error_code,updated_at=clock_timestamp()`, [source, value.chainId ?? null, JSON.stringify(value.cursor), value.blockHash ?? null, value.observedAt ?? null, value.health, value.errorCode ?? null])
        if (previous !== value.health) await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES('system','event-health.changed',$1,1) ON CONFLICT DO NOTHING", [source])
        return { source, ...value, changed: previous !== value.health }
      })
    },
    get: publicSubscription,
    _profile: profile,
  }
}
