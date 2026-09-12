import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { compileBuilderStrategy } from 'aqua-executor/builder'
import { canonical, contentDigest, decodeGuardedOrder, digestJson, draftSchema, idSchema, revisionSchema, validateStrategy,
  type DeploymentProfile } from '@pintool/strategy-builder'
import { assertTurnLease, type TurnLease } from './turn-lease.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'

const inputSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema }).strict()
export type CompiledPayload = ReturnType<typeof compileBuilderStrategy>
export interface CompiledReference { artifactId: string; draftId: string; revision: number; mode: 'compiled-order' }

/** Share the caller's transaction/connection so queue mutations never acquire a second pooled connection. */
export async function readCompiledArtifact(connection: Pick<PoolClient, 'query'>, profile: DeploymentProfile, owner: string, artifactId: string, lockDraft = false) {
  ownerSchema.parse(owner); idSchema.parse(artifactId)
  const row = (await connection.query(`SELECT a.*,d.snapshot AS current_snapshot,d.digest AS current_digest
    FROM builder.compiled_artifacts a JOIN builder.drafts d ON d.id=a.draft_id AND d.owner=a.owner
    WHERE a.id=$1 AND a.owner=$2${lockDraft ? ' FOR UPDATE OF d' : ''}`, [artifactId, owner])).rows[0]
  if (!row) throw notFound()
  const payload = row.payload as CompiledPayload, draft = draftSchema.parse(row.current_snapshot)
  if (draft.owner !== owner || draft.id !== row.draft_id || row.current_digest !== contentDigest(draft) ||
    row.payload_digest !== digestJson(payload) || payload.draftId !== draft.id || payload.revision !== Number(row.revision) ||
    payload.manifestHash !== row.manifest_hash || payload.contentDigest !== row.content_digest ||
    canonical(decodeGuardedOrder(payload.strategy)) !== canonical(payload.decoded)) throw new ServiceError('compiled-artifact-integrity', 500)
  const current = draft.revision === payload.revision && contentDigest(draft) === payload.contentDigest &&
    digestJson(profile) === payload.manifestHash && validateStrategy(draft, profile, Math.floor(Date.now() / 1000)).ready
  return { artifactId, mode: 'compiled-order' as const, current, payload, draft, createdAt: (row.created_at as Date).toISOString(), registrationReady: false as const }
}

/** Public, deterministic compilation only. No RPC, signing, registration or report delivery. */
export function createArtifacts(pool: Pool, profile: DeploymentProfile, lease?: TurnLease) {
  return {
    async compile(owner: string, requestId: string, input: unknown): Promise<CompiledReference> {
      const value = inputSchema.parse(input)
      return mutation(pool, owner, requestId, 'artifact.compile', value, async client => {
        const row = (await client.query('SELECT snapshot,digest FROM builder.drafts WHERE id=$1 AND owner=$2 FOR UPDATE', [value.draftId, owner])).rows[0]
        if (!row) throw notFound()
        const draft = draftSchema.parse(row.snapshot)
        if (draft.id !== value.draftId || draft.owner !== owner || row.digest !== contentDigest(draft)) throw new ServiceError('stored-draft-integrity', 500)
        if (lease) await assertTurnLease(client, draft, lease)
        if (draft.revision !== value.expectedRevision) throw conflict('draft-changed')
        if (draft.kind !== 'maker') throw new ServiceError('maker-instance-required')
        if (draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
        const now = Math.floor(Date.now() / 1000)
        if (!validateStrategy(draft, profile, now).ready) throw new ServiceError('strategy-incomplete-or-invalid')
        let payload: CompiledPayload
        try { payload = compileBuilderStrategy(draft, profile, now) } catch { throw new ServiceError('compile-rejected') }
        const manifestHash = digestJson(profile), payloadDigest = digestJson(payload)
        if (payload.contentDigest !== row.digest || payload.manifestHash !== manifestHash || payload.revision !== draft.revision || payload.draftId !== draft.id) throw new ServiceError('compiled-artifact-integrity', 500)
        const inserted = await client.query(`INSERT INTO builder.compiled_artifacts(id,owner,draft_id,revision,manifest_hash,content_digest,payload_digest,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (draft_id,revision,manifest_hash) DO NOTHING RETURNING id`,
        [randomUUID(), owner, draft.id, draft.revision, manifestHash, row.digest, payloadDigest, JSON.stringify(payload)])
        const saved = (await client.query('SELECT id,payload_digest FROM builder.compiled_artifacts WHERE draft_id=$1 AND revision=$2 AND manifest_hash=$3 AND owner=$4',
          [draft.id, draft.revision, manifestHash, owner])).rows[0]
        if (!saved || saved.payload_digest !== payloadDigest) throw new ServiceError('compiled-artifact-integrity', 500)
        if (inserted.rowCount) await client.query(`INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,'artifact.compiled',$2,$3)`, [owner, saved.id, draft.revision])
        return { artifactId: saved.id, draftId: draft.id, revision: draft.revision, mode: 'compiled-order' }
      })
    },
    async get(owner: string, artifactId: string) {
      const { draft: _draft, ...artifact } = await readCompiledArtifact(pool, profile, owner, artifactId)
      return artifact
    },
    async list(owner: string, draftId: string) {
      ownerSchema.parse(owner); idSchema.parse(draftId)
      if (!(await pool.query('SELECT id FROM builder.drafts WHERE id=$1 AND owner=$2', [draftId, owner])).rowCount) throw notFound()
      return (await pool.query(`SELECT id AS "artifactId",revision::text,manifest_hash AS "manifestHash",created_at AS "createdAt"
        FROM builder.compiled_artifacts WHERE draft_id=$1 AND owner=$2 ORDER BY builder.compiled_artifacts.revision DESC,created_at DESC LIMIT 100`, [draftId, owner])).rows
    },
  }
}
