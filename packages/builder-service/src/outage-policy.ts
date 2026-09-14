import type { PoolClient } from 'pg'
import { z } from 'zod'

export const outagePolicySchema = z.object({
  sources: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)).min(1).max(16).refine(v => new Set(v).size === v.length),
  maxAgeSeconds: z.number().int().min(60).max(3600), onRecovery: z.literal('reevaluate'),
}).strict()
export type OutagePolicy = z.infer<typeof outagePolicySchema>

/** Only signed, explicitly selected source IDs affect this Maker. */
export async function readOutageState(reader: Pick<PoolClient, 'query'>, input?: OutagePolicy, now = Date.now()) {
  if (!input) return { pauseRequired: false, unavailable: [] as string[] }
  const policy = outagePolicySchema.parse(input)
  const rows = (await reader.query('SELECT source,health,observed_at FROM builder.event_cursors WHERE source=ANY($1::text[])', [policy.sources])).rows
  const unavailable = policy.sources.filter(source => {
    const row = rows.find(r => r.source === source), time = row?.observed_at ? new Date(row.observed_at).getTime() : NaN
    return !row || !['healthy','recovered'].includes(row.health) || !Number.isFinite(time) || time > now + 30000 || time < now - policy.maxAgeSeconds * 1000
  })
  return { pauseRequired: unavailable.length > 0, unavailable }
}
