import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { digestJson, draftSchema, idSchema, revisionSchema } from '@pintool/strategy-builder'
import { transaction } from './database.ts'
import { conflict, notFound } from './errors.ts'
import { assertTurnLease, type TurnLease } from './turn-lease.ts'

const ownerSchema = z.string().regex(/^wallet:0x[0-9a-f]{40}$/)
const acceptSchema = z.object({ conversationId: idSchema, expectedRevision: revisionSchema,
  content: z.string().trim().min(1).max(8000) }).strict()
const leaseMsSchema = z.number().int().min(100).max(300000)
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), payload: z.object({ text: z.string().max(2000) }).strict() }).strict(),
  // Never persist raw SDK events, request headers, model reasoning, tool inputs or arbitrary output objects.
  z.object({ kind: z.literal('tool'), payload: z.object({ name: idSchema, ok: z.boolean() }).strict() }).strict(),
])
export interface ClaimedTurn extends TurnLease {
  owner: string; draftId: string; conversationId: string; sourceMessageId: string; attempt: number
}

export function createTurns(pool: Pool) {
  async function locked(client: PoolClient, turn: ClaimedTurn) {
    const row = (await client.query('SELECT snapshot FROM builder.drafts WHERE id=$1 AND owner=$2 FOR UPDATE', [turn.draftId, turn.owner])).rows[0]
    if (!row) throw notFound()
    const draft = draftSchema.parse(row.snapshot)
    await assertTurnLease(client, draft, turn)
    return draft
  }
  async function event(client: PoolClient, turn: { id: string; owner: string; attempts: number }, kind: string, payload: unknown = {}) {
    await client.query('INSERT INTO builder.agent_events(turn_id,owner,attempt,kind,payload) VALUES($1,$2,$3,$4,$5)',
      [turn.id, turn.owner, turn.attempts, kind, JSON.stringify(payload)])
  }
  return {
    async accept(owner: string, requestId: string, input: unknown) {
      ownerSchema.parse(owner); idSchema.parse(requestId)
      const value = acceptSchema.parse(input), digest = digestJson(value)
      return transaction(pool, async client => {
        // Serializes duplicate request keys even if a retry changes the conversation.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner + ':' + requestId])
        const previous = (await client.query(`SELECT id,message_id AS "messageId",accepted_revision::text AS revision,input_digest
          FROM builder.agent_turns WHERE owner=$1 AND request_id=$2`, [owner, requestId])).rows[0]
        if (previous) {
          if (previous.input_digest !== digest) throw conflict('idempotency-key-reused')
          return { id: previous.id as string, messageId: previous.messageId as string, revision: Number(previous.revision) }
        }
        const draft = (await client.query('SELECT id,revision::text FROM builder.drafts WHERE conversation_id=$1 AND owner=$2 FOR UPDATE', [value.conversationId, owner])).rows[0]
        if (!draft) throw notFound()
        if (Number(draft.revision) !== value.expectedRevision) throw conflict('draft-changed')
        if ((await client.query("SELECT id FROM builder.agent_turns WHERE draft_id=$1 AND state IN ('queued','running')", [draft.id])).rowCount) throw conflict('agent-turn-active')
        // A bounded shared limit applies across replicas; failed/cancelled attempts count too.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [owner])
        const used = (await client.query("SELECT count(*)::integer AS count FROM builder.agent_turns WHERE owner=$1 AND created_at>clock_timestamp()-interval '1 hour'", [owner])).rows[0].count
        if (used >= 60) throw conflict('agent-hourly-budget')
        const id = randomUUID(), messageId = randomUUID()
        await client.query("INSERT INTO builder.messages(id,conversation_id,owner,role,content) VALUES($1,$2,$3,'user',$4)", [messageId, value.conversationId, owner, value.content])
        await client.query(`INSERT INTO builder.agent_turns(id,owner,conversation_id,draft_id,message_id,request_id,input_digest,accepted_revision,last_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, owner, value.conversationId, draft.id, messageId, requestId, digest, value.expectedRevision])
        await client.query('UPDATE builder.conversations SET updated_at=clock_timestamp() WHERE id=$1 AND owner=$2', [value.conversationId, owner])
        return { id, messageId, revision: value.expectedRevision }
      })
    },
    async claim(leaseMs = 30000): Promise<ClaimedTurn | null> {
      leaseMsSchema.parse(leaseMs)
      return transaction(pool, async client => {
        // Claim the draft first so a simultaneous user edit cannot invert row-lock order.
        const candidate = (await client.query(`SELECT d.id FROM builder.drafts d JOIN builder.agent_turns t ON t.draft_id=d.id
          WHERE t.state='queued' OR (t.state='running' AND t.lease_until<clock_timestamp())
          ORDER BY t.created_at,t.id FOR UPDATE OF d SKIP LOCKED LIMIT 1`)).rows[0]
        if (!candidate) return null
        const t = (await client.query("SELECT * FROM builder.agent_turns WHERE draft_id=$1 AND (state='queued' OR (state='running' AND lease_until<clock_timestamp())) FOR UPDATE", [candidate.id])).rows[0]
        if (!t) return null
        if (t.attempts >= 3) {
          await client.query("UPDATE builder.agent_turns SET state='failed',error_code='retry-limit',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1", [t.id])
          await event(client, t, 'failed', { errorCode: 'retry-limit' }); return null
        }
        const token = randomUUID()
        await client.query(`UPDATE builder.agent_turns SET state='running',attempts=attempts+1,lease_token=$2,
          lease_until=clock_timestamp()+$3::integer*interval '1 millisecond' WHERE id=$1`, [t.id, token, leaseMs])
        await event(client, { ...t, attempts: t.attempts + 1 }, 'started', { resetText: true })
        return { turnId: t.id, leaseToken: token, owner: t.owner, draftId: t.draft_id, conversationId: t.conversation_id,
          sourceMessageId: t.message_id, attempt: t.attempts + 1 }
      })
    },
    async heartbeat(turn: ClaimedTurn, leaseMs = 30000) {
      leaseMsSchema.parse(leaseMs)
      const r = await pool.query(`UPDATE builder.agent_turns SET lease_until=clock_timestamp()+$3::integer*interval '1 millisecond'
        WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`, [turn.turnId, turn.leaseToken, leaseMs])
      if (r.rowCount !== 1) throw conflict('agent-turn-stale')
    },
    async appendEvent(turn: ClaimedTurn, input: unknown) {
      const value = eventSchema.parse(input)
      await transaction(pool, async client => {
        await locked(client, turn)
        const count = (await client.query('SELECT count(*)::integer AS count FROM builder.agent_events WHERE turn_id=$1 AND attempt=$2', [turn.turnId, turn.attempt])).rows[0].count
        if (count >= 200) throw conflict('agent-event-budget')
        await event(client, { id: turn.turnId, owner: turn.owner, attempts: turn.attempt }, value.kind, value.payload)
      })
    },
    async finish(turn: ClaimedTurn, input: { text: string } | { errorCode: string }) {
      const value = z.union([z.object({ text: z.string().trim().min(1).max(16000) }).strict(), z.object({ errorCode: idSchema }).strict()]).parse(input)
      return transaction(pool, async client => {
        const draft = await locked(client, turn), success = 'text' in value, messageId = success ? randomUUID() : null
        if (success) await client.query("INSERT INTO builder.messages(id,conversation_id,owner,role,content) VALUES($1,$2,$3,'assistant',$4)", [messageId, turn.conversationId, turn.owner, value.text])
        await client.query(`UPDATE builder.agent_turns SET state=$2,assistant_message_id=$3,error_code=$4,lease_token=NULL,lease_until=NULL,
          completed_at=clock_timestamp() WHERE id=$1`, [turn.turnId, success ? 'succeeded' : 'failed', messageId, success ? null : value.errorCode])
        await event(client, { id: turn.turnId, owner: turn.owner, attempts: turn.attempt }, success ? 'completed' : 'failed',
          { revision: draft.revision, ...(success ? { messageId } : { errorCode: value.errorCode }) })
        return { messageId, revision: draft.revision }
      })
    },
    async cancel(owner: string, id: string) {
      ownerSchema.parse(owner); idSchema.parse(id)
      return transaction(pool, async client => {
        const row = (await client.query('SELECT d.id FROM builder.drafts d JOIN builder.agent_turns t ON t.draft_id=d.id WHERE t.id=$1 AND t.owner=$2 FOR UPDATE OF d', [id, owner])).rows[0]
        if (!row) throw notFound()
        const t = (await client.query('SELECT id,owner,state,attempts FROM builder.agent_turns WHERE id=$1 AND owner=$2 FOR UPDATE', [id, owner])).rows[0]
        if (['queued','running'].includes(t.state)) {
          await client.query("UPDATE builder.agent_turns SET state='cancelled',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1", [id])
          await event(client, t, 'cancelled')
        }
        return { id, state: ['queued','running'].includes(t.state) ? 'cancelled' : t.state as string }
      })
    },
    async get(owner: string, id: string) {
      ownerSchema.parse(owner); idSchema.parse(id)
      const row = (await pool.query(`SELECT id,conversation_id AS "conversationId",draft_id AS "draftId",state,attempts,
        accepted_revision::text AS "acceptedRevision",last_revision::text AS "lastRevision",assistant_message_id AS "messageId",error_code AS "errorCode"
        FROM builder.agent_turns WHERE id=$1 AND owner=$2`, [id, owner])).rows[0]
      if (!row) throw notFound()
      return row
    },
    async events(owner: string, id: string, after = '0') {
      ownerSchema.parse(owner); idSchema.parse(id); z.string().regex(/^(0|[1-9][0-9]{0,17})$/).parse(after)
      if (!(await pool.query('SELECT id FROM builder.agent_turns WHERE id=$1 AND owner=$2', [id, owner])).rowCount) throw notFound()
      return (await pool.query(`SELECT sequence::text,attempt,kind,payload FROM builder.agent_events
        WHERE turn_id=$1 AND owner=$2 AND sequence>$3::bigint ORDER BY builder.agent_events.sequence LIMIT 100`, [id, owner, after])).rows
    },
  }
}
