import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { compileBuilderStrategy } from 'aqua-executor/builder'
import { acknowledgeRequirements, assessRequirementCriteria, canonical, contentDigest, digestJson, hashSchema, idSchema,
  requirementDecisionsSchema, revisionSchema, validateStrategy, type DeploymentProfile, type StrategyDraft } from '@pintool/strategy-builder'
import { readCompiledArtifact } from './artifacts.ts'
import { readOwnedDraft, persistDraftChange } from './draft-persistence.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'
import { transaction } from './database.ts'

const prepareSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema }).strict()
const confirmSchema = z.object({ reviewId: idSchema, digest: hashSchema, decisions: requirementDecisionsSchema }).strict()
type Connection = Pick<PoolClient, 'query'>
const engineVersion = 'builder-requirement-review-v1'

/** Read-only current acceptance projection. An old boolean in a draft is never a
 * substitute for this exact revision/content/manifest receipt. */
export async function readRequirementReceipt(client: Connection, profile: DeploymentProfile, draft: StrategyDraft) {
  const row = (await client.query(`SELECT payload,payload_digest FROM builder.requirement_review_receipts
    WHERE owner=$1 AND draft_id=$2 AND revision=$3 AND manifest_hash=$4 AND content_digest=$5 ORDER BY created_at DESC,intent_id DESC LIMIT 1`,
    [draft.owner, draft.id, draft.revision, digestJson(profile), contentDigest(draft)])).rows[0]
  if (!row) return null
  const payload = row.payload as RequirementReceipt
  if (digestJson(payload) !== row.payload_digest || payload.draftId !== draft.id || payload.revision !== draft.revision ||
    payload.contentDigest !== contentDigest(draft) || payload.manifestHash !== digestJson(profile) || payload.owner !== draft.owner ||
    payload.engineVersion !== engineVersion || payload.registrationReady !== false) throw new ServiceError('requirement-review-integrity', 500)
  return payload
}
export interface RequirementReceipt {
  schemaVersion: 1; engineVersion: string; reviewId: string; reviewDigest: string; owner: string;
  draftId: string; fromRevision: number; revision: number; contentDigest: string; manifestHash: string;
  decisions: z.infer<typeof requirementDecisionsSchema>; userConfirmed: true; needsRecompile: boolean;
  confirmedAt: string; registrationReady: false;
}

