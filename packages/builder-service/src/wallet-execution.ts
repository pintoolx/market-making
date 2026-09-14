import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { compileBuilderStrategy } from 'aqua-executor/builder'
import { canonical, contentDigest, digestJson, draftSchema, hashSchema, idSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { createTransactionPlans, makePlan } from './transaction-plans.ts'
import { readCompiledArtifact } from './artifacts.ts'
import { readRequirementReceipt } from './requirement-reviews.ts'
import { createSimulations } from './simulations.ts'
import { mutation, ownerSchema } from './requests.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import type { WalletChain, WalletRequest } from './wallet-chain.ts'

const prepareSchema = z.object({ planId: idSchema, step: z.number().int().min(0).max(2) }).strict()
const reconcileSchema = z.object({ executionId: idSchema, transactionHash: hashSchema.optional() }).strict()
export interface WalletExecution {
  id: string; owner: string; planId: string; step: number;
  state: 'awaiting-wallet' | 'pending' | 'unverified' | 'confirmed' | 'reverted' | 'replaced' | 'rejected'; version: string;
  nonce: string; fromBlock: string; request: WalletRequest; transactionHash: `0x${string}` | null;
  evidence: Record<string, unknown> | null; createdAt: string; updatedAt: string;
}
function entry(row: Record<string, unknown>): WalletExecution {
  const request = row.request as WalletRequest
  if (row.request_digest !== digestJson(request) || request.from !== String(row.owner).slice(7) || request.nonce !== String(row.nonce)) throw new ServiceError('wallet-execution-integrity', 500)
  return { id: String(row.id), owner: String(row.owner), planId: String(row.plan_id), step: Number(row.step), state: row.state as WalletExecution['state'], version: String(row.version),
    nonce: String(row.nonce), fromBlock: String(row.from_block), request, transactionHash: row.transaction_hash as WalletExecution['transactionHash'],
    evidence: row.evidence as WalletExecution['evidence'], createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString() }
}

/** The application prepares and verifies; only the browser wallet sends. */
export function createWalletExecution(pool: Pool, profile: DeploymentProfile, chain: WalletChain) {
  const plans = createTransactionPlans(pool, profile), simulations = createSimulations(pool, profile)
  async function load(owner: string, id: string, reader: Pick<PoolClient, 'query'> = pool, lock = false) {
    ownerSchema.parse(owner); idSchema.parse(id)
    const row = (await reader.query(`SELECT * FROM builder.wallet_executions WHERE id=$1 AND owner=$2${lock ? ' FOR UPDATE' : ''}`, [id, owner])).rows[0]
    if (!row) throw notFound()
    return entry(row)
  }
  async function trustedPlan(owner: string, planId: string, signing: boolean, reader: Pick<PoolClient, 'query'> = pool) {
    const saved = (await reader.query('SELECT payload,payload_digest FROM builder.transaction_plans WHERE id=$1 AND owner=$2', [planId, owner])).rows[0]
    if (!saved) throw notFound()
    const plan = saved.payload as Awaited<ReturnType<typeof plans.get>>['plan']
    if (saved.payload_digest !== digestJson(plan)) throw new ServiceError('transaction-plan-integrity', 500)
    const artifact = await readCompiledArtifact(reader, profile, owner, plan.artifactId)
    const row = (await reader.query('SELECT snapshot FROM builder.draft_revisions WHERE draft_id=$1 AND revision=$2 AND owner=$3', [plan.draftId, plan.revision, owner])).rows[0]
    if (!row) throw new ServiceError('transaction-plan-integrity', 500)
    const draft = draftSchema.parse(row.snapshot)
    if (canonical(makePlan(plan.kind, plan.id, profile, draft, plan.artifactId, artifact.payload)) !== canonical(plan) ||
      artifact.payload.contentDigest !== contentDigest(draft) || artifact.payload.strategyHash !== artifact.payload.decoded.strategyHash ||
      artifact.payload.decoded.maker !== draft.maker || artifact.payload.decoded.guard !== profile.guard ||
      (signing && plan.kind === 'registration' && canonical(compileBuilderStrategy(draft, profile, Math.min(Math.floor(Date.now() / 1000), draft.spec.deadline! - 1))) !== canonical(artifact.payload)))
      throw new ServiceError('transaction-plan-integrity', 500)
    if (signing && plan.kind === 'guard-unrevoke' && artifact.payload.decoded.feeBps !== 0) throw conflict('fee-guard-incompatible')
    if (signing && plan.kind === 'registration') {
      if (!artifact.current) throw conflict('wallet-plan-stale')
      if (!draft.spec.deadline || draft.spec.deadline <= Math.floor(Date.now() / 1000) + 30) throw conflict('wallet-strategy-expired')
      if (draft.requirements.length && !await readRequirementReceipt(reader, profile, draft)) throw conflict('requirement-review-required')
    }
    return plan
  }
  async function verifiedSimulation(owner: string, planId: string) {
    const { plan } = await plans.get(owner, planId)
    if (plan.kind !== 'registration') return
    const run = (await pool.query(`SELECT r.id FROM builder.simulation_runs r JOIN builder.jobs j ON j.id=r.id AND j.owner=r.owner
      WHERE r.owner=$1 AND r.artifact_id=$2 ORDER BY r.created_at DESC LIMIT 1`, [owner, plan.artifactId])).rows[0]
    if (!run) throw conflict('wallet-simulation-required')
    const evidence = await simulations.get(owner, run.id)
    if (!evidence.current || evidence.state !== 'succeeded' || !evidence.report?.passed || !evidence.report.coverageComplete || evidence.report.mode !== 'fork-with-overrides')
      throw conflict('wallet-simulation-required')
  }
  const service = {
    async prepare(owner: string, requestId: string, input: unknown) {
      ownerSchema.parse(owner); const value = prepareSchema.parse(input)
      const plan = await trustedPlan(owner, value.planId, true)
      if (!plan.transactions[value.step]) throw new ServiceError('wallet-step-invalid')
      await verifiedSimulation(owner, plan.id)
      const observed = await chain.preflight(plan, value.step)
      const tx = plan.transactions[value.step]!
      if (observed.request.chainId !== profile.chainId || observed.request.from !== plan.maker || observed.request.to !== tx.to ||
        observed.request.data !== tx.data || observed.request.value !== '0x0' || !/^(0|[1-9][0-9]*)$/.test(observed.request.nonce) ||
        !/^[1-9][0-9]*$/.test(observed.request.gas) || !Number.isFinite(Date.parse(observed.request.expiresAt)))
        throw new ServiceError('wallet-preflight-integrity', 503)
      return mutation(pool, owner, requestId, 'wallet-execution.prepare', value, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['builder-wallet:' + owner])
        await trustedPlan(owner, plan.id, true, client)
        if (Date.parse(observed.request.expiresAt) <= Date.now()) throw conflict('wallet-preflight-expired')
        const active = (await client.query("SELECT * FROM builder.wallet_executions WHERE owner=$1 AND state IN ('awaiting-wallet','pending','unverified') ORDER BY created_at FOR UPDATE", [owner])).rows[0]
        if (active) {
          const saved = entry(active)
          if (saved.planId !== plan.id || saved.step !== value.step) throw conflict('wallet-transaction-unresolved')
          if (saved.state !== 'awaiting-wallet' || saved.nonce !== observed.request.nonce) throw conflict('wallet-reconciliation-required')
          await client.query('UPDATE builder.wallet_executions SET request=$2,request_digest=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [saved.id, JSON.stringify(observed.request), digestJson(observed.request)])
          return { execution: await load(owner, saved.id, client) }
        }
        // A successfully mined step is never blindly signed again. Replenishing
        // allowance after fills requires a separately reviewed new plan.
        if ((await client.query("SELECT id FROM builder.wallet_executions WHERE plan_id=$1 AND owner=$2 AND step=$3 AND state='confirmed'", [plan.id, owner, value.step])).rowCount)
          throw conflict('wallet-step-completed')
        const id = randomUUID()
        await client.query(`INSERT INTO builder.wallet_executions(id,owner,plan_id,step,state,nonce,from_block,request,request_digest)
          VALUES($1,$2,$3,$4,'awaiting-wallet',$5,$6,$7,$8)`, [id, owner, plan.id, value.step, observed.request.nonce, observed.fromBlock, JSON.stringify(observed.request), digestJson(observed.request)])
        return { execution: await load(owner, id, client) }
      })
    },
    async reconcile(owner: string, input: unknown) {
      const value = reconcileSchema.parse(input), saved = await load(owner, value.executionId), plan = await trustedPlan(owner, saved.planId, false)
      const hash = value.transactionHash ?? saved.transactionHash
      const proof = await chain.reconcile(plan, saved.step, { nonce: saved.nonce, fromBlock: saved.fromBlock, transactionHash: hash })
      if (proof) {
        const state = proof.state === 'pending' && !['awaiting-wallet','pending'].includes(saved.state) ? 'unverified' : proof.state
        await pool.query(`UPDATE builder.wallet_executions SET state=$3,transaction_hash=$4,evidence=$5,version=version+1,updated_at=clock_timestamp()
          WHERE id=$1 AND owner=$2 AND version=$6`, [saved.id, owner, state, proof.transactionHash, JSON.stringify(proof.evidence), saved.version])
      } else if (saved.state !== 'rejected') {
        // Reorg/readback loss demotes a previous success. Never reuse its nonce
        // until canonical evidence is recovered. The unique owner fence applies.
        await pool.query("UPDATE builder.wallet_executions SET state=$3,transaction_hash=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND owner=$2 AND version=$5",
          [saved.id, owner, saved.state === 'awaiting-wallet' && !hash ? 'awaiting-wallet' : ['awaiting-wallet','pending'].includes(saved.state) ? 'pending' : 'unverified', hash, saved.version])
      }
      return { execution: await load(owner, saved.id) }
    },
    async rejected(owner: string, requestId: string, executionId: string) {
      const saved = await load(owner, executionId), plan = await trustedPlan(owner, saved.planId, false)
      if (saved.state !== 'awaiting-wallet' || saved.transactionHash || !await chain.unused(plan, saved.nonce)) throw conflict('wallet-reconciliation-required')
      return mutation(pool, owner, requestId, 'wallet-execution.rejected', { executionId }, async client => {
        const current = await load(owner, executionId, client, true)
        if (current.state !== 'awaiting-wallet' || current.transactionHash) throw conflict('wallet-reconciliation-required')
        await client.query("UPDATE builder.wallet_executions SET state='rejected',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [executionId])
        return { execution: await load(owner, executionId, client) }
      })
    },
    async list(owner: string, draftId: string) {
      ownerSchema.parse(owner); idSchema.parse(draftId)
      if (!(await pool.query('SELECT id FROM builder.drafts WHERE owner=$1 AND id=$2', [owner, draftId])).rowCount) throw notFound()
      return (await pool.query(`SELECT w.* FROM builder.wallet_executions w JOIN builder.transaction_plans p ON p.id=w.plan_id AND p.owner=w.owner
        WHERE w.owner=$1 AND (p.draft_id=$2 OR w.state IN ('awaiting-wallet','pending','unverified')) ORDER BY w.created_at DESC LIMIT 100`, [owner, draftId])).rows.map(entry)
    },
  }
  return service
}
