import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { compileBuilderStrategy } from 'aqua-executor/builder'
import { canonical, contentDigest, digestJson, draftSchema, idSchema, revisionSchema, validateStrategy, type DeploymentProfile } from '@pintool/strategy-builder'
import { readCompiledArtifact } from './artifacts.ts'
import { transaction } from './database.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'
import { assertTurnLease, type TurnLease } from './turn-lease.ts'

export const simulationEngine = 'builder-lifecycle-v1'
const startSchema = z.object({ artifactId: idSchema, draftId: idSchema, expectedRevision: revisionSchema }).strict()
const leaseMsSchema = z.number().int().min(100).max(300000)
const digestSchema = z.string().regex(/^0x[0-9a-f]{64}$/)
// Worker-owned evidence only. There is deliberately no HTTP endpoint accepting a result payload.
const reportSchema = z.object({ schemaVersion: z.literal(1), engineVersion: idSchema, mode: z.enum(['mock','fork-with-overrides']),
  draftId: idSchema, revision: revisionSchema, artifactDigest: digestSchema, manifestHash: digestSchema,
  passed: z.boolean(), coverageComplete: z.boolean(), registrationReady: z.literal(false),
  cases: z.array(z.object({ name: idSchema, passed: z.boolean().nullable(), error: idSchema.optional(), details: z.unknown().optional() }).strict()).min(1).max(100),
}).passthrough()
export type SimulationReport = z.infer<typeof reportSchema>
export const parseSimulationReport = (input: unknown) => reportSchema.parse(input)
export interface ClaimedSimulation { id: string; owner: string; artifactId: string; draftId: string; revision: number; leaseToken: string; attempt: number }
export interface SimulationReference { id: string; artifactId: string; draftId: string; revision: number }
const issueGuidance: Record<string, string> = {
  UnsupportedSwap: 'Guard rejected the swap amount or inventory state. Zero-rounded output, insufficient actual Aqua inventory and unsupported swap modes can all cause this error. For tiny amounts, check output precision first; this code does not establish a unique cause.',
  AmountLimitExceeded: 'A token amount exceeds the intersection of the report and immutable strategy limits. Both input and output amounts are bounded.',
  InventoryLimitExceeded: 'Post-swap Aqua balances would exceed the intersection of report and immutable strategy limits.',
  MissingReport: 'No Guard report is stored for the current strategy hash.',
  StrategyNotActive: 'This is not the active Maker strategy hash. It may have been replaced, paused or revoked.',
  SafeTransferFromFailed: 'The token transfer failed, possibly due to insufficient wallet balance or allowance. A quote does not guarantee settlement.',
  'boundary-needs-atomic-margin': 'The amount is too small for a one-atomic-unit boundary test. This test failure does not mean all swaps are impossible.',
}

