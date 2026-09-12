import pg from 'pg'
import type { Pool, PoolClient } from 'pg'

/** One bounded pool per process. Never log a connection string or the driver's raw errors. */
export function database(connectionString: string, onUnavailable: () => void = () => {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15000, idle_in_transaction_session_timeout: 20000, application_name: 'pintool-builder' })
  pool.on('error', onUnavailable)
  return pool
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let destroy = false
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw error
  } finally { client.release(destroy) }
}
