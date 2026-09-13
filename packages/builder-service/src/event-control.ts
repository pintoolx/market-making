import type { PoolClient } from 'pg'

/**
 * Stop work that has not reached the external broadcaster. A row already in
 * `broadcast` is deliberately left alone so a later receipt can be reconciled.
 */
export async function cancelUnsentEventWork(client: Pick<PoolClient, 'query'>, subscriptionIds: readonly string[], errorCode = 'subscription-stopped') {
  if (!subscriptionIds.length) return
  await client.query(`UPDATE builder.evaluation_jobs
    SET state='cancelled',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code=$2
    WHERE subscription_id=ANY($1::text[]) AND state IN ('pending','running')`, [subscriptionIds, errorCode])
  await client.query(`UPDATE builder.report_deliveries
    SET status='failed',error_code=$2,updated_at=clock_timestamp()
    WHERE subscription_id=ANY($1::text[]) AND status='pending'`, [subscriptionIds, errorCode])
}