async function compilation(client: PoolClient, profile: DeploymentProfile, draft: StrategyDraft) {
  if (draft.kind === 'template') return null
  const row = (await client.query('SELECT id FROM builder.compiled_artifacts WHERE owner=$1 AND draft_id=$2 AND revision=$3 AND manifest_hash=$4',
    [draft.owner, draft.id, draft.revision, digestJson(profile)])).rows[0]
  if (!row) throw conflict('requirement-compilation-required')
  const saved = await readCompiledArtifact(client, profile, draft.owner, row.id)
  if (!saved.current || canonical(compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000))) !== canonical(saved.payload))
    throw new ServiceError('requirement-artifact-integrity', 500)
  return { artifactId: row.id as string, digest: digestJson(saved.payload), programHash: saved.payload.programHash,
    strategyHash: saved.payload.strategyHash, decoded: saved.payload.decoded }
}
async function assertReviewable(client: PoolClient, profile: DeploymentProfile, draft: StrategyDraft) {
  if (draft.spec.profileId !== profile.id || !validateStrategy(draft, profile, Math.floor(Date.now() / 1000)).ready)
    throw new ServiceError('strategy-incomplete-or-invalid')
  if (draft.kind === 'maker' && draft.maker !== draft.owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
  if ((await client.query("SELECT id FROM builder.agent_turns WHERE owner=$1 AND draft_id=$2 AND state IN ('queued','running')", [draft.owner, draft.id])).rowCount)
    throw conflict('agent-turn-active')
  const rows = assessRequirementCriteria(draft)
  if (rows.some(r => r.needsInterpretation || r.criteria.some(c => c.criterion.type === 'parameter' && (c.matchesDraft === null || c.evidence === 'unavailable'))))
    throw conflict('requirement-interpretation-required')
  return rows
}
export function createRequirementReviews(pool: Pool, profile: DeploymentProfile) {
  return {
    async prepare(owner: string, requestId: string, input: unknown) {
      const value = prepareSchema.parse(input)
      return mutation(pool, owner, requestId, 'requirement-review.prepare', value, async client => {
        const draft = await readOwnedDraft(client, owner, value.draftId, true)
        if (draft.revision !== value.expectedRevision) throw conflict('draft-changed')
        const requirements = await assertReviewable(client, profile, draft), compiled = await compilation(client, profile, draft)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8))', [owner])
        const count = (await client.query("SELECT count(*)::integer AS count FROM builder.requirement_review_intents WHERE owner=$1 AND created_at>clock_timestamp()-interval '1 hour'", [owner])).rows[0].count
        if (count >= 60) throw new ServiceError('requirement-review-budget', 429)
        const now = new Date(), id = randomUUID(), expiresAt = new Date(now.getTime() + 600000).toISOString()
        const review = { schemaVersion: 1 as const, engineVersion, id, owner, draftId: draft.id, revision: draft.revision,
          contentDigest: contentDigest(draft), manifestHash: digestJson(profile), draft, requirements, compilation: compiled,
          expiresAt, registrationReady: false as const }
        const digest = digestJson(review)
        await client.query(`INSERT INTO builder.requirement_review_intents(id,owner,draft_id,revision,manifest_hash,content_digest,artifact_id,payload_digest,payload,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, owner, draft.id, draft.revision, review.manifestHash, review.contentDigest, compiled?.artifactId ?? null, digest, JSON.stringify(review), expiresAt])
        return { review, digest }
      })
    },
    async confirm(owner: string, requestId: string, input: unknown) {
      const value = confirmSchema.parse(input)
      return mutation(pool, owner, requestId, 'requirement-review.confirm', value, async client => {
        const row = (await client.query('SELECT * FROM builder.requirement_review_intents WHERE id=$1 AND owner=$2', [value.reviewId, owner])).rows[0]
        if (!row) throw notFound()
        const before = await readOwnedDraft(client, owner, row.draft_id, true)
        const decisionDigest = digestJson([...value.decisions].sort((a, b) => a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0))
        const completed = (await client.query('SELECT * FROM builder.requirement_review_receipts WHERE intent_id=$1 AND owner=$2', [value.reviewId, owner])).rows[0]
        if (completed) {
          if (completed.decision_digest !== decisionDigest || completed.payload.reviewDigest !== value.digest) throw conflict('requirement-review-already-confirmed')
          if (completed.payload_digest !== digestJson(completed.payload)) throw new ServiceError('requirement-review-integrity', 500)
          return { receipt: completed.payload as RequirementReceipt }
        }
        const review = row.payload as Awaited<ReturnType<ReturnType<typeof createRequirementReviews>['prepare']>>['review']
        if (row.payload_digest !== value.digest || row.payload_digest !== digestJson(review) || review.id !== value.reviewId || review.owner !== owner ||
          review.draftId !== before.id || review.revision !== Number(row.revision) || review.engineVersion !== engineVersion ||
          review.manifestHash !== digestJson(profile) || review.contentDigest !== row.content_digest ||
          review.manifestHash !== row.manifest_hash || contentDigest(review.draft) !== review.contentDigest ||
          (row.expires_at as Date).toISOString() !== review.expiresAt) throw conflict('requirement-review-mismatch')
        if ((row.expires_at as Date).getTime() <= Date.now()) throw conflict('requirement-review-expired')
        if (before.revision !== review.revision || contentDigest(before) !== review.contentDigest) throw conflict('draft-changed')
        const requirements = await assertReviewable(client, profile, before), compiled = await compilation(client, profile, before)
        if (canonical(requirements) !== canonical(review.requirements) || canonical(compiled) !== canonical(review.compilation)) throw conflict('requirement-review-mismatch')
        const result = acknowledgeRequirements(before, value.decisions, { owner, expectedRevision: before.revision, now: new Date().toISOString() })
        const { draft } = await persistDraftChange(client, before, result)
        const receipt: RequirementReceipt = { schemaVersion: 1, engineVersion, reviewId: value.reviewId, reviewDigest: value.digest, owner,
          draftId: draft.id, fromRevision: before.revision, revision: draft.revision, contentDigest: contentDigest(draft), manifestHash: digestJson(profile),
          decisions: value.decisions, userConfirmed: true, needsRecompile: draft.kind === 'maker' && result.changed,
          confirmedAt: new Date().toISOString(), registrationReady: false }
        await client.query(`INSERT INTO builder.requirement_review_receipts(intent_id,owner,draft_id,revision,manifest_hash,content_digest,decision_digest,payload_digest,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [receipt.reviewId, owner, draft.id, draft.revision, receipt.manifestHash, receipt.contentDigest, decisionDigest, digestJson(receipt), JSON.stringify(receipt)])
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'requirements.confirmed',$2,$3)", [owner, receipt.reviewId, draft.revision])
        return { receipt }
      })
    },
    async current(owner: string, draftId: string, expectedRevision: number) {
      ownerSchema.parse(owner); idSchema.parse(draftId); revisionSchema.parse(expectedRevision)
      return transaction(pool, async client => {
        const draft = await readOwnedDraft(client, owner, draftId, true)
        if (draft.revision !== expectedRevision) throw conflict('draft-changed')
        return { receipt: await readRequirementReceipt(client, profile, draft), revision: draft.revision, registrationReady: false as const }
      })
    },
  }
}
