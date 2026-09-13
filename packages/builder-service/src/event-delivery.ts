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

const sourceSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const eventIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const publicEventSchema = z.object({
  source: sourceSchema, eventId: eventIdSchema, kind: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  payload: z.record(z.string(), z.unknown()), observedAt: z.string().datetime({ offset: true }),
  chainId: z.number().int().positive().optional(), blockNumber: z.string().regex(/^[0-9]+$/).optional(),
  blockHash: hashSchema.optional(), transactionHash: hashSchema.optional(), logIndex: z.number().int().nonnegative().optional(),
}).strict()
const enableSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema, artifactId: idSchema, consentId: idSchema }).strict()
const stopSchema = z.object({ subscriptionId: idSchema }).strict()
type PublicEvent = z.infer<typeof publicEventSchema>
type SubscriptionRow = { id: string; owner: string; draftId: string; revision: number; artifactId: string; consentId: string; generation: number; state: 'enabled' | 'paused' | 'stopped'; lastEventAt: string | null; lastInputObservedAt: string | null; lastEvaluatedAt: string | null; lastChangedAt: string | null; lastReportHash: `0x${string}` | null; lastReportNonce: string | null; stoppedAt: string | null }
type Snapshot = { subscription: SubscriptionRow; event: PublicEvent; draft: Awaited<ReturnType<typeof readOwnedDraft>>; artifact: Awaited<ReturnType<typeof readCompiledArtifact>>; consent: AutomationConsent; binding: AuthorizationBinding }
export type EvaluationResult = { status: 'unchanged' | 'changed' | 'paused' | 'failed'; reportHash?: `0x${string}`; report?: Record<string, unknown>; reason?: string; observedAt?: string }
export type DeliveryReceipt = { transactionHash: `0x${string}`; receipt?: Record<string, unknown> }
export type EventDeliveryDependencies = {
  evaluate?: (input: Snapshot) => Promise<EvaluationResult>
  deliver?: (input: { subscription: SubscriptionRow; report: Record<string, unknown>; reportHash: `0x${string}`; nonce: string }) => Promise<DeliveryReceipt>
  reconcile?: (input: { deliveryId: string; subscription: SubscriptionRow; reportHash: `0x${string}`; nonce: string }) => Promise<DeliveryReceipt | null>
}

