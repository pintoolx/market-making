import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { contentDigest, digestJson, draftSchema, idSchema, revisionSchema, validateStrategy, type DeploymentProfile } from '@pintool/strategy-builder'
import { previewBuilderScenarios, previewEngine, scenarioInputSchema } from 'aqua-executor/builder-preview'
import { assertTurnLease, type TurnLease } from './turn-lease.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'

const inputSchema = scenarioInputSchema.extend({ draftId: idSchema, expectedRevision: revisionSchema }).strict()
type Preview = ReturnType<typeof previewBuilderScenarios>
interface PreviewRow {
  id: string; owner: string; draft_id: string; revision: string; manifest_hash: string; content_digest: string; engine_version: string;
  input_digest: string; inputs: unknown; payload_digest: string; payload: Preview; created_at: Date; snapshot: unknown; digest: string;
}

export function createPreviews(pool: Pool, profile: DeploymentProfile, lease?: TurnLease) {
  const publicRecord = (row: PreviewRow) => {
    const payload = row.payload as Preview, draft = draftSchema.parse(row.snapshot)
    if (row.digest !== contentDigest(draft) || row.content_digest !== payload.contentDigest || row.payload_digest !== digestJson(payload) ||
      row.owner !== draft.owner || payload.draftId !== row.draft_id || payload.revision !== Number(row.revision) || row.input_digest !== digestJson(row.inputs) ||
      payload.inputDigest !== row.input_digest || payload.manifestHash !== row.manifest_hash || payload.engineVersion !== row.engine_version) throw new ServiceError('preview-integrity', 500)
    return { previewId: row.id as string, current: draft.revision === payload.revision && contentDigest(draft) === payload.contentDigest &&
      payload.manifestHash === digestJson(profile) && payload.engineVersion === previewEngine && validateStrategy(draft, profile, Math.floor(Date.now() / 1000)).ready,
      createdAt: (row.created_at as Date).toISOString(), payload }
  }
  return {
    async preview(owner: string, requestId: string, input: unknown) {
      const { draftId, expectedRevision, ...options } = inputSchema.parse(input)
      return mutation(pool, owner, requestId, 'scenario.preview', { draftId, expectedRevision, ...options }, async client => {
        // Serialize the owner's shared budget across different drafts/processes.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['builder-preview:' + owner])
        const row = (await client.query('SELECT snapshot,digest FROM builder.drafts WHERE id=$1 AND owner=$2 FOR UPDATE', [draftId, owner])).rows[0]
        if (!row) throw notFound()
        const draft = draftSchema.parse(row.snapshot)
        if (draft.id !== draftId || draft.owner !== owner || row.digest !== contentDigest(draft)) throw new ServiceError('stored-draft-integrity', 500)
        if (lease) await assertTurnLease(client, draft, lease)
        if (draft.revision !== expectedRevision) throw conflict('draft-changed')
        if (draft.kind === 'maker' && draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
        const now = Math.floor(Date.now() / 1000)
        if (!validateStrategy(draft, profile, now).ready) throw new ServiceError('strategy-incomplete-or-invalid')
        const manifestHash = digestJson(profile), inputDigest = digestJson(options)
        const previous = (await client.query(`SELECT id FROM builder.scenario_previews WHERE draft_id=$1 AND revision=$2 AND
          manifest_hash=$3 AND engine_version=$4 AND input_digest=$5`, [draftId, expectedRevision, manifestHash, previewEngine, inputDigest])).rows[0]
        if (previous) return { previewId: previous.id as string, draftId, revision: expectedRevision, mode: 'mathematical-preview' as const }
        const count = (await client.query("SELECT count(*)::int AS count FROM builder.scenario_previews WHERE owner=$1 AND created_at>clock_timestamp()-interval '1 hour'", [owner])).rows[0].count
        if (count >= 60) throw new ServiceError('preview-budget-exhausted', 429)
        let payload: Preview
        try { payload = previewBuilderScenarios(draft, profile, options, now) } catch (error) {
          const message = error instanceof Error ? error.message : ''
          throw new ServiceError(['hypothetical-allocation-required','maker-allocation-override-forbidden','duplicate-scenario-name'].includes(message) ? message : 'preview-input-rejected')
        }
        const previewId = randomUUID()
        await client.query(`INSERT INTO builder.scenario_previews(id,owner,draft_id,revision,manifest_hash,content_digest,engine_version,input_digest,inputs,payload_digest,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [previewId, owner, draftId, expectedRevision, manifestHash, row.digest, previewEngine,
          inputDigest, JSON.stringify(options), digestJson(payload), JSON.stringify(payload)])
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,'scenario.previewed',$2,$3)", [owner, previewId, expectedRevision])
        if (lease) await assertTurnLease(client, draft, lease)
        return { previewId, draftId, revision: expectedRevision, mode: 'mathematical-preview' as const }
      })
    },
    async get(owner: string, previewId: string) {
      ownerSchema.parse(owner); idSchema.parse(previewId)
      const row = (await pool.query(`SELECT p.*,d.snapshot,d.digest FROM builder.scenario_previews p
        JOIN builder.drafts d ON d.id=p.draft_id AND d.owner=p.owner WHERE p.id=$1 AND p.owner=$2`, [previewId, owner])).rows[0]
      if (!row) throw notFound()
      return publicRecord(row)
    },
    async list(owner: string, draftId: string) {
      ownerSchema.parse(owner); idSchema.parse(draftId)
      if (!(await pool.query('SELECT id FROM builder.drafts WHERE id=$1 AND owner=$2', [draftId, owner])).rowCount) throw notFound()
      return (await pool.query(`SELECT p.*,d.snapshot,d.digest FROM builder.scenario_previews p
        JOIN builder.drafts d ON d.id=p.draft_id AND d.owner=p.owner WHERE p.draft_id=$1 AND p.owner=$2 ORDER BY p.created_at DESC,p.id DESC LIMIT 12`, [draftId, owner])).rows.map((row: PreviewRow) => {
        const { payload, ...record } = publicRecord(row)
        return { ...record, revision: payload.revision, mode: payload.mode, model: payload.model, inputDigest: payload.inputDigest,
          allocationSource: payload.allocationSource, allocations: payload.allocations, observations: payload.observations,
          scenarios: payload.scenarios.map(s => ({ name: s.name, tradeCount: s.trades.length,
            admittedCount: s.trades.filter(t => t.admittedUnderAssumptions).length, finalBalances: s.finalBalances,
            rejections: s.trades.flatMap((t, index) => t.reasons.length ? [{ index, reasons: t.reasons }] : []) })), registrationReady: false }
      })
    },
  }
}
