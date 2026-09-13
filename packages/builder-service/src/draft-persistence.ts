import type { PoolClient } from 'pg'
import { contentDigest, draftSchema, idSchema, type StrategyDraft, type Diff, type patchDraft } from '@pintool/strategy-builder'
import { conflict, notFound, ServiceError } from './errors.ts'
import { ownerSchema } from './requests.ts'
import { assertTurnLease, supersedeTurns, type TurnLease } from './turn-lease.ts'
import { cancelUnsentEventWork } from './event-control.ts'

/** Internal transaction helpers shared by public edits and explicit user review.
 * Callers hold the owned draft lock across any read/change/receipt operation. */
export async function readOwnedDraft(client: Pick<PoolClient, 'query'>, owner: string, id: string, lock = false, lease?: TurnLease) {
  ownerSchema.parse(owner); idSchema.parse(id)
  const row = (await client.query(`SELECT snapshot,digest FROM builder.drafts WHERE id=$1 AND owner=$2${lock ? ' FOR UPDATE' : ''}`, [id, owner])).rows[0]
  if (!row) throw notFound()
  const draft = draftSchema.parse(row.snapshot)
  if (draft.owner !== owner || draft.id !== id || row.digest !== contentDigest(draft)) throw new ServiceError('stored-draft-integrity', 500)
  if (lease && lock) await assertTurnLease(client as PoolClient, draft, lease)
  return draft
}
export async function persistDraftRevision(client: PoolClient, draft: StrategyDraft, diff: Diff[]) {
  await client.query('INSERT INTO builder.draft_revisions(draft_id,owner,revision,snapshot,digest,diff) VALUES ($1,$2,$3,$4,$5,$6)',
    [draft.id, draft.owner, draft.revision, JSON.stringify(draft), contentDigest(draft), JSON.stringify(diff)])
  await client.query('INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES ($1,$2,$3,$4)', [draft.owner, 'draft.changed', draft.id, draft.revision])
}
export async function persistDraftChange(client: PoolClient, before: StrategyDraft, result: ReturnType<typeof patchDraft>, lease?: TurnLease) {
  if (!result.changed) return result
  const draft = draftSchema.parse(result.draft), { diff } = result
  if (draft.owner !== before.owner || draft.id !== before.id || draft.kind !== before.kind || draft.revision !== before.revision + 1)
    throw new ServiceError('draft-update-integrity', 500)
  const saved = await client.query(`UPDATE builder.drafts SET snapshot=$4,digest=$5,revision=$6,updated_at=clock_timestamp()
    WHERE id=$1 AND owner=$2 AND revision=$3 RETURNING conversation_id`,
    [draft.id, draft.owner, before.revision, JSON.stringify(draft), contentDigest(draft), draft.revision])
  if (saved.rowCount !== 1) throw conflict()
  await persistDraftRevision(client, draft, diff)
  if (lease) await client.query('UPDATE builder.agent_turns SET last_revision=$2 WHERE id=$1', [lease.turnId, draft.revision])
  else await supersedeTurns(client, draft.owner, draft.id)
  await client.query('UPDATE builder.conversations SET title=$3,updated_at=clock_timestamp() WHERE id=$1 AND owner=$2', [saved.rows[0].conversation_id, draft.owner, draft.spec.title])
  const stopped = await client.query(`UPDATE builder.event_subscriptions SET state='stopped',stopped_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE owner=$1 AND draft_id=$2 AND state IN ('enabled','paused') RETURNING id,revision`, [draft.owner, draft.id])
  await cancelUnsentEventWork(client, stopped.rows.map(row => String(row.id)))
  for (const row of stopped.rows) await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'event-subscription.stopped',$2,$3) ON CONFLICT DO NOTHING", [draft.owner, row.id, row.revision])
  // Running jobs reconcile their own lease/revision; only unstarted work is cancelled here.
  await client.query(`UPDATE builder.jobs SET state='cancelled',completed_at=clock_timestamp()
    WHERE owner=$1 AND resource_id=$2 AND kind='simulation' AND generation<$3 AND state='pending'`, [draft.owner, draft.id, draft.revision])
  return { ...result, draft }
}
