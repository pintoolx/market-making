import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { contentDigest, draftSchema, patchDraft, patchSchema, restoreDraft, idSchema, revisionSchema,
  type StrategyDraft, type Diff } from '@pintool/strategy-builder'
import { transaction } from './database.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { assertTurnLease, supersedeTurns, type TurnLease } from './turn-lease.ts'

import { mutation as transactRequest, ownerSchema } from './requests.ts'
const createSchema = z.object({ title: z.string().min(1).max(120), kind: z.enum(['template', 'maker']) }).strict()
const editSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema, patch: patchSchema }).strict()
const restoreSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema, revision: revisionSchema }).strict()
const messageSchema = z.object({ conversationId: idSchema, content: z.string().trim().min(1).max(16000) }).strict()
interface DraftRow { snapshot: unknown; digest: string }

/** Internal repository: owner is taken from a verified server session, never an HTTP body or model tool argument. */
export function createStore(pool: Pool, profileId: string, lease?: TurnLease) {
  idSchema.parse(profileId)

  async function mutation<T>(owner: string, requestId: string, operation: string, input: unknown, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return transactRequest(pool, owner, requestId, operation, input, work)
  }

  async function read(client: Pick<PoolClient, 'query'>, owner: string, id: string, lock = false) {
    ownerSchema.parse(owner); idSchema.parse(id)
    const row = (await client.query<DraftRow>(`SELECT snapshot, digest FROM builder.drafts WHERE id=$1 AND owner=$2${lock ? ' FOR UPDATE' : ''}`, [id, owner])).rows[0]
    if (!row) throw notFound()
    const draft = draftSchema.parse(row.snapshot)
    if (draft.owner !== owner || draft.id !== id || row.digest !== contentDigest(draft)) throw new ServiceError('stored-draft-integrity', 500)
    if (lease && lock) await assertTurnLease(client as PoolClient, draft, lease)
    return draft
  }
  async function saveRevision(client: PoolClient, draft: StrategyDraft, diff: Diff[]) {
    await client.query('INSERT INTO builder.draft_revisions(draft_id, owner, revision, snapshot, digest, diff) VALUES ($1,$2,$3,$4,$5,$6)',
      [draft.id, draft.owner, draft.revision, JSON.stringify(draft), contentDigest(draft), JSON.stringify(diff)])
    await client.query('INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,$2,$3,$4)', [draft.owner, 'draft.changed', draft.id, draft.revision])
  }
  async function update(client: PoolClient, before: StrategyDraft, result: ReturnType<typeof patchDraft>) {
    if (!result.changed) return result
    const { draft, diff } = result
    const saved = await client.query(`UPDATE builder.drafts SET snapshot=$4, digest=$5, revision=$6, updated_at=clock_timestamp()
      WHERE id=$1 AND owner=$2 AND revision=$3 RETURNING conversation_id`,
    [draft.id, draft.owner, before.revision, JSON.stringify(draft), contentDigest(draft), draft.revision])
    if (saved.rowCount !== 1) throw conflict()
    await saveRevision(client, draft, diff)
    if (lease) {
      await client.query('UPDATE builder.agent_turns SET last_revision=$2 WHERE id=$1', [lease.turnId, draft.revision])
    } else await supersedeTurns(client, draft.owner, draft.id)
    await client.query('UPDATE builder.conversations SET title=$3, updated_at=clock_timestamp() WHERE id=$1 AND owner=$2', [saved.rows[0].conversation_id, draft.owner, draft.spec.title])
    // Confirmations must also check their revision. Cancel only work that has not started;
    // running work reconciles its lease and revision before committing a result.
    await client.query(`UPDATE builder.jobs SET state='cancelled', completed_at=clock_timestamp()
      WHERE owner=$1 AND resource_id=$2 AND kind='simulation' AND generation<$3 AND state='pending'`, [draft.owner, draft.id, draft.revision])
    return result
  }
  return {
    async create(owner: string, requestId: string, input: unknown) {
      const value = createSchema.parse(input)
      return mutation(owner, requestId, 'draft.create', value, async client => {
        const now = new Date().toISOString(), conversationId = randomUUID()
        const draft = draftSchema.parse({ schemaVersion: 1, id: randomUUID(), owner, revision: 1, kind: value.kind,
          ...(value.kind === 'maker' ? { maker: owner.slice(7) } : {}),
          spec: { title: value.title, profileId, modifiers: [] }, requirements: [],
          salt: BigInt('0x' + randomBytes(8).toString('hex')).toString(), createdAt: now, updatedAt: now })
        await client.query('INSERT INTO builder.conversations(id, owner, title) VALUES ($1,$2,$3)', [conversationId, owner, value.title])
        await client.query('INSERT INTO builder.drafts(id, owner, conversation_id, revision, snapshot, digest) VALUES ($1,$2,$3,1,$4,$5)',
          [draft.id, owner, conversationId, JSON.stringify(draft), contentDigest(draft)])
        await saveRevision(client, draft, [])
        return { conversationId, draft }
      })
    },
    get(owner: string, draftId: string) {
      return lease ? transaction(pool, client => read(client, owner, draftId, true)) : read(pool, owner, draftId)
    },
    async list(owner: string) {
      ownerSchema.parse(owner)
      return (await pool.query(`SELECT c.id AS "conversationId", c.title, c.updated_at AS "updatedAt", d.id AS "draftId", d.revision::text,
        t.id AS "activeTurnId",t.state AS "activeTurnState"
        FROM builder.conversations c JOIN builder.drafts d ON d.conversation_id=c.id AND d.owner=c.owner
        LEFT JOIN builder.agent_turns t ON t.draft_id=d.id AND t.owner=d.owner AND t.state IN ('queued','running')
        WHERE c.owner=$1 ORDER BY c.updated_at DESC, c.id LIMIT 100`, [owner])).rows
    },
    async patch(owner: string, requestId: string, input: unknown) {
      const value = editSchema.parse(input)
      if (value.patch.maker && value.patch.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
      return mutation(owner, requestId, 'draft.patch', value, async client => {
        const before = await read(client, owner, value.draftId, true)
        return update(client, before, patchDraft(before, value.patch, { owner, expectedRevision: value.expectedRevision, now: new Date().toISOString() }))
      })
    },
    async restore(owner: string, requestId: string, input: unknown) {
      const value = restoreSchema.parse(input)
      return mutation(owner, requestId, 'draft.restore', value, async client => {
        const before = await read(client, owner, value.draftId, true)
        const row = (await client.query<DraftRow>('SELECT snapshot, digest FROM builder.draft_revisions WHERE draft_id=$1 AND owner=$2 AND revision=$3',
          [value.draftId, owner, value.revision])).rows[0]
        if (!row) throw notFound()
        const saved = draftSchema.parse(row.snapshot)
        if (row.digest !== contentDigest(saved)) throw new ServiceError('stored-draft-integrity', 500)
        return update(client, before, restoreDraft(before, saved, { owner, expectedRevision: value.expectedRevision, now: new Date().toISOString() }))
      })
    },
    async history(owner: string, draftId: string) {
      await read(pool, owner, draftId)
      const rows = (await pool.query('SELECT revision::text, digest, diff, created_at AS "createdAt" FROM builder.draft_revisions WHERE draft_id=$1 AND owner=$2 ORDER BY builder.draft_revisions.revision DESC LIMIT 100', [draftId, owner])).rows
      // PostgreSQL timestamps are Date objects. Model tool results must be JSON values.
      return rows.map(row => ({ revision: row.revision as string, digest: row.digest as string, diff: row.diff as Diff[], createdAt: (row.createdAt as Date).toISOString() }))
    },
    async appendUserMessage(owner: string, requestId: string, input: unknown) {
      const value = messageSchema.parse(input)
      return mutation(owner, requestId, 'message.user', value, async client => {
        const draft = (await client.query('SELECT id FROM builder.drafts WHERE conversation_id=$1 AND owner=$2 FOR UPDATE', [value.conversationId, owner])).rows[0]
        if (!draft) throw notFound()
        await supersedeTurns(client, owner, draft.id)
        const conversation = (await client.query('SELECT id FROM builder.conversations WHERE id=$1 AND owner=$2 FOR UPDATE', [value.conversationId, owner])).rows[0]
        if (!conversation) throw notFound()
        const messageId = randomUUID()
        const row = (await client.query(`INSERT INTO builder.messages(id,conversation_id,owner,role,content) VALUES ($1,$2,$3,'user',$4)
          RETURNING id, role, content, sequence::text, created_at AS "createdAt"`, [messageId, value.conversationId, owner, value.content])).rows[0]
        await client.query('UPDATE builder.conversations SET updated_at=clock_timestamp() WHERE id=$1 AND owner=$2', [value.conversationId, owner])
        await client.query(`INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,'message.created',$2,1)`, [owner, messageId])
        return row
      })
    },
    async messages(owner: string, conversationId: string, beforeSequence?: string) {
      ownerSchema.parse(owner); idSchema.parse(conversationId)
      if (beforeSequence !== undefined && !/^[1-9][0-9]{0,15}$/.test(beforeSequence)) throw new ServiceError('invalid-cursor')
      const exists = await pool.query('SELECT id FROM builder.conversations WHERE id=$1 AND owner=$2', [conversationId, owner])
      if (!exists.rowCount) throw notFound()
      const rows = (await pool.query(`SELECT id,role,content,sequence::text,created_at AS "createdAt" FROM builder.messages
        WHERE conversation_id=$1 AND owner=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint) ORDER BY builder.messages.sequence DESC LIMIT 100`, [conversationId, owner, beforeSequence ?? null])).rows
      return rows.reverse()
    },
  }
}