function asIso(value: Date | string | null) { return value === null ? null : value instanceof Date ? value.toISOString() : value }
function subscription(row: Record<string, unknown>): SubscriptionRow {
  return { id: String(row.id), owner: String(row.owner), draftId: String(row.draft_id), revision: Number(row.revision), artifactId: String(row.artifact_id), consentId: String(row.consent_id), generation: Number(row.generation), state: row.state as SubscriptionRow['state'],
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
/** Durable event inbox, evaluation queue and change-only standing report delivery. */
export function createEventDelivery(pool: Pool, profile: DeploymentProfile, dependencies: EventDeliveryDependencies = {}) {
  async function currentSnapshot(client: PoolClient, sub: SubscriptionRow, event: PublicEvent) {
    const draft = await readOwnedDraft(client, sub.owner, sub.draftId, true)
    if (draft.revision !== sub.revision) throw conflict('event-subscription-stale')
    const artifact = await readCompiledArtifact(client, profile, sub.owner, sub.artifactId, true)
    if (!artifact.current || artifact.payload.draftId !== draft.id || artifact.payload.revision !== draft.revision) throw conflict('event-subscription-stale')
    const consent = await readActiveAutomationConsent(client, sub.owner, sub.draftId, sub.revision)
    if (!consent || consent.id !== sub.consentId) throw conflict('automation-consent-required')
    const binding = await readAuthorizationBinding(client, sub.owner, sub.draftId, sub.revision, sub.artifactId)
    if (!binding) throw conflict('authorization-binding-required')
    if (binding.strategyHash.toLowerCase() !== artifact.payload.strategyHash.toLowerCase() || binding.manifestHash !== artifact.payload.manifestHash || binding.contentDigest !== artifact.payload.contentDigest || binding.guard.toLowerCase() !== profile.guard.toLowerCase() || binding.router.toLowerCase() !== profile.router.toLowerCase()) throw new ServiceError('authorization-binding-integrity', 500)
    return { subscription: sub, event, draft, artifact, consent, binding }
  }
  async function publicSubscription(owner: string, id: string) {
    ownerSchema.parse(owner); idSchema.parse(id)
    return transaction(pool, async client => readSubscription(client, owner, id))
  }
  return {
    async enable(owner: string, requestId: string, input: unknown) {
      const value = enableSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'event-subscription.enable', value, async client => {
        const draft = await readOwnedDraft(client, owner, value.draftId, true)
        if (draft.revision !== value.expectedRevision) throw conflict('draft-changed')
        if (draft.kind !== 'maker' || draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
        const artifact = await readCompiledArtifact(client, profile, owner, value.artifactId, true)
        if (!artifact.current || artifact.payload.draftId !== draft.id || artifact.payload.revision !== draft.revision) throw conflict('artifact-stale')
        const consent = await readActiveAutomationConsent(client, owner, draft.id, draft.revision)
        if (!consent || consent.id !== value.consentId) throw conflict('automation-consent-required')
        const binding = await readAuthorizationBinding(client, owner, draft.id, draft.revision, value.artifactId)
        if (!binding) throw conflict('authorization-binding-required')
        if (binding.strategyHash.toLowerCase() !== artifact.payload.strategyHash.toLowerCase() || binding.manifestHash !== artifact.payload.manifestHash || binding.contentDigest !== artifact.payload.contentDigest || binding.guard.toLowerCase() !== profile.guard.toLowerCase() || binding.router.toLowerCase() !== profile.router.toLowerCase()) throw new ServiceError('authorization-binding-integrity', 500)
        const existing = (await client.query(`SELECT * FROM builder.event_subscriptions WHERE owner=$1 AND draft_id=$2 AND revision=$3 AND artifact_id=$4 AND consent_id=$5 AND state='enabled' ORDER BY generation DESC LIMIT 1`, [owner, draft.id, draft.revision, value.artifactId, value.consentId])).rows[0]
        if (existing) return { subscription: subscription(existing), registrationReady: false as const }
        const latest = (await client.query('SELECT COALESCE(MAX(generation),0)::bigint AS generation FROM builder.event_subscriptions WHERE owner=$1 AND draft_id=$2', [owner, draft.id])).rows[0]
        const id = randomUUID(), generation = Number(latest.generation) + 1
        const switched = await client.query(`UPDATE builder.event_subscriptions SET state='stopped',stopped_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE owner=$1 AND state='enabled' RETURNING id,revision`, [owner])
        for (const row of switched.rows) await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event-subscription.switched',$2,$3) ON CONFLICT DO NOTHING", [owner, row.id, row.revision])
        const row = (await client.query(`INSERT INTO builder.event_subscriptions(id,owner,draft_id,revision,artifact_id,consent_id,generation)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, owner, draft.id, draft.revision, value.artifactId, value.consentId, generation])).rows[0]
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event-subscription.enabled',$2,$3)", [owner, id, draft.revision])
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
    async stop(owner: string, requestId: string, input: unknown) {
      const value = stopSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'event-subscription.stop', value, async client => {
        const sub = await readSubscription(client, owner, value.subscriptionId, true)
        if (sub.state !== 'stopped') {
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
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (source,event_id) DO NOTHING`, [event.source, event.eventId, event.kind, JSON.stringify(event.payload), event.observedAt,
          event.chainId ?? null, event.blockNumber ?? null, event.blockHash ?? null, event.transactionHash ?? null, event.logIndex ?? null])
        if (!inserted.rowCount) return { event, duplicate: true as const, jobs: [] as string[] }
        const subscriptions = (await client.query(`SELECT s.* FROM builder.event_subscriptions s JOIN builder.automation_consents c ON c.id=s.consent_id AND c.owner=s.owner
          LEFT JOIN builder.automation_consent_revocations r ON r.consent_id=c.id WHERE s.state='enabled' AND r.consent_id IS NULL AND c.expires_at>clock_timestamp()`)).rows
        const jobs: string[] = []
        for (const row of subscriptions) {
          const sub = subscription(row), id = randomUUID(), payload = { source: event.source, eventId: event.eventId, kind: event.kind, payload: event.payload, observedAt: event.observedAt }, inputDigest = digestJson({ subscriptionId: sub.id, generation: sub.generation, event: payload })
          const result = await client.query(`INSERT INTO builder.evaluation_jobs(id,subscription_id,owner,generation,source,event_id,input_digest,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (subscription_id,generation,source,event_id) DO NOTHING`, [id, sub.id, sub.owner, sub.generation, event.source, event.eventId, inputDigest, JSON.stringify(payload)])
          if (result.rowCount) jobs.push(id)
        }
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) SELECT owner,'event.received',$1,revision FROM builder.event_subscriptions WHERE state='enabled' ON CONFLICT DO NOTHING", [event.source + ':' + event.eventId])
        return { event, duplicate: false as const, jobs }
      })
    },
    async claimEvaluation(leaseMs = 30000) {
      if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000) throw new ServiceError('invalid-request')
      const token = randomUUID()
      const row = (await pool.query(`WITH next_job AS (SELECT id FROM builder.evaluation_jobs WHERE available_at<=clock_timestamp()
        AND (state='pending' OR (state='running' AND lease_until<clock_timestamp())) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE builder.evaluation_jobs j SET state='running',lease_token=$1,lease_until=clock_timestamp()+$2::integer*interval '1 millisecond',attempts=attempts+1
        FROM next_job n WHERE j.id=n.id RETURNING j.*, $1 AS claimed_token`, [token, leaseMs])).rows[0]
      return row ? { id: String(row.id), token, owner: String(row.owner), subscriptionId: String(row.subscription_id), generation: Number(row.generation), source: String(row.source), eventId: String(row.event_id), payload: row.payload } : null
    },
    async evaluate(jobId: string, token: string) {
      idSchema.parse(jobId); idSchema.parse(token)
      const loaded = await transaction(pool, async client => {
        const row = (await client.query(`SELECT j.*,s.* FROM builder.evaluation_jobs j JOIN builder.event_subscriptions s ON s.id=j.subscription_id AND s.owner=j.owner
          WHERE j.id=$1 AND j.lease_token=$2 AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE`, [jobId, token])).rows[0]
        if (!row) throw conflict('lease-lost')
        const eventRow = (await client.query('SELECT * FROM builder.event_inbox WHERE source=$1 AND event_id=$2 AND canonical=true', [row.source, row.event_id])).rows[0]
        if (!eventRow) throw conflict('event-reorged')
        return { job: row, subscription: subscription(row), event: eventValue(eventRow) }
      })
      let result: EvaluationResult
      try {
        const snap = await transaction(pool, client => currentSnapshot(client, loaded.subscription, loaded.event))
        result = dependencies.evaluate ? await dependencies.evaluate(snap) : { status: 'failed', reason: 'evaluator-unavailable' }
      } catch (error) {
        result = { status: 'failed', reason: error instanceof ServiceError ? error.code : 'evaluation-failed' }
      }
      if (result.status === 'changed' && (!result.reportHash || !result.report || typeof result.report !== 'object')) result = { status: 'failed', reason: 'invalid-evaluation-result' }
      return transaction(pool, async client => {
        const current = (await client.query(`SELECT j.*,s.* FROM builder.evaluation_jobs j JOIN builder.event_subscriptions s ON s.id=j.subscription_id AND s.owner=j.owner
          WHERE j.id=$1 AND j.lease_token=$2 AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE`, [jobId, token])).rows[0]
        if (!current) throw conflict('lease-lost')
        const sub = subscription(current), now = new Date().toISOString()
        if (result.status === 'changed' && result.reportHash === sub.lastReportHash) result = { status: 'unchanged', observedAt: result.observedAt }
        if (result.status === 'changed') {
          const artifactRow = (await client.query('SELECT payload FROM builder.compiled_artifacts WHERE id=$1 AND owner=$2', [sub.artifactId, sub.owner])).rows[0]
          const strategyHash = artifactRow?.payload?.strategyHash
          if (typeof strategyHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(strategyHash)) throw new ServiceError('event-subscription-integrity', 500)
          const sequence = (await client.query(`INSERT INTO builder.maker_report_sequences(owner,strategy_hash,next_nonce) VALUES($1,$2,1)
            ON CONFLICT(owner,strategy_hash) DO UPDATE SET next_nonce=builder.maker_report_sequences.next_nonce+1,updated_at=clock_timestamp() RETURNING next_nonce`, [sub.owner, strategyHash])).rows[0]
          const nonce = String(sequence.next_nonce), deliveryId = randomUUID()
          await client.query(`INSERT INTO builder.report_deliveries(id,subscription_id,owner,generation,evaluation_job_id,report_hash,nonce,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (subscription_id,generation,report_hash) DO NOTHING`, [deliveryId, sub.id, sub.owner, sub.generation, jobId, result.reportHash, nonce, JSON.stringify(result.report)])
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
        const row = (await client.query(`UPDATE builder.report_deliveries SET status='broadcast',attempts=attempts+1,updated_at=clock_timestamp() WHERE id=$1 AND status='pending' AND next_attempt_at<=clock_timestamp() RETURNING *`, [deliveryId])).rows[0]
        if (!row) return null
        const sub = await readSubscription(client, String(row.owner), String(row.subscription_id))
        return { row, sub }
      })
      if (!claimed) return { status: 'already-processing' as const }
      try {
        if (!dependencies.deliver) throw new ServiceError('delivery-unavailable', 503)
        const receipt = await dependencies.deliver({ subscription: claimed.sub, report: claimed.row.payload, reportHash: claimed.row.report_hash as `0x${string}`, nonce: String(claimed.row.nonce) })
        await pool.query(`UPDATE builder.report_deliveries SET status='accepted',transaction_hash=$2,receipt=$3,updated_at=clock_timestamp() WHERE id=$1 AND status='broadcast'`, [deliveryId, receipt.transactionHash, JSON.stringify(receipt.receipt ?? null)])
        return { status: 'accepted' as const, receipt }
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : 'delivery-failed'
        const retryable = Number(claimed.row.attempts) < 3
        await pool.query(`UPDATE builder.report_deliveries SET status=$2,error_code=$3,next_attempt_at=clock_timestamp()+CASE WHEN $2='pending' THEN ((attempts * 2)::text || ' seconds')::interval ELSE interval '0' END,updated_at=clock_timestamp() WHERE id=$1 AND status='broadcast'`, [deliveryId, retryable ? 'pending' : 'failed', code])
        throw error
      }
    },
    async pendingDeliveries(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError('invalid-request')
      return (await pool.query(`SELECT id FROM builder.report_deliveries WHERE status='pending' AND next_attempt_at<=clock_timestamp() ORDER BY created_at,id LIMIT $1`, [limit])).rows.map(row => String(row.id))
    },
    async reconcile(deliveryId: string) {
      idSchema.parse(deliveryId)
      const row = (await pool.query(`SELECT d.*,s.* FROM builder.report_deliveries d JOIN builder.event_subscriptions s ON s.id=d.subscription_id AND s.owner=d.owner WHERE d.id=$1`, [deliveryId])).rows[0]
      if (!row) throw notFound()
      if (row.status !== 'broadcast' || !dependencies.reconcile) return { status: row.status }
      const receipt = await dependencies.reconcile({ deliveryId, subscription: subscription(row), reportHash: row.report_hash as `0x${string}`, nonce: String(row.nonce) })
      if (!receipt) return { status: 'broadcast' as const }
      await pool.query(`UPDATE builder.report_deliveries SET status='accepted',transaction_hash=$2,receipt=$3,updated_at=clock_timestamp() WHERE id=$1 AND status='broadcast'`, [deliveryId, receipt.transactionHash, JSON.stringify(receipt.receipt ?? null)])
      return { status: 'accepted' as const, receipt }
    },
    async markReorg(source: string, eventId: string) {
      sourceSchema.parse(source); eventIdSchema.parse(eventId)
      return transaction(pool, async client => {
        const result = await client.query(`UPDATE builder.event_inbox SET canonical=false,reorged_at=clock_timestamp() WHERE source=$1 AND event_id=$2 AND canonical=true`, [source, eventId])
        if (!result.rowCount) return { changed: false as const }
        await client.query(`UPDATE builder.evaluation_jobs SET state='cancelled',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code='event-reorged' WHERE source=$1 AND event_id=$2 AND state IN ('pending','running')`, [source, eventId])
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) SELECT owner,'event.reorged',$1,revision FROM builder.event_subscriptions WHERE state='enabled' ON CONFLICT DO NOTHING", [source + ':' + eventId])
        return { changed: true as const }
      })
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
