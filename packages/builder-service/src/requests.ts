import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { digestJson, idSchema } from '@pintool/strategy-builder'
import { transaction } from './database.ts'
import { conflict } from './errors.ts'

export const ownerSchema = z.string().regex(/^wallet:0x[0-9a-f]{40}$/)

/** Dedupe and response commit with the mutation; failed work releases its request key. */
export async function mutation<T>(pool: Pool, owner: string, requestId: string, operation: string, input: unknown,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  ownerSchema.parse(owner); idSchema.parse(requestId)
  const digest = digestJson(input)
  return transaction(pool, async client => {
    await client.query(`INSERT INTO builder.requests(owner, request_id, operation, input_digest) VALUES ($1,$2,$3,$4)
      ON CONFLICT (owner, request_id) DO NOTHING`, [owner, requestId, operation, digest])
    const row = (await client.query('SELECT operation, input_digest, response FROM builder.requests WHERE owner=$1 AND request_id=$2 FOR UPDATE', [owner, requestId])).rows[0]!
    if (row.operation !== operation || row.input_digest !== digest) throw conflict('idempotency-key-reused')
    if (row.response !== null) return row.response as T
    const encoded = JSON.stringify(await work(client))
    await client.query('UPDATE builder.requests SET response=$3 WHERE owner=$1 AND request_id=$2', [owner, requestId, encoded])
    return JSON.parse(encoded) as T
  })
}
