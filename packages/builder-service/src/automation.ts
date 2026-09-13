import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { verifyMessage } from 'viem'
import { z } from 'zod'
import { contentDigest, digestJson, hashSchema, idSchema, revisionSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { readCompiledArtifact } from './artifacts.ts'
import { readOwnedDraft } from './draft-persistence.ts'
import { transaction } from './database.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'
import { readRequirementReceipt } from './requirement-reviews.ts'
import { cancelUnsentEventWork } from './event-control.ts'

const prepareSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema, artifactId: idSchema }).strict()
const confirmSchema = z.object({ intentId: idSchema, digest: hashSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130,132}$/) }).strict()
const revokeSchema = z.object({ consentId: idSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130,132}$/) }).strict()
type Reader = Pick<PoolClient, 'query'>
export interface AutomationConsentIntent {
  schemaVersion: 1; id: string; owner: string; draftId: string; revision: number; artifactId: string; contentDigest: `0x${string}`;
  manifestHash: `0x${string}`; strategyHash: `0x${string}`; scope: 'standing-report-delivery'; expiresAt: string; registrationReady: false;
}
export interface AutomationConsent {
  schemaVersion: 1; id: string; intentId: string; owner: string; draftId: string; revision: number; artifactId: string;
  contentDigest: `0x${string}`; manifestHash: `0x${string}`; strategyHash: `0x${string}`; scope: 'standing-report-delivery';
  expiresAt: string; message: string; signature: `0x${string}`; consentDigest: `0x${string}`; active: true; registrationReady: false;
}
export function consentMessage(intent: AutomationConsentIntent) {
  return ['Pintool Builder automation consent v1', `owner: ${intent.owner.slice(7)}`, `draft: ${intent.draftId}`,
    `revision: ${intent.revision}`, `artifact: ${intent.artifactId}`, `strategyHash: ${intent.strategyHash}`, `scope: ${intent.scope}`,
    `expiresAt: ${intent.expiresAt}`, `manifestHash: ${intent.manifestHash}`, `contentDigest: ${intent.contentDigest}`].join('\n')
}
export function revokeMessage(consent: Pick<AutomationConsent, 'id' | 'owner' | 'draftId' | 'strategyHash' | 'scope'>) {
  return ['Pintool Builder revoke automation consent v1', `consent: ${consent.id}`, `owner: ${consent.owner.slice(7)}`,
    `draft: ${consent.draftId}`, `strategyHash: ${consent.strategyHash}`, `scope: ${consent.scope}`].join('\n')
}
function intentDigest(intent: AutomationConsentIntent) {
  return digestJson({ schemaVersion: intent.schemaVersion, id: intent.id, owner: intent.owner, draftId: intent.draftId,
    revision: intent.revision, artifactId: intent.artifactId, contentDigest: intent.contentDigest, manifestHash: intent.manifestHash,
    strategyHash: intent.strategyHash, scope: intent.scope, expiresAt: intent.expiresAt, registrationReady: false })
}
function consentDigest(consent: Pick<AutomationConsent, 'id' | 'intentId' | 'owner' | 'draftId' | 'revision' | 'artifactId' | 'contentDigest' | 'manifestHash' | 'strategyHash' | 'scope' | 'expiresAt' | 'signature'>) {
  return digestJson({ id: consent.id, intentId: consent.intentId, owner: consent.owner, draftId: consent.draftId, revision: consent.revision,
    artifactId: consent.artifactId, contentDigest: consent.contentDigest, manifestHash: consent.manifestHash, strategyHash: consent.strategyHash,
    scope: consent.scope, expiresAt: consent.expiresAt, signature: consent.signature })
}
export async function readActiveAutomationConsent(client: Reader, owner: string, draftId: string, revision: number) {
  const row = (await client.query(`SELECT c.payload,c.consent_digest FROM builder.automation_consents c
    LEFT JOIN builder.automation_consent_revocations r ON r.consent_id=c.id
    WHERE c.owner=$1 AND c.draft_id=$2 AND c.revision=$3 AND r.consent_id IS NULL ORDER BY c.created_at DESC LIMIT 1`, [owner, draftId, revision])).rows[0]
  if (!row) return null
  const consent = row.payload as AutomationConsent
  if (row.consent_digest !== consent.consentDigest || consent.owner !== owner || consent.draftId !== draftId || consent.revision !== revision || consent.registrationReady !== false)
    throw new ServiceError('automation-consent-integrity', 500)
  return consent.expiresAt > new Date().toISOString() ? consent : null
}
async function currentArtifact(client: PoolClient, profile: DeploymentProfile, owner: string, input: { draftId: string; expectedRevision: number; artifactId: string }) {
  const draft = await readOwnedDraft(client, owner, input.draftId, true)
  if (draft.revision !== input.expectedRevision) throw conflict('draft-changed')
  if (draft.kind !== 'maker' || draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
  if (draft.requirements.length && !await readRequirementReceipt(client, profile, draft)) throw conflict('requirement-review-required')
  const artifact = await readCompiledArtifact(client, profile, owner, input.artifactId, true)
  if (!artifact.current || artifact.payload.draftId !== draft.id || artifact.payload.revision !== draft.revision) throw conflict('artifact-stale')
  return { draft, artifact }
}
export function createAutomation(pool: Pool, profile: DeploymentProfile) {
  return {
    async prepare(owner: string, requestId: string, input: unknown) {
      const value = prepareSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'automation-consent.prepare', value, async client => {
        const { draft, artifact } = await currentArtifact(client, profile, owner, value)
        const now = new Date(), expiresAt = new Date(now.getTime() + 30 * 24 * 3600_000).toISOString()
        const intent: AutomationConsentIntent = { schemaVersion: 1, id: randomUUID(), owner, draftId: draft.id, revision: draft.revision,
          artifactId: value.artifactId, contentDigest: contentDigest(draft), manifestHash: digestJson(profile), strategyHash: artifact.payload.strategyHash,
          scope: 'standing-report-delivery', expiresAt, registrationReady: false }
        const digest = digestJson(intent), message = consentMessage(intent)
        await client.query(`INSERT INTO builder.automation_consent_intents(id,owner,draft_id,revision,artifact_id,payload_digest,payload,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [intent.id, owner, draft.id, draft.revision, value.artifactId, digest, JSON.stringify({ ...intent, message }), expiresAt])
        return { intent: { ...intent, message }, digest, registrationReady: false as const }
      })
    },
    async confirm(owner: string, requestId: string, input: unknown) {
      const value = confirmSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'automation-consent.confirm', value, async client => {
        const row = (await client.query('SELECT * FROM builder.automation_consent_intents WHERE id=$1 AND owner=$2', [value.intentId, owner])).rows[0]
        if (!row) throw notFound()
        const intent = row.payload as AutomationConsentIntent & { message: string }
        const expectedDigest = intentDigest(intent)
        if (row.payload_digest !== expectedDigest) throw new ServiceError('automation-consent-integrity', 500)
        if (row.payload_digest !== value.digest || row.payload_digest !== expectedDigest || intent.id !== value.intentId || intent.owner !== owner ||
          intent.message !== consentMessage(intent) || (row.expires_at as Date).toISOString() !== intent.expiresAt) throw conflict('automation-consent-mismatch')
        if ((row.expires_at as Date).getTime() <= Date.now()) throw conflict('automation-consent-expired')
        const { draft, artifact } = await currentArtifact(client, profile, owner, { draftId: intent.draftId, expectedRevision: intent.revision, artifactId: intent.artifactId })
        if (artifact.payload.strategyHash !== intent.strategyHash) throw conflict('automation-consent-mismatch')
        let signed = false
        try { signed = await verifyMessage({ address: owner.slice(7) as `0x${string}`, message: intent.message, signature: value.signature as `0x${string}` }) } catch { /* redact */ }
        if (!signed) throw new ServiceError('invalid-automation-consent-signature', 403)
        const existing = (await client.query('SELECT payload FROM builder.automation_consents WHERE intent_id=$1 AND owner=$2', [intent.id, owner])).rows[0]
        if (existing) return { consent: existing.payload as AutomationConsent, registrationReady: false as const }
        const id = randomUUID(), consent: AutomationConsent = { schemaVersion: 1, id, intentId: intent.id, owner, draftId: draft.id, revision: draft.revision,
          artifactId: intent.artifactId, contentDigest: intent.contentDigest, manifestHash: intent.manifestHash, strategyHash: intent.strategyHash,
          scope: intent.scope, expiresAt: intent.expiresAt, message: intent.message, signature: value.signature as `0x${string}`,
          consentDigest: consentDigest({ id, intentId: intent.id, owner, draftId: draft.id, revision: draft.revision, artifactId: intent.artifactId,
            contentDigest: intent.contentDigest, manifestHash: intent.manifestHash, strategyHash: intent.strategyHash, scope: intent.scope, expiresAt: intent.expiresAt,
            signature: value.signature as `0x${string}` }), active: true, registrationReady: false }
        await client.query(`INSERT INTO builder.automation_consents(id,owner,intent_id,draft_id,revision,artifact_id,content_digest,manifest_hash,strategy_hash,scope,expires_at,message,signature,consent_digest,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [consent.id, owner, intent.id, draft.id, draft.revision, intent.artifactId, intent.contentDigest,
          intent.manifestHash, intent.strategyHash, intent.scope, intent.expiresAt, intent.message, consent.signature, consent.consentDigest, JSON.stringify(consent)])
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'automation-consent.granted',$2,$3)", [owner, consent.id, draft.revision])
        return { consent, registrationReady: false as const }
      })
    },
    async revoke(owner: string, requestId: string, input: unknown) {
      const value = revokeSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'automation-consent.revoke', value, async client => {
        const row = (await client.query('SELECT payload,consent_digest FROM builder.automation_consents WHERE id=$1 AND owner=$2', [value.consentId, owner])).rows[0]
        if (!row) throw notFound()
        const consent = row.payload as AutomationConsent, message = revokeMessage(consent)
        if (row.consent_digest !== consent.consentDigest || consent.id !== value.consentId || consent.owner !== owner || consent.registrationReady !== false)
          throw new ServiceError('automation-consent-integrity', 500)
        let signed = false
        try { signed = await verifyMessage({ address: owner.slice(7) as `0x${string}`, message, signature: value.signature as `0x${string}` }) } catch { /* redact */ }
        if (!signed) throw new ServiceError('invalid-automation-revoke-signature', 403)
        const existing = (await client.query('SELECT consent_id FROM builder.automation_consent_revocations WHERE consent_id=$1', [consent.id])).rows[0]
        if (!existing) {
          await client.query('INSERT INTO builder.automation_consent_revocations(consent_id,owner,message,signature) VALUES($1,$2,$3,$4)', [consent.id, owner, message, value.signature])
          const stopped = await client.query(`UPDATE builder.event_subscriptions SET state='stopped', stopped_at=clock_timestamp(), updated_at=clock_timestamp()
            WHERE owner=$1 AND consent_id=$2 AND state IN ('enabled','paused') RETURNING id`, [owner, consent.id])
          await cancelUnsentEventWork(client, stopped.rows.map(row => String(row.id)), 'automation-consent-revoked')
          await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'automation-consent.revoked',$2,$3)", [owner, consent.id, consent.revision])
        }
        return { consent: { ...consent, active: false as const }, registrationReady: false as const }
      })
    },
    async current(owner: string, draftId: string, expectedRevision: number) {
      ownerSchema.parse(owner); idSchema.parse(draftId); revisionSchema.parse(expectedRevision)
      return transaction(pool, async client => {
        const draft = await readOwnedDraft(client, owner, draftId, true)
        if (draft.revision !== expectedRevision) throw conflict('draft-changed')
        const consent = await readActiveAutomationConsent(client, owner, draftId, expectedRevision)
        if (!consent) return { consent: null, revision: draft.revision, registrationReady: false as const }
        return { consent: { ...consent, active: true }, revision: draft.revision, registrationReady: false as const }
      })
    },
  }
}
