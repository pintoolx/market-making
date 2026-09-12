import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { digestJson, idSchema, revisionSchema } from '@pintool/strategy-builder'
import { transaction } from './database.ts'
import { conflict, notFound } from './errors.ts'

const kindSchema = z.enum(['agent-turn', 'simulation', 'evaluation'])
const jobSchema = z.object({ kind: kindSchema, resourceId: idSchema, generation: revisionSchema, dedupeKey: idSchema,
  // Only immutable public references go into the durable queue. Load protected inputs in their own adapter.
  payload: z.object({ referenceId: idSchema, manifestHash: z.string().regex(/^0x[0-9a-f]{64}$/).optional() }).strict() }).strict()
const durationSchema = z.number().int().min(100).max(300000)

/** Durable preparation/evaluation queue. A lease alone is NOT a report-broadcast or tx-nonce lock. */
export function createJobs(pool: Pool) {
  return {
    async enqueue(owner: string, input: unknown) {
      const v = jobSchema.parse(input), digest = digestJson(v)
      return transaction(pool, async client => {
        await client.query(`INSERT INTO builder.jobs(id,owner,kind,resource_id,generation,dedupe_key,input_digest,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (owner,kind,dedupe_key) DO NOTHING`,
        [randomUUID(), owner, v.kind, v.resourceId, v.generation, v.dedupeKey, digest, JSON.stringify(v.payload)])
        const row = (await client.query('SELECT id, input_digest FROM builder.jobs WHERE owner=$1 AND kind=$2 AND dedupe_key=$3', [owner, v.kind, v.dedupeKey])).rows[0]
        if (row.input_digest !== digest) throw conflict('job-key-reused')
        return { id: row.id as string }
      })
    },
    async claim(kind: z.infer<typeof kindSchema>, leaseMs = 30000) {
      kindSchema.parse(kind); durationSchema.parse(leaseMs)
      const token = randomUUID()
      const row = (await pool.query(`WITH next_job AS (
        SELECT id FROM builder.jobs WHERE kind=$1 AND available_at<=clock_timestamp()
          AND (state='pending' OR (state='running' AND lease_until<clock_timestamp()))
        ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE builder.jobs j SET state='running',lease_token=$2,lease_until=clock_timestamp()+$3::integer*interval '1 millisecond',attempts=attempts+1
        FROM next_job n WHERE j.id=n.id RETURNING j.*`, [kind, token, leaseMs])).rows[0]
      return row ?? null
    },
    async heartbeat(id: string, token: string, leaseMs = 30000) {
      durationSchema.parse(leaseMs)
      const result = await pool.query(`UPDATE builder.jobs SET lease_until=clock_timestamp()+$3::integer*interval '1 millisecond'
        WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`, [id, token, leaseMs])
      if (result.rowCount !== 1) throw conflict('lease-lost')
    },
    async complete(id: string, token: string, outcome: { state: 'succeeded' | 'failed'; result: { referenceId?: string; errorCode?: string } }) {
      const value = z.object({ state: z.enum(['succeeded','failed']), result: z.object({ referenceId: idSchema.optional(), errorCode: idSchema.optional() }).strict() }).strict().parse(outcome)
      const result = await pool.query(`UPDATE builder.jobs SET state=$3,result=$4,completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`, [id, token, value.state, JSON.stringify(value.result)])
      if (result.rowCount !== 1) throw conflict('lease-lost')
    },
    async get(owner: string, id: string) {
      const row = (await pool.query(`SELECT id,kind,resource_id AS "resourceId",generation::text,state,attempts,result FROM builder.jobs WHERE id=$1 AND owner=$2`, [id, owner])).rows[0]
      if (!row) throw notFound()
      return row
    },
  }
}
