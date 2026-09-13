import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { canonical, contentDigest, digestJson, idSchema, revisionSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { readCompiledArtifact, type CompiledPayload } from './artifacts.ts'
import { readOwnedDraft } from './draft-persistence.ts'
import { transaction } from './database.ts'
import { conflict, notFound, ServiceError } from './errors.ts'
import { mutation, ownerSchema } from './requests.ts'
import { readRequirementReceipt } from './requirement-reviews.ts'

const registrationInput = zodPlanInput('registration')
const cancellationInput = zodPlanInput('cancellation')
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount)'])
const aquaAbi = parseAbi([
  'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32 strategyHash)',
  'function dock(address app, bytes32 strategyHash, address[] tokens)',
])
type PlanKind = 'registration' | 'cancellation'
type PlanInput = { draftId: string; expectedRevision: number; artifactId: string }
type Transaction = { kind: string; to: Hex; data: Hex; value: '0x0'; description: string; spender?: Hex; token?: Hex; amountAtomic?: string }
export interface TransactionPlan {
  schemaVersion: 1; kind: PlanKind; id: string; chainId: number; owner: string; maker: Hex; draftId: string; revision: number;
  artifactId: string; contentDigest: `0x${string}`; manifestHash: `0x${string}`; strategyHash: Hex; programHash: Hex; orderHash: Hex;
  tokens: Hex[]; amounts: string[]; transactions: Transaction[]; preconditions: string[]; registrationReady: false;
}
function zodPlanInput(kind: PlanKind) {
  // Kept local to avoid making the public domain schema aware of unsigned execution details.
  return (input: unknown): PlanInput => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid-request')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(k => !['draftId', 'expectedRevision', 'artifactId'].includes(k))) throw new ServiceError('invalid-request')
    return { draftId: idSchema.parse(value.draftId), expectedRevision: revisionSchema.parse(value.expectedRevision), artifactId: idSchema.parse(value.artifactId) }
  }
}
function orderOf(payload: CompiledPayload) {
  return { maker: payload.order.maker, traits: BigInt(payload.order.traits), data: payload.order.data }
}
function makePlan(kind: PlanKind, id: string, profile: DeploymentProfile, draft: Awaited<ReturnType<typeof readOwnedDraft>>,
  artifactId: string, payload: CompiledPayload): TransactionPlan {
  const tokens = payload.tokens as Hex[], amounts = payload.amounts.map(String), maker = draft.maker! as Hex
  const transactions: Transaction[] = []
  if (kind === 'registration') for (const [index, token] of tokens.entries()) {
    const amountAtomic = amounts[index]!
    transactions.push({ kind: 'erc20-approve', to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [profile.aqua, BigInt(amountAtomic)] }),
      value: '0x0', description: `Approve ${token} to Aqua for the shipped allocation`, spender: profile.aqua, token, amountAtomic })
  }
  transactions.push(kind === 'registration'
    ? { kind: 'aqua-ship', to: profile.aqua, data: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [profile.router, payload.strategy, tokens, amounts.map(BigInt)] }), value: '0x0', description: 'Ship this immutable strategy to Aqua' }
    : { kind: 'aqua-dock', to: profile.aqua, data: encodeFunctionData({ abi: aquaAbi, functionName: 'dock', args: [profile.router, payload.strategyHash, tokens] }), value: '0x0', description: 'Dock this strategy and close its Aqua balances' })
  return { schemaVersion: 1, kind, id, chainId: profile.chainId, owner: draft.owner, maker, draftId: draft.id, revision: draft.revision,
    artifactId, contentDigest: contentDigest(draft), manifestHash: digestJson(profile), strategyHash: payload.strategyHash, programHash: payload.programHash, orderHash: payload.orderHash,
    tokens, amounts, transactions, preconditions: kind === 'registration'
      ? ['Wallet is the Maker address and connected to the profile chain', 'Current token balances and allowances are freshly read before signing', 'Current requirement receipt, if any, is still valid', 'Ship receipt and Aqua rawBalances are read back before enabling reports']
      : ['Wallet is the Maker address and connected to the profile chain', 'The strategy hash is still present and active state is read before signing', 'Dock receipt and Aqua rawBalances are read back before marking stopped'], registrationReady: false }
}
async function ensureRequirements(client: PoolClient, profile: DeploymentProfile, draft: Awaited<ReturnType<typeof readOwnedDraft>>) {
  if (draft.requirements.length && !await readRequirementReceipt(client, profile, draft)) throw conflict('requirement-review-required')
}
export function createTransactionPlans(pool: Pool, profile: DeploymentProfile) {
  async function prepare(owner: string, requestId: string, kind: PlanKind, input: unknown) {
    ownerSchema.parse(owner); const value = kind === 'registration' ? registrationInput(input) : cancellationInput(input)
    return mutation(pool, owner, requestId, `transaction-plan.${kind}`, value, async client => {
      const draft = await readOwnedDraft(client, owner, value.draftId, true)
      if (draft.revision !== value.expectedRevision) throw conflict('draft-changed')
      if (draft.kind !== 'maker' || draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
      if (kind === 'registration') await ensureRequirements(client, profile, draft)
      const artifact = await readCompiledArtifact(client, profile, owner, value.artifactId, true)
      if (artifact.payload.draftId !== draft.id || artifact.payload.revision !== draft.revision || !artifact.current) throw conflict('artifact-stale')
      if (canonical(artifact.payload.tokens) !== canonical([draft.spec.baseToken!.address, draft.spec.quoteToken!.address])) throw new ServiceError('transaction-plan-integrity', 500)
      const plan = makePlan(kind, randomUUID(), profile, draft, value.artifactId, artifact.payload), payloadDigest = digestJson(plan)
      await client.query(`INSERT INTO builder.transaction_plans(id,owner,draft_id,revision,artifact_id,kind,manifest_hash,content_digest,strategy_hash,payload_digest,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [plan.id, owner, draft.id, draft.revision, value.artifactId, kind, plan.manifestHash, plan.contentDigest, plan.strategyHash, payloadDigest, JSON.stringify(plan)])
      await client.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES($1,$2,$3,$4)", [owner, `transaction-plan.${kind}`, plan.id, draft.revision])
      return { plan, digest: payloadDigest }
    })
  }
  return {
    prepareRegistration: (owner: string, requestId: string, input: unknown) => prepare(owner, requestId, 'registration', input),
    prepareCancellation: (owner: string, requestId: string, input: unknown) => prepare(owner, requestId, 'cancellation', input),
    async get(owner: string, planId: string) {
      ownerSchema.parse(owner); idSchema.parse(planId)
      const row = (await pool.query('SELECT payload,payload_digest FROM builder.transaction_plans WHERE id=$1 AND owner=$2', [planId, owner])).rows[0]
      if (!row) throw notFound()
      const plan = row.payload as TransactionPlan
      if (row.payload_digest !== digestJson(plan) || plan.owner !== owner || plan.id !== planId || plan.manifestHash !== digestJson(profile) || plan.registrationReady !== false)
        throw new ServiceError('transaction-plan-integrity', 500)
      return { plan, digest: row.payload_digest as `0x${string}` }
    },
  }
}
