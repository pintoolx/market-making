import type { PoolClient } from 'pg'
import type { StrategyDraft } from '@pintool/strategy-builder'
import { conflict } from './errors.ts'

export interface TurnLease { turnId: string; leaseToken: string }

/** Caller holds the draft row first. All operations lock draft -> turn, never the reverse. */
export async function assertTurnLease(client: PoolClient, draft: StrategyDraft, lease: TurnLease) {
  const row = (await client.query(`SELECT id FROM builder.agent_turns
    WHERE id=$1 AND owner=$2 AND draft_id=$3 AND state='running' AND lease_token=$4
      AND lease_until>clock_timestamp() AND last_revision=$5 FOR UPDATE`,
  [lease.turnId, draft.owner, draft.id, lease.leaseToken, draft.revision])).rows[0]
  if (!row) throw conflict('agent-turn-stale')
}

export async function supersedeTurns(client: PoolClient, owner: string, draftId: string) {
  await client.query(`WITH changed AS (
    UPDATE builder.agent_turns SET state='superseded',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp()
    WHERE owner=$1 AND draft_id=$2 AND state IN ('queued','running') RETURNING id,owner,attempts
  ) INSERT INTO builder.agent_events(turn_id,owner,attempt,kind,payload)
    SELECT id,owner,attempts,'superseded','{}'::jsonb FROM changed`, [owner, draftId])
}
