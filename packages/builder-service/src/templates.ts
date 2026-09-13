import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { verifyMessage } from 'viem'
import { z } from 'zod'
import { allocationSchema, assertTemplateInstance, contentDigest, digestJson, draftSchema, hashSchema, idSchema,
  makeTemplateVersion, policyEnvelopeSchema, publicationIntentSchema, publicationMessage, publicationVersion,
  publicationVersionMessage, resolveTemplateSpec, revisionSchema, signatureSchema, snapshotSchema, specSchema,
  templateDigest, templatePermissionsSchema, templateVersionSchema, validateStrategy, withdrawalMessage, workflowKeySchema,
  type DeploymentProfile, type PriceSnapshot, type StrategyDraft, type TemplateVersion } from '@pintool/strategy-builder'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema, requestReceipt } from './requests.ts'
import { readRequirementReceipt } from './requirement-reviews.ts'
import { cancelUnsentEventWork } from './event-control.ts'

export interface TemplateOptions {
  origin: string;
  /** Public workflow encryption key supplied by the operator. There is no key fallback. */
  workflowPublicKey: string;
  /** Trusted, server-owned observation source. Neither URLs nor prices come from the caller. */
  price?: (template: TemplateVersion, signal?: AbortSignal) => Promise<PriceSnapshot>;
}
const prepareSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema, templateId: idSchema.nullable(), permissions: templatePermissionsSchema }).strict()
const publishSchema = z.object({ intentId: idSchema, envelope: policyEnvelopeSchema, signature: signatureSchema }).strict()
const instantiateSchema = z.object({ templateId: idSchema, version: revisionSchema, digest: hashSchema,
  allocations: allocationSchema, title: z.string().min(1).max(120).optional() }).strict()
const withdrawSchema = z.object({ templateId: idSchema, version: revisionSchema, digest: hashSchema, signature: signatureSchema }).strict()
type Reader = Pick<PoolClient, 'query'>

async function draftFor(client: Reader, owner: string, id: string, revision: number, lock = false) {
  const row = (await client.query(`SELECT snapshot,digest FROM builder.drafts WHERE id=$1 AND owner=$2${lock ? ' FOR UPDATE' : ''}`, [id, owner])).rows[0]
  if (!row) throw notFound()
  const draft = draftSchema.parse(row.snapshot)
  if (draft.owner !== owner || draft.id !== id || contentDigest(draft) !== row.digest) throw new ServiceError('stored-draft-integrity', 500)
  if (draft.revision !== revision) throw conflict('draft-changed')
  return draft
}

/** No private-schema query is needed to authenticate an instance's permissions. */
export async function readTemplateContext(client: Reader, draft: StrategyDraft) {
  if (!draft.templatePin) return undefined
  const row = (await client.query(`SELECT i.template_id,i.version::text,i.template_digest,i.baseline,i.baseline_digest,v.payload,v.digest
    FROM builder.template_instances i JOIN builder.template_versions v ON v.template_id=i.template_id AND v.version=i.version
    WHERE i.draft_id=$1 AND i.owner=$2`, [draft.id, draft.owner])).rows[0]
  if (!row) throw new ServiceError('stored-template-context-missing', 500)
  const template = templateVersionSchema.parse(row.payload), baseline = specSchema.parse(row.baseline)
  if (row.digest !== templateDigest(template) || row.template_digest !== row.digest || row.baseline_digest !== digestJson(baseline) ||
    row.template_id !== template.templateId || Number(row.version) !== template.version) throw new ServiceError('stored-template-integrity', 500)
  assertTemplateInstance(draft, template, baseline)
  return { template, baseline }
}