/** Only isolated preparation jobs: no broadcaster, asset key, report nonce or public-chain transaction. */
export function createSimulations(pool: Pool, profile: DeploymentProfile, turn?: TurnLease) {
  async function job(client: PoolClient, claim: ClaimedSimulation) {
    const artifact = await readCompiledArtifact(client, profile, claim.owner, claim.artifactId, true)
    const row = (await client.query(`SELECT j.*,r.engine_version,j.lease_until>clock_timestamp() AS lease_live FROM builder.jobs j JOIN builder.simulation_runs r ON r.id=j.id AND r.owner=j.owner
      WHERE j.id=$1 AND j.owner=$2 AND r.artifact_id=$3 FOR UPDATE OF j`, [claim.id, claim.owner, claim.artifactId])).rows[0]
    if (!row || row.state !== 'running' || row.lease_token !== claim.leaseToken || !row.lease_live) throw conflict('simulation-lease-lost')
    if (row.resource_id !== claim.draftId || Number(row.generation) !== claim.revision || artifact.payload.draftId !== claim.draftId || artifact.payload.revision !== claim.revision)
      throw new ServiceError('simulation-input-integrity', 500)
    return { artifact, row, current: artifact.current && row.engine_version === simulationEngine }
  }
  async function cancelJob(client: PoolClient, id: string, errorCode: string) {
    await client.query(`UPDATE builder.jobs SET state='cancelled',result=$2,lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1`,
      [id, JSON.stringify({ errorCode })])
  }
  function validateReport(input: unknown, artifact: Awaited<ReturnType<typeof readCompiledArtifact>>) {
    const report = reportSchema.parse(input)
    if (report.draftId !== artifact.payload.draftId || report.revision !== artifact.payload.revision ||
      report.artifactDigest !== digestJson(artifact.payload) || report.manifestHash !== artifact.payload.manifestHash ||
      report.passed !== report.cases.every(c => c.passed !== false) || report.coverageComplete !== report.cases.every(c => c.passed === true) ||
      JSON.stringify(report).length > 262144) throw new ServiceError('simulation-result-integrity', 500)
    return report
  }
  return {
    async start(owner: string, requestId: string, input: unknown): Promise<SimulationReference> {
      const value = startSchema.parse(input)
      return mutation(pool, owner, requestId, 'simulation.start', value, async client => {
        const artifact = await readCompiledArtifact(client, profile, owner, value.artifactId, true)
        if (artifact.payload.draftId !== value.draftId) throw notFound()
        if (!artifact.current || artifact.payload.revision !== value.expectedRevision) throw conflict('simulation-artifact-stale')
        if (turn) await assertTurnLease(client, artifact.draft, turn)
        if (artifact.draft.kind !== 'maker' || artifact.draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
        const active = (await client.query(`SELECT j.id,r.artifact_id,r.engine_version FROM builder.jobs j JOIN builder.simulation_runs r ON r.id=j.id AND r.owner=j.owner
          WHERE j.owner=$1 AND j.resource_id=$2 AND j.state IN ('pending','running') FOR UPDATE OF j`, [owner, value.draftId])).rows
        for (const running of active) {
          if (running.artifact_id === value.artifactId && running.engine_version === simulationEngine)
            return { id: running.id, artifactId: value.artifactId, draftId: value.draftId, revision: value.expectedRevision }
          await cancelJob(client, running.id, 'simulation-artifact-stale')
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [owner])
        const used = (await client.query("SELECT count(*)::integer AS count FROM builder.jobs WHERE owner=$1 AND kind='simulation' AND created_at>clock_timestamp()-interval '1 hour'", [owner])).rows[0].count
        if (used >= 12) throw new ServiceError('simulation-hourly-budget', 429)
        const id = randomUUID(), payload = { referenceId: value.artifactId, manifestHash: artifact.payload.manifestHash }
        await client.query(`INSERT INTO builder.jobs(id,owner,kind,resource_id,generation,dedupe_key,input_digest,payload)
          VALUES($1,$2,'simulation',$3,$4,$1,$5,$6)`, [id, owner, value.draftId, value.expectedRevision, digestJson({ ...value, engineVersion: simulationEngine }), JSON.stringify(payload)])
        await client.query('INSERT INTO builder.simulation_runs(id,owner,artifact_id,engine_version) VALUES($1,$2,$3,$4)', [id, owner, value.artifactId, simulationEngine])
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'simulation.queued',$2,$3)", [owner, id, value.expectedRevision])
        return { id, artifactId: value.artifactId, draftId: value.draftId, revision: value.expectedRevision }
      })
    },
    async claim(leaseMs = 30000): Promise<ClaimedSimulation | null> {
      leaseMsSchema.parse(leaseMs)
      return transaction(pool, async client => {
        // The common order is draft -> job. User edits and cancellation take the same draft lock.
        const candidate = (await client.query(`SELECT j.id,j.owner,r.artifact_id FROM builder.jobs j JOIN builder.simulation_runs r ON r.id=j.id AND r.owner=j.owner
          JOIN builder.drafts d ON d.id=j.resource_id AND d.owner=j.owner WHERE j.kind='simulation' AND j.available_at<=clock_timestamp()
          AND (j.state='pending' OR (j.state='running' AND j.lease_until<clock_timestamp())) ORDER BY j.available_at,j.created_at,j.id
          FOR UPDATE OF d SKIP LOCKED LIMIT 1`)).rows[0]
        if (!candidate) return null
        const artifact = await readCompiledArtifact(client, profile, candidate.owner, candidate.artifact_id, true)
        const row = (await client.query(`SELECT j.*,r.engine_version,j.lease_until>clock_timestamp() AS lease_live FROM builder.jobs j JOIN builder.simulation_runs r ON r.id=j.id
          WHERE j.id=$1 FOR UPDATE OF j`, [candidate.id])).rows[0]
        if (row.state !== 'pending' && !(row.state === 'running' && !row.lease_live)) return null
        if (!artifact.current || row.engine_version !== simulationEngine) { await cancelJob(client, row.id, 'simulation-artifact-stale'); return null }
        if (row.attempts >= 3) {
          await client.query(`UPDATE builder.jobs SET state='failed',result='{"errorCode":"simulation-retry-limit"}',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1`, [row.id])
          return null
        }
        const leaseToken = randomUUID()
        await client.query(`UPDATE builder.jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+$3::integer*interval '1 millisecond'
          WHERE id=$1`, [row.id, leaseToken, leaseMs])
        return { id: row.id, owner: row.owner, artifactId: candidate.artifact_id, draftId: row.resource_id, revision: Number(row.generation), leaseToken, attempt: row.attempts + 1 }
      })
    },
    async input(claim: ClaimedSimulation) {
      return transaction(pool, async client => {
        const { artifact, current } = await job(client, claim)
        if (!current) throw conflict('simulation-artifact-stale')
        if (canonical(compileBuilderStrategy(artifact.draft, profile, Math.floor(Date.now() / 1000))) !== canonical(artifact.payload)) throw new ServiceError('simulation-input-integrity', 500)
        return { draft: artifact.draft, compilation: artifact.payload }
      })
    },
    async heartbeat(claim: ClaimedSimulation, leaseMs = 30000) {
      leaseMsSchema.parse(leaseMs)
      const current = await transaction(pool, async client => {
        const { current } = await job(client, claim)
        if (!current) { await cancelJob(client, claim.id, 'simulation-artifact-stale'); return false }
        const renewed = await client.query(`UPDATE builder.jobs SET lease_until=clock_timestamp()+$2::integer*interval '1 millisecond'
          WHERE id=$1 AND lease_token=$3 AND state='running' AND lease_until>clock_timestamp()`, [claim.id, leaseMs, claim.leaseToken])
        if (renewed.rowCount !== 1) throw conflict('simulation-lease-lost')
        return true
      })
      if (!current) throw conflict('simulation-artifact-stale')
    },
    async finish(claim: ClaimedSimulation, input: unknown) {
      return transaction(pool, async client => {
        const { artifact, current } = await job(client, claim)
        if (!current) { await cancelJob(client, claim.id, 'simulation-artifact-stale'); return { state: 'cancelled' as const } }
        const report = validateReport(input, artifact)
        if (report.engineVersion !== simulationEngine) throw new ServiceError('simulation-result-integrity', 500)
        await client.query('INSERT INTO builder.simulation_results(run_id,owner,payload_digest,payload) VALUES($1,$2,$3,$4)', [claim.id, claim.owner, digestJson(report), JSON.stringify(report)])
        const state = report.passed ? 'succeeded' : 'failed'
        const completed = await client.query(`UPDATE builder.jobs SET state=$2,result=$3,lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp()
          WHERE id=$1 AND lease_token=$4 AND state='running' AND lease_until>clock_timestamp()`, [claim.id, state, JSON.stringify({ referenceId: claim.id }), claim.leaseToken])
        if (completed.rowCount !== 1) throw conflict('simulation-lease-lost')
        await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,'simulation.completed',$2,$3)", [claim.owner, claim.id, claim.revision])
        return { state }
      })
    },
    async fail(claim: ClaimedSimulation) {
      return transaction(pool, async client => {
        const { current, row } = await job(client, claim)
        if (!current) { await cancelJob(client, claim.id, 'simulation-artifact-stale'); return }
        const exhausted = row.attempts >= 3
        const updated = await client.query(`UPDATE builder.jobs SET state=$2,result='{"errorCode":"simulation-unavailable"}',lease_token=NULL,lease_until=NULL,
          available_at=clock_timestamp()+$3::integer*interval '1 millisecond',completed_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END
          WHERE id=$1 AND lease_token=$5 AND state='running' AND lease_until>clock_timestamp()`,
        [claim.id, exhausted ? 'failed' : 'pending', 1000 * 2 ** row.attempts, exhausted, claim.leaseToken])
        if (updated.rowCount !== 1) throw conflict('simulation-lease-lost')
      })
    },
    async cancel(owner: string, requestId: string, id: string) {
      idSchema.parse(id)
      return mutation(pool, owner, requestId, 'simulation.cancel', { id }, async client => {
        const run = (await client.query('SELECT artifact_id FROM builder.simulation_runs WHERE id=$1 AND owner=$2', [id, owner])).rows[0]
        if (!run) throw notFound()
        await readCompiledArtifact(client, profile, owner, run.artifact_id, true)
        const row = (await client.query('SELECT state FROM builder.jobs WHERE id=$1 AND owner=$2 FOR UPDATE', [id, owner])).rows[0]
        if (['pending','running'].includes(row.state)) { await cancelJob(client, id, 'simulation-cancelled'); return { id, state: 'cancelled' } }
        return { id, state: row.state as string }
      })
    },
    async get(owner: string, id: string) {
      ownerSchema.parse(owner); idSchema.parse(id)
      const row = (await pool.query(`SELECT r.*,j.state,j.attempts,j.result,j.resource_id,j.generation::text,s.payload,s.payload_digest
        FROM builder.simulation_runs r JOIN builder.jobs j ON j.id=r.id AND j.owner=r.owner
        LEFT JOIN builder.simulation_results s ON s.run_id=r.id AND s.owner=r.owner WHERE r.id=$1 AND r.owner=$2`, [id, owner])).rows[0]
      if (!row) throw notFound()
      const artifact = await readCompiledArtifact(pool, profile, owner, row.artifact_id)
      const report = row.payload ? validateReport(row.payload, artifact) : null
      if (report && (digestJson(report) !== row.payload_digest || report.engineVersion !== row.engine_version)) throw new ServiceError('simulation-result-integrity', 500)
      return { id, artifactId: row.artifact_id as string, draftId: row.resource_id as string, revision: Number(row.generation), state: row.state as string,
        attempts: row.attempts as number, current: artifact.current && row.engine_version === simulationEngine, report,
        errorCode: row.result?.errorCode as string | undefined, registrationReady: false as const }
    },
    async list(owner: string, draftId: string) {
      ownerSchema.parse(owner); idSchema.parse(draftId)
      if (!(await pool.query('SELECT id FROM builder.drafts WHERE id=$1 AND owner=$2', [draftId, owner])).rowCount) throw notFound()
      const rows = (await pool.query(`SELECT r.id,r.artifact_id,r.engine_version,j.generation::text AS revision,j.state,j.attempts,j.result,
        s.payload,s.payload_digest,a.payload_digest AS artifact_digest,a.manifest_hash,a.content_digest,d.snapshot,d.digest
        FROM builder.simulation_runs r JOIN builder.jobs j ON j.id=r.id AND j.owner=r.owner
        JOIN builder.compiled_artifacts a ON a.id=r.artifact_id AND a.owner=r.owner JOIN builder.drafts d ON d.id=j.resource_id AND d.owner=j.owner
        LEFT JOIN builder.simulation_results s ON s.run_id=r.id AND s.owner=r.owner
        WHERE r.owner=$1 AND j.resource_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 20`, [owner, draftId])).rows
      return rows.map(row => {
        const draft = draftSchema.parse(row.snapshot), report = row.payload ? reportSchema.parse(row.payload) : null
        if (draft.owner !== owner || draft.id !== draftId || row.digest !== contentDigest(draft) || (report && (digestJson(report) !== row.payload_digest ||
          report.artifactDigest !== row.artifact_digest || report.draftId !== draftId || report.revision !== Number(row.revision) ||
          report.engineVersion !== row.engine_version || report.manifestHash !== row.manifest_hash))) throw new ServiceError('simulation-result-integrity', 500)
        const current = draft.revision === Number(row.revision) && row.content_digest === row.digest && row.manifest_hash === digestJson(profile) &&
          row.engine_version === simulationEngine && validateStrategy(draft, profile, Math.floor(Date.now() / 1000)).ready
        return { id: row.id as string, artifactId: row.artifact_id as string, revision: Number(row.revision), state: row.state as string, attempts: row.attempts as number,
          current, mode: report?.mode ?? null, passed: report?.passed ?? null, coverageComplete: report?.coverageComplete ?? null,
          caseCount: report?.cases.length ?? 0, skippedCaseCount: report?.cases.filter(c => c.passed === null).length ?? 0,
          issues: report?.cases.filter(c => c.passed !== true).map(c => ({ name: c.name, passed: c.passed, error: c.error,
            guidance: c.error ? issueGuidance[c.error] ?? 'This case did not meet expectations. Inspect the details; it is not passing evidence.' : 'This case was not run.' })) ?? [],
          errorCode: row.result?.errorCode as string | undefined, registrationReady: false as const }
      })
    },
  }
}
