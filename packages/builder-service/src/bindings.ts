import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { verifyMessage } from 'viem'
import { z } from 'zod'
import { digestJson, hashSchema, idSchema, revisionSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { readCompiledArtifact } from './artifacts.ts'
import { readOwnedDraft } from './draft-persistence.ts'
import { transaction } from './database.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'
import { readRequirementReceipt } from './requirement-reviews.ts'

const reportNonce = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) < 1n << 64n, 'nonce exceeds uint64')
const prepareSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema, artifactId: idSchema, reportDigest: hashSchema, reportTransactionHash: hashSchema, reportNonce }).strict()
const confirmSchema = z.object({ intentId: idSchema, digest: hashSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130,132}$/) }).strict()
export type BindingProof = { chainId: number; maker: `0x${string}`; guard: `0x${string}`; router: `0x${string}`; strategyHash: `0x${string}`; reportSchema: 2; reportDigest: `0x${string}`; reportTransactionHash: `0x${string}`; reportNonce: string; accepted: true }
export type BindingDependencies = { verifyReport?: (input: { owner: string; profile: DeploymentProfile; artifact: Awaited<ReturnType<typeof readCompiledArtifact>>; reportDigest: `0x${string}`; reportTransactionHash: `0x${string}`; reportNonce: string }) => Promise<BindingProof> }
export interface AuthorizationBindingIntent { schemaVersion: 1; id: string; owner: string; draftId: string; revision: number; artifactId: string; manifestHash: `0x${string}`; contentDigest: `0x${string}`; maker: `0x${string}`; guard: `0x${string}`; router: `0x${string}`; strategyHash: `0x${string}`; programHash: `0x${string}`; orderHash: `0x${string}`; reportSchema: 2; reportDigest: `0x${string}`; reportTransactionHash: `0x${string}`; reportNonce: string; expiresAt: string; message: string; registrationReady: false }
export interface AuthorizationBinding { schemaVersion: 1; id: string; intentId: string; owner: string; draftId: string; revision: number; artifactId: string; manifestHash: `0x${string}`; contentDigest: `0x${string}`; maker: `0x${string}`; guard: `0x${string}`; router: `0x${string}`; strategyHash: `0x${string}`; programHash: `0x${string}`; orderHash: `0x${string}`; reportSchema: 2; reportDigest: `0x${string}`; reportTransactionHash: `0x${string}`; reportNonce: string; makerMessage: string; makerSignature: `0x${string}`; bindingDigest: `0x${string}`; registrationReady: false }