export function createTemplates(pool: Pool, profile: DeploymentProfile, options: TemplateOptions) {
  const origin = z.string().url().parse(options.origin), publicKey = workflowKeySchema.parse(options.workflowPublicKey)
  if (new URL(origin).origin !== origin) throw new ServiceError('invalid-template-origin', 500)
  const algorithm = 'x25519-hkdf-sha256-xchacha20poly1305' as const, keyId = digestJson({ algorithm, publicKey })
  async function readVersion(client: Reader, id: string, version: number) {
    idSchema.parse(id); revisionSchema.parse(version)
    const row = (await client.query(`SELECT v.payload,v.digest,v.signature,i.payload AS intent,i.digest AS intent_digest,w.created_at AS withdrawn_at
      FROM builder.template_versions v JOIN builder.publication_intents i ON i.id=v.intent_id
      LEFT JOIN builder.template_withdrawals w ON w.template_id=v.template_id AND w.version=v.version
      WHERE v.template_id=$1 AND v.version=$2`, [id, version])).rows[0]
    if (!row) throw notFound()
    const template = templateVersionSchema.parse(row.payload), intent = publicationIntentSchema.parse(row.intent)
    if (templateDigest(template) !== row.digest || digestJson(intent) !== row.intent_digest || template.templateId !== id || template.version !== version) throw new ServiceError('stored-template-integrity', 500)
    // This also checks that the public signed base and encryption-key commitment agree.
    const message = publicationVersionMessage(intent, template)
    return { template, digest: row.digest as `0x${string}`, proof: { intent, message, signature: signatureSchema.parse(row.signature) },
      withdrawnAt: row.withdrawn_at ? (row.withdrawn_at as Date).toISOString() : null,
      currentManifest: template.manifestHash === digestJson(profile),
      policyStatus: 'encrypted-unverified' as const, registrationReady: false as const }
  }
  function available(result: Awaited<ReturnType<typeof readVersion>>) {
    if (result.withdrawnAt) throw conflict('template-withdrawn')
    if (!result.currentManifest) throw conflict('template-profile-stale')
    if (!result.template.spec.deadline || result.template.spec.deadline <= Math.floor(Date.now() / 1000)) throw conflict('template-expired')
    if (result.template.policy.keyId !== keyId) throw conflict('template-encryption-key-unavailable')
  }
  async function budget(client: PoolClient, owner: string, table: 'publication_intents' | 'template_instances', maximum: number) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1919512191))', [owner])
    const row = (await client.query(`SELECT count(*)::int AS count FROM builder.${table} WHERE owner=$1 AND created_at>clock_timestamp()-interval '1 hour'`, [owner])).rows[0]
    if (row.count >= maximum) throw new ServiceError('template-budget-exhausted', 429)
  }
  return {
    encryption: { algorithm, keyId, publicKey },
    async prepare(owner: string, requestId: string, input: unknown) {
      const value = prepareSchema.parse(input)
      return mutation(pool, owner, requestId, 'template.prepare', value, async client => {
        await budget(client, owner, 'publication_intents', 30)
        const draft = await draftFor(client, owner, value.draftId, value.expectedRevision, true)
        if (draft.requirements.length && !await readRequirementReceipt(client, profile, draft)) throw conflict('requirement-review-required')
        const templateId = value.templateId ?? randomUUID()
        if (!value.templateId) await client.query('INSERT INTO builder.provider_templates(id,owner) VALUES ($1,$2)', [templateId, owner])
        const series = (await client.query('SELECT latest_version::text FROM builder.provider_templates WHERE id=$1 AND owner=$2 FOR UPDATE', [templateId, owner])).rows[0]
        if (!series) throw notFound()
        const now = new Date().toISOString(), version = Number(series.latest_version) + 1
        const { policy: _policy, ...base } = makeTemplateVersion(draft, profile, { templateId, version, permissions: value.permissions,
          policy: { keyId, envelopeDigest: digestJson(null) }, now })
        const intent = publicationIntentSchema.parse({ id: randomUUID(), origin, chainId: profile.chainId, base,
          expiresAt: new Date(Date.now() + 300000).toISOString(), encryption: { algorithm, keyId, publicKey, strategyId: `${templateId}.v${version}` } })
        await client.query(`INSERT INTO builder.publication_intents(id,owner,template_id,version,draft_id,revision,payload,digest,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [intent.id, owner, templateId, version, draft.id, draft.revision, JSON.stringify(intent), digestJson(intent), intent.expiresAt])
        return { intent, registrationReady: false as const }
      })
    },
    async publish(owner: string, requestId: string, input: unknown) {
      const value = publishSchema.parse(input)
      return mutation(pool, owner, requestId, 'template.publish', value, async client => {
        const row = (await client.query('SELECT payload,digest FROM builder.publication_intents WHERE id=$1 AND owner=$2', [value.intentId, owner])).rows[0]
        if (!row) throw notFound()
        const intent = publicationIntentSchema.parse(row.payload)
        if (digestJson(intent) !== row.digest || intent.base.provider !== owner.slice(7)) throw new ServiceError('stored-publication-integrity', 500)
        if (intent.origin !== origin || intent.chainId !== profile.chainId || intent.base.manifestHash !== digestJson(profile) || intent.encryption.keyId !== keyId) throw conflict('publication-context-changed')
        const template = publicationVersion(intent, value.envelope), digest = templateDigest(template)
        let signed = false
        try { signed = await verifyMessage({ address: template.provider, message: publicationMessage(intent, value.envelope), signature: value.signature }) } catch { /* redact malformed signature */ }
        if (!signed) throw new ServiceError('invalid-publication-signature', 403)
        // Consistent lock order: draft, then series. A concurrent edit cannot publish an obsolete conversation revision.
        const draft = await draftFor(client, owner, template.source.draftId, template.source.revision, true)
        const series = (await client.query('SELECT latest_version::text FROM builder.provider_templates WHERE id=$1 AND owner=$2 FOR UPDATE', [template.templateId, owner])).rows[0]
        if (!series) throw notFound()
        const previous = (await client.query('SELECT digest FROM builder.template_versions WHERE intent_id=$1', [intent.id])).rows[0]
        if (previous) {
          if (previous.digest !== digest) throw conflict('publication-intent-already-used')
          return readVersion(client, template.templateId, template.version)
        }
        if (Date.parse(intent.expiresAt) <= Date.now()) throw conflict('publication-intent-expired')
        if (Number(series.latest_version) + 1 !== template.version) throw conflict('template-version-changed')
        if (contentDigest(draft) !== template.source.contentDigest || !validateStrategy(draft, profile, Math.floor(Date.now() / 1000)).ready) throw conflict('draft-changed')
        await client.query(`INSERT INTO builder.template_versions(template_id,version,owner,intent_id,digest,payload,signature) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [template.templateId, template.version, owner, intent.id, digest, JSON.stringify(template), value.signature])
        await client.query(`INSERT INTO builder_private.provider_policies(template_id,version,key_id,envelope_digest,envelope) VALUES ($1,$2,$3,$4,$5)`,
          [template.templateId, template.version, keyId, template.policy.envelopeDigest, JSON.stringify(value.envelope)])
        await client.query('UPDATE builder.provider_templates SET latest_version=$3 WHERE id=$1 AND owner=$2', [template.templateId, owner, template.version])
        await client.query(`INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,'template.published',$2,$3)`, [owner, template.templateId, template.version])
        return readVersion(client, template.templateId, template.version)
      })
    },
    get: (id: string, version: number) => readVersion(pool, id, version),
    async list() {
      const rows = (await pool.query(`SELECT v.template_id,v.version::text,v.payload,v.digest,w.created_at AS withdrawn_at
        FROM builder.template_versions v LEFT JOIN builder.template_withdrawals w ON w.template_id=v.template_id AND w.version=v.version
        ORDER BY v.created_at DESC,v.template_id DESC LIMIT 100`)).rows
      // Small catalog DTOs in one query; full signed public documents use get(). No private-table join.
      return rows.map(row => {
        const template = templateVersionSchema.parse(row.payload)
        if (templateDigest(template) !== row.digest || template.templateId !== row.template_id || template.version !== Number(row.version)) throw new ServiceError('stored-template-integrity', 500)
        return { templateId: template.templateId, version: template.version, digest: row.digest as string, provider: template.provider,
          title: template.spec.title, model: template.spec.model?.kind, baseToken: template.spec.baseToken, quoteToken: template.spec.quoteToken,
          deadline: template.spec.deadline, withdrawnAt: row.withdrawn_at ? (row.withdrawn_at as Date).toISOString() : null,
          currentManifest: template.manifestHash === digestJson(profile), policyStatus: 'encrypted-unverified' as const, registrationReady: false as const }
      })
    },
    async withdraw(owner: string, requestId: string, input: unknown) {
      const value = withdrawSchema.parse(input)
      return mutation(pool, owner, requestId, 'template.withdraw', value, async client => {
        // Instance creation uses the same lock: withdrawal and creation have an unambiguous ordering.
        const series = (await client.query('SELECT id FROM builder.provider_templates WHERE id=$1 AND owner=$2 FOR UPDATE', [value.templateId, owner])).rows[0]
        if (!series) throw notFound()
        const saved = await readVersion(client, value.templateId, value.version)
        if (saved.digest !== value.digest) throw conflict('template-digest-mismatch')
        let signed = false
        try { signed = await verifyMessage({ address: saved.template.provider, message: withdrawalMessage(origin, profile.chainId, saved.template), signature: value.signature }) } catch { /* redact */ }
        if (!signed) throw new ServiceError('invalid-withdrawal-signature', 403)
        if (!saved.withdrawnAt) {
          await client.query('INSERT INTO builder.template_withdrawals(template_id,version,owner,signature,origin) VALUES ($1,$2,$3,$4,$5)', [value.templateId, value.version, owner, value.signature, origin])
          await client.query(`INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,'template.withdrawn',$2,$3)`, [owner, value.templateId, value.version])
          const paused = await client.query(`UPDATE builder.event_subscriptions s SET state='paused',updated_at=clock_timestamp()
            FROM builder.drafts d WHERE d.id=s.draft_id AND d.owner=s.owner AND s.state='enabled'
              AND d.snapshot->'templatePin'->>'templateId'=$1 AND (d.snapshot->'templatePin'->>'version')::bigint=$2 RETURNING s.id,s.owner,s.revision`, [value.templateId, value.version])
          await cancelUnsentEventWork(client, paused.rows.map(row => String(row.id)), 'template-withdrawn')
          for (const row of paused.rows) await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event-subscription.paused',$2,$3) ON CONFLICT DO NOTHING", [row.owner, row.id, row.revision])
        }
        return readVersion(client, value.templateId, value.version)
      })
    },
    async instantiate(owner: string, requestId: string, input: unknown, signal?: AbortSignal) {
      ownerSchema.parse(owner); idSchema.parse(requestId)
      const value = instantiateSchema.parse(input)
      const receipt = await requestReceipt<{ conversationId: string; draft: StrategyDraft; registrationReady: false }>(pool, owner, requestId, 'template.instantiate', value)
      if (receipt) return receipt
      const before = await readVersion(pool, value.templateId, value.version)
      available(before)
      if (before.digest !== value.digest) throw conflict('template-digest-mismatch')
      const model = before.template.spec.model
      let snapshot: PriceSnapshot | undefined
      if (model?.kind === 'concentrated' && model.relativeWidthBps !== undefined) {
        if (!options.price) throw new ServiceError('template-price-unavailable', 503)
        const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          snapshot = snapshotSchema.parse(await Promise.race([options.price(before.template, combined), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('price-timeout')) }, 10000); timer.unref()
          })]))
        } catch { throw new ServiceError('template-price-unavailable', 503) } finally { if (timer) clearTimeout(timer) }
      }
      const baseline = resolveTemplateSpec(before.template, snapshot)
      return mutation(pool, owner, requestId, 'template.instantiate', value, async client => {
        await budget(client, owner, 'template_instances', 60)
        await client.query('SELECT id FROM builder.provider_templates WHERE id=$1 FOR UPDATE', [value.templateId])
        const saved = await readVersion(client, value.templateId, value.version)
        available(saved)
        if (saved.digest !== value.digest) throw conflict('template-digest-mismatch')
        if (signal?.aborted) throw new ServiceError('request-interrupted')
        if (snapshot && (Date.now() - Date.parse(snapshot.observedAt) > 60000 || Date.parse(snapshot.observedAt) > Date.now() + 5000)) throw conflict('template-price-stale')
        const now = new Date().toISOString(), conversationId = randomUUID()
        const draft = draftSchema.parse({ schemaVersion: 1, id: randomUUID(), owner, kind: 'maker', maker: owner.slice(7), revision: 1,
          salt: BigInt('0x' + randomBytes(8).toString('hex')).toString(), createdAt: now, updatedAt: now,
          templatePin: { templateId: value.templateId, version: value.version, digest: value.digest },
          spec: { ...baseline, title: value.title ?? baseline.title }, allocations: value.allocations,
          requirements: saved.template.requirements.map(r => ({ ...r, userAcceptedAlternative: false })) })
        assertTemplateInstance(draft, saved.template, baseline)
        if (!validateStrategy(draft, profile, Math.floor(Date.now() / 1000)).ready) throw conflict('template-instance-invalid')
        await client.query('INSERT INTO builder.conversations(id,owner,title) VALUES ($1,$2,$3)', [conversationId, owner, draft.spec.title])
        await client.query('INSERT INTO builder.drafts(id,owner,conversation_id,revision,snapshot,digest) VALUES ($1,$2,$3,1,$4,$5)', [draft.id, owner, conversationId, JSON.stringify(draft), contentDigest(draft)])
        await client.query(`INSERT INTO builder.draft_revisions(draft_id,owner,revision,snapshot,digest,diff) VALUES ($1,$2,1,$3,$4,'[]')`, [draft.id, owner, JSON.stringify(draft), contentDigest(draft)])
        await client.query(`INSERT INTO builder.template_instances(draft_id,owner,initial_revision,template_id,version,template_digest,baseline,baseline_digest)
          VALUES ($1,$2,1,$3,$4,$5,$6,$7)`, [draft.id, owner, value.templateId, value.version, value.digest, JSON.stringify(baseline), digestJson(baseline)])
        await client.query(`INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,'draft.changed',$2,1),($1,'template.instantiated',$2,1)`, [owner, draft.id])
        return { conversationId, draft, registrationReady: false as const }
      })
    },
  }
}
