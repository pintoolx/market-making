import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { ServiceError } from './errors.ts'

export type OutboxEntry = { id: number; owner: string; kind: string; resourceId: string; revision: number; attempts: number; createdAt: string }
export type OutboxDispatcherOptions = { leaseMs?: number; maxAttempts?: number }

function value(row: Record<string, unknown>): OutboxEntry {
  return { id: Number(row.id), owner: String(row.owner), kind: String(row.kind), resourceId: String(row.resource_id), revision: Number(row.revision),
    attempts: Number(row.attempts), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at) }
}

/** A lease-based dispatcher for non-secret application notifications. */
export function createOutboxDispatcher(pool: Pool, dispatch: (entry: OutboxEntry) => Promise<void>, options: OutboxDispatcherOptions = {}) {
  const leaseMs = options.leaseMs ?? 30000, maxAttempts = options.maxAttempts ?? 3
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('invalid outbox options')
  async function claim(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError('invalid-request')
    const token = randomUUID()
    const rows = (await pool.query(`WITH next_entry AS (
        SELECT id FROM builder.outbox WHERE dispatched_at IS NULL AND dead_at IS NULL AND available_at<=clock_timestamp()
          AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND attempts<$2
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE builder.outbox AS o SET lease_token=$3,lease_until=clock_timestamp()+$4::integer*interval '1 millisecond',attempts=attempts+1
        FROM next_entry n WHERE o.id=n.id RETURNING o.*`, [limit, maxAttempts, token, leaseMs])).rows
    return rows.map(row => ({ entry: value(row), token }))
  }
  async function ack(id: number, token: string) {
    const result = await pool.query(`UPDATE builder.outbox SET dispatched_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2 AND dispatched_at IS NULL`, [id, token])
    if (!result.rowCount) throw new ServiceError('outbox-lease-lost', 409)
  }
  async function fail(id: number, token: string, errorCode = 'outbox-dispatch-failed') {
    const safe = /^[a-z][a-z0-9._-]{0,63}$/.test(errorCode) ? errorCode : 'outbox-dispatch-failed'
    await pool.query(`UPDATE builder.outbox SET lease_token=NULL,lease_until=NULL,error_code=$3,
      available_at=CASE WHEN attempts<$4 THEN clock_timestamp()+((attempts * 2)::text || ' seconds')::interval ELSE 'infinity'::timestamptz END,
      dead_at=CASE WHEN attempts<$4 THEN NULL ELSE clock_timestamp() END
      WHERE id=$1 AND lease_token=$2 AND dispatched_at IS NULL`, [id, token, safe, maxAttempts])
  }
  return {
    claim,
    ack,
    fail,
    async process(limit = 20, onError?: (error: unknown, entry: OutboxEntry) => void) {
      let processed = 0
      for (const claimed of await claim(limit)) {
        try { await dispatch(claimed.entry); await ack(claimed.entry.id, claimed.token); processed++ }
        catch (error) { await fail(claimed.entry.id, claimed.token, error instanceof ServiceError ? error.code : 'outbox-dispatch-failed'); onError?.(error, claimed.entry) }
      }
      return processed
    },
    async pending(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ServiceError('invalid-request')
      return (await pool.query(`SELECT id FROM builder.outbox WHERE dispatched_at IS NULL AND dead_at IS NULL AND available_at<=clock_timestamp() ORDER BY id LIMIT $1`, [limit])).rows.map(row => Number(row.id))
    },
  }
}