export function bindingMessage(intent: Pick<AuthorizationBindingIntent, 'owner' | 'draftId' | 'revision' | 'artifactId' | 'manifestHash' | 'contentDigest' | 'maker' | 'guard' | 'router' | 'strategyHash' | 'programHash' | 'orderHash' | 'reportSchema' | 'reportDigest' | 'reportTransactionHash' | 'reportNonce'>) {
  return ['Pintool Builder authorization binding v1', `owner: ${intent.owner.slice(7)}`, `draft: ${intent.draftId}`, `revision: ${intent.revision}`, `artifact: ${intent.artifactId}`,
    `manifestHash: ${intent.manifestHash}`, `contentDigest: ${intent.contentDigest}`, `maker: ${intent.maker}`, `guard: ${intent.guard}`, `router: ${intent.router}`,
    `strategyHash: ${intent.strategyHash}`, `programHash: ${intent.programHash}`, `orderHash: ${intent.orderHash}`, `reportSchema: ${intent.reportSchema}`,
    `reportDigest: ${intent.reportDigest}`, `reportTransactionHash: ${intent.reportTransactionHash}`, `reportNonce: ${intent.reportNonce}`].join('\n')
}
function context(profile: DeploymentProfile, draft: Awaited<ReturnType<typeof readOwnedDraft>>, artifact: Awaited<ReturnType<typeof readCompiledArtifact>>) {
  if (draft.kind !== 'maker' || draft.maker !== draft.owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
  if (!artifact.current || artifact.payload.draftId !== draft.id || artifact.payload.revision !== draft.revision) throw conflict('artifact-stale')
  if (artifact.payload.decoded.guard !== profile.guard || artifact.payload.decoded.maker !== draft.maker)
    throw new ServiceError('authorization-binding-integrity', 500)
  return { draft, artifact }
}
async function loadContext(client: PoolClient, profile: DeploymentProfile, owner: string, value: { draftId: string; expectedRevision: number; artifactId: string }) {
  const draft = await readOwnedDraft(client, owner, value.draftId, true)
  if (draft.revision !== value.expectedRevision) throw conflict('draft-changed')
  if (draft.requirements.length && !await readRequirementReceipt(client, profile, draft)) throw conflict('requirement-review-required')
  const artifact = await readCompiledArtifact(client, profile, owner, value.artifactId, true)
  return context(profile, draft, artifact)
}
export async function readAuthorizationBinding(client: Pick<PoolClient, 'query'>, owner: string, draftId: string, revision: number, artifactId: string) {
  const row = (await client.query('SELECT payload,binding_digest FROM builder.authorization_bindings WHERE owner=$1 AND draft_id=$2 AND revision=$3 AND artifact_id=$4 ORDER BY created_at DESC LIMIT 1', [owner, draftId, revision, artifactId])).rows[0]
  if (!row) return null
  const binding = row.payload as AuthorizationBinding
  if (row.binding_digest !== binding.bindingDigest || binding.owner !== owner || binding.draftId !== draftId || binding.revision !== revision || binding.artifactId !== artifactId || binding.registrationReady !== false)
    throw new ServiceError('authorization-binding-integrity', 500)
  return binding
}
function parseIntent(row: Record<string, unknown>) {
  const intent = row.payload as AuthorizationBindingIntent
  if (row.payload_digest !== digestJson(intent) || intent.id !== row.id || intent.owner !== row.owner || intent.registrationReady !== false) throw new ServiceError('authorization-binding-integrity', 500)
  return intent
}

export function createAuthorizationBindings(pool: Pool, profile: DeploymentProfile, dependencies: BindingDependencies = {}) {
  return {
    async prepare(owner: string, requestId: string, input: unknown) {
      const value = prepareSchema.parse(input); ownerSchema.parse(owner)
      if (!dependencies.verifyReport) throw new ServiceError('binding-proof-unavailable', 503)
      const loaded = await transaction(pool, client => loadContext(client, profile, owner, value))
      const proof = await dependencies.verifyReport({ owner, profile, artifact: loaded.artifact, reportDigest: value.reportDigest, reportTransactionHash: value.reportTransactionHash, reportNonce: value.reportNonce })
      if (proof.chainId !== profile.chainId || proof.maker.toLowerCase() !== owner.slice(7).toLowerCase() || proof.guard.toLowerCase() !== profile.guard.toLowerCase() ||
        proof.router.toLowerCase() !== profile.router.toLowerCase() || proof.strategyHash.toLowerCase() !== loaded.artifact.payload.strategyHash.toLowerCase() || proof.reportDigest.toLowerCase() !== value.reportDigest.toLowerCase() ||
        proof.reportTransactionHash.toLowerCase() !== value.reportTransactionHash.toLowerCase() || proof.reportNonce !== value.reportNonce || proof.reportSchema !== 2 || proof.accepted !== true) throw new ServiceError('binding-proof-mismatch', 409)
      return mutation(pool, owner, requestId, 'authorization-binding.prepare', value, async client => {
        const { draft, artifact } = await loadContext(client, profile, owner, value), decoded = artifact.payload.decoded
        const now = new Date(), expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString()
        const intent: AuthorizationBindingIntent = { schemaVersion: 1, id: randomUUID(), owner, draftId: draft.id, revision: draft.revision, artifactId: value.artifactId,
          manifestHash: artifact.payload.manifestHash, contentDigest: artifact.payload.contentDigest, maker: decoded.maker as `0x${string}`, guard: decoded.guard as `0x${string}`, router: profile.router,
          strategyHash: artifact.payload.strategyHash, programHash: artifact.payload.programHash, orderHash: artifact.payload.orderHash, reportSchema: 2, reportDigest: value.reportDigest,
          reportTransactionHash: value.reportTransactionHash, reportNonce: value.reportNonce, expiresAt, message: '', registrationReady: false }
        intent.message = bindingMessage(intent)
        const digest = digestJson(intent)
        await client.query(`INSERT INTO builder.authorization_binding_intents(id,owner,draft_id,revision,artifact_id,manifest_hash,content_digest,maker,guard,router,strategy_hash,program_hash,order_hash,report_schema,report_digest,report_transaction_hash,report_nonce,payload_digest,payload,message,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, [intent.id, owner, draft.id, draft.revision, intent.artifactId, intent.manifestHash, intent.contentDigest, intent.maker,
          intent.guard, intent.router, intent.strategyHash, intent.programHash, intent.orderHash, intent.reportSchema, intent.reportDigest, intent.reportTransactionHash, intent.reportNonce, digest, JSON.stringify(intent), intent.message, expiresAt])
        return { intent, digest, registrationReady: false as const }
      })
    },
    async confirm(owner: string, requestId: string, input: unknown) {
      const value = confirmSchema.parse(input); ownerSchema.parse(owner)
      return mutation(pool, owner, requestId, 'authorization-binding.confirm', value, async client => {
        const row = (await client.query('SELECT * FROM builder.authorization_binding_intents WHERE id=$1 AND owner=$2', [value.intentId, owner])).rows[0]
        if (!row) throw notFound()
        const intent = parseIntent(row)
        if (row.expires_at instanceof Date && row.expires_at.getTime() <= Date.now()) throw conflict('authorization-binding-expired')
        if (row.expires_at instanceof Date && row.expires_at.toISOString() !== intent.expiresAt || row.payload_digest !== value.digest || value.digest !== digestJson(intent) || intent.message !== bindingMessage(intent)) throw conflict('authorization-binding-mismatch')
        let signed = false
        try { signed = await verifyMessage({ address: owner.slice(7) as `0x${string}`, message: intent.message, signature: value.signature as `0x${string}` }) } catch { /* redact */ }
        if (!signed) throw new ServiceError('invalid-authorization-binding-signature', 403)
        const { draft, artifact } = await loadContext(client, profile, owner, { draftId: intent.draftId, expectedRevision: intent.revision, artifactId: intent.artifactId })
        if (artifact.payload.strategyHash !== intent.strategyHash) throw conflict('authorization-binding-mismatch')
        const existing = (await client.query('SELECT payload FROM builder.authorization_bindings WHERE intent_id=$1 AND owner=$2', [intent.id, owner])).rows[0]
        if (existing) return { binding: existing.payload as AuthorizationBinding, registrationReady: false as const }
        const binding: AuthorizationBinding = { schemaVersion: 1, id: randomUUID(), intentId: intent.id, owner, draftId: draft.id, revision: draft.revision, artifactId: intent.artifactId,
          manifestHash: intent.manifestHash, contentDigest: intent.contentDigest, maker: intent.maker, guard: intent.guard, router: intent.router, strategyHash: intent.strategyHash,
          programHash: intent.programHash, orderHash: intent.orderHash, reportSchema: 2, reportDigest: intent.reportDigest, reportTransactionHash: intent.reportTransactionHash,
          reportNonce: intent.reportNonce, makerMessage: intent.message, makerSignature: value.signature as `0x${string}`, bindingDigest: digestJson({ intentId: intent.id, owner, draftId: draft.id, revision: draft.revision,
            artifactId: intent.artifactId, manifestHash: intent.manifestHash, contentDigest: intent.contentDigest, maker: intent.maker, guard: intent.guard, router: intent.router, strategyHash: intent.strategyHash,
            programHash: intent.programHash, orderHash: intent.orderHash, reportSchema: 2, reportDigest: intent.reportDigest, reportTransactionHash: intent.reportTransactionHash, reportNonce: intent.reportNonce, signature: value.signature }), registrationReady: false }
        await client.query(`INSERT INTO builder.authorization_bindings(id,owner,intent_id,draft_id,revision,artifact_id,manifest_hash,content_digest,maker,guard,router,strategy_hash,program_hash,order_hash,report_schema,report_digest,report_transaction_hash,report_nonce,maker_message,maker_signature,binding_digest,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [binding.id, owner, intent.id, draft.id, draft.revision, intent.artifactId, intent.manifestHash, intent.contentDigest, intent.maker,
          intent.guard, intent.router, intent.strategyHash, intent.programHash, intent.orderHash, intent.reportSchema, intent.reportDigest, intent.reportTransactionHash, intent.reportNonce, intent.message, binding.makerSignature, binding.bindingDigest, JSON.stringify(binding)])
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'authorization-binding.confirmed',$2,$3)", [owner, binding.id, draft.revision])
        return { binding, registrationReady: false as const }
      })
    },
    async current(owner: string, draftId: string, expectedRevision: number) {
      ownerSchema.parse(owner); idSchema.parse(draftId); revisionSchema.parse(expectedRevision)
      return transaction(pool, async client => {
        const draft = await readOwnedDraft(client, owner, draftId, true)
        if (draft.revision !== expectedRevision) throw conflict('draft-changed')
        const row = (await client.query('SELECT * FROM builder.authorization_bindings WHERE owner=$1 AND draft_id=$2 AND revision=$3 ORDER BY created_at DESC LIMIT 1', [owner, draftId, expectedRevision])).rows[0]
        if (!row) return { binding: null, revision: draft.revision, registrationReady: false as const }
        const binding = row.payload as AuthorizationBinding
        if (row.binding_digest !== binding.bindingDigest || binding.owner !== owner || binding.draftId !== draftId || binding.revision !== expectedRevision || binding.registrationReady !== false)
          throw new ServiceError('authorization-binding-integrity', 500)
        const artifact = await readCompiledArtifact(client, profile, owner, binding.artifactId, true)
        if (!artifact.current || artifact.payload.draftId !== draftId || artifact.payload.revision !== expectedRevision || artifact.payload.manifestHash !== binding.manifestHash || artifact.payload.contentDigest !== binding.contentDigest || artifact.payload.strategyHash !== binding.strategyHash || artifact.payload.programHash !== binding.programHash || artifact.payload.orderHash !== binding.orderHash)
          throw new ServiceError('authorization-binding-integrity', 500)
        return { binding, revision: draft.revision, registrationReady: false as const }
      })
    },
  }
}
