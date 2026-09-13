import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { contentDigest, decodeGuardedOrder, digestJson, orderAbi, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { encodeAbiParameters, type Hex } from 'viem'
import { database, migrate, createStore, createArtifacts, createSimulations } from '../src/index.ts'
import { createTransactionPlans } from '../src/transaction-plans.ts'
import { createWalletExecution } from '../src/wallet-execution.ts'
import type { WalletChain, WalletOutcome } from '../src/wallet-chain.ts'

const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>
before(async () => { const url = new URL(process.env.BUILDER_TEST_DATABASE_URL!); admin = database(url.toString());
  await admin.query(`CREATE DATABASE "${name}"`); url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool) })
after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end() } })
async function fixture() {
  const owner = `wallet:0x${randomUUID().replaceAll('-', '')}12345678`, store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { title: 'Wallet execution unit fixture', kind: 'maker' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    allocations: { baseAtomic: '1000000000000000', quoteAtomic: '2500000' }, spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' },
      feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 3600, guardEnvelope: { maxAmountBasePerSwap: '100000000000000', maxAmountQuotePerSwap: '250000', maxPostBalanceBase: '2000000000000000', maxPostBalanceQuote: '5000000' } },
  } })
  const artifacts = createArtifacts(pool, profile), artifact = await artifacts.compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: draft.revision })
  const simulations = createSimulations(pool, profile), compilation = (await artifacts.get(owner, artifact.artifactId)).payload
  const simulate = async (mode: 'mock' | 'fork-with-overrides') => {
    await simulations.start(owner, randomUUID(), { artifactId: artifact.artifactId, draftId: draft.id, expectedRevision: draft.revision })
    const claim = (await simulations.claim())!
    // Unit fixture of a trusted worker result, not evidence of an actual fork.
    await simulations.finish(claim, { schemaVersion: 1, engineVersion: 'builder-lifecycle-v1', mode, draftId: draft.id, revision: draft.revision,
      artifactDigest: digestJson(compilation), manifestHash: compilation.manifestHash, passed: true, coverageComplete: true, registrationReady: false,
      cases: [{ name: 'unit-fixture-only', passed: true }] })
  }
  const plans = createTransactionPlans(pool, profile), args = { draftId: draft.id, expectedRevision: draft.revision, artifactId: artifact.artifactId }
  const { plan } = await plans.prepareRegistration(owner, randomUUID(), args)
  let nonce = 42, outcome: WalletOutcome | null = null
  const chain: WalletChain = {
    preflight: async (p, step) => ({ request: { chainId: profile.chainId, from: p.maker, to: p.transactions[step]!.to, data: p.transactions[step]!.data,
      value: '0x0', nonce: String(nonce), gas: '100000', expiresAt: new Date(Date.now() + 30000).toISOString() }, fromBlock: '100', blockHash: '0x' + '1'.repeat(64) as `0x${string}`, observedAt: new Date().toISOString() }),
    reconcile: async () => outcome, unused: async (_p, n) => n === String(nonce),
  }
  return { owner, store, draft, artifact, simulate, plans, args, plan, chain, service: createWalletExecution(pool, profile, chain),
    nextNonce() { nonce++ }, outcome(value: WalletOutcome | null) { outcome = value } }
}

test('wallet signing requires current verified simulation and serializes duplicate requests and Maker nonces', async () => {
  const f = await fixture(), input = { planId: f.plan.id, step: 0 }
  await assert.rejects(f.service.prepare(f.owner, randomUUID(), input), /wallet-simulation-required/)
  await f.simulate('mock'); await assert.rejects(f.service.prepare(f.owner, randomUUID(), input), /wallet-simulation-required/)
  await f.simulate('fork-with-overrides')
  const [a, b] = await Promise.all([f.service.prepare(f.owner, randomUUID(), input), f.service.prepare(f.owner, randomUUID(), input)])
  assert.equal(a.execution.id, b.execution.id)
  assert.equal((await f.service.list(f.owner, f.draft.id)).length, 1)
  await assert.rejects(f.service.prepare(f.owner, randomUUID(), { ...input, step: 1 }), /wallet-transaction-unresolved/)
  await assert.rejects(f.service.reconcile('wallet:0x' + '1'.repeat(40), { executionId: a.execution.id }), /not-found/)
  await f.service.rejected(f.owner, randomUUID(), a.execution.id)
  assert.equal((await f.service.prepare(f.owner, randomUUID(), { ...input, step: 1 })).execution.state, 'awaiting-wallet')
})

test('receipt recovery survives revisions and lost responses; a completed step is never sent again', async () => {
  const f = await fixture(); await f.simulate('fork-with-overrides')
  const { execution } = await f.service.prepare(f.owner, randomUUID(), { planId: f.plan.id, step: 0 })
  const changed = await f.store.patch(f.owner, randomUUID(), { draftId: f.draft.id, expectedRevision: f.draft.revision, patch: { spec: { title: 'Later conversation revision' } } })
  f.outcome({ state: 'confirmed', transactionHash: '0x' + '2'.repeat(64) as `0x${string}`, evidence: { mode: 'unit-fixture', matchesPlan: true } })
  assert.equal((await f.service.reconcile(f.owner, { executionId: execution.id })).execution.state, 'confirmed')
  await assert.rejects(f.service.prepare(f.owner, randomUUID(), { planId: f.plan.id, step: 1 }), /wallet-plan-stale/)
  const historical = await f.plans.prepareCancellation(f.owner, randomUUID(), { ...f.args, expectedRevision: changed.draft.revision })
  assert.equal(historical.plan.revision, f.draft.revision)
  assert.equal(historical.plan.strategyHash, f.plan.strategyHash)
  f.nextNonce()
  assert.equal((await f.service.prepare(f.owner, randomUUID(), { planId: historical.plan.id, step: 0 })).execution.state, 'awaiting-wallet')
})

test('late pending RPC results cannot overwrite a newer verified receipt and reorg evidence remains unresolved', async () => {
  const f = await fixture(); await f.simulate('fork-with-overrides')
  const { execution } = await f.service.prepare(f.owner, randomUUID(), { planId: f.plan.id, step: 0 })
  let finish: (v: WalletOutcome | null) => void = () => {}, entered: () => void = () => {}
  const started = new Promise<void>(resolve => { entered = resolve })
  f.chain.reconcile = async () => { entered(); return new Promise(resolve => { finish = resolve }) }
  const slow = f.service.reconcile(f.owner, { executionId: execution.id }); await started
  const hash = '0x' + '3'.repeat(64) as `0x${string}`
  f.chain.reconcile = async () => ({ state: 'confirmed', transactionHash: hash, evidence: { mode: 'unit-fixture' } })
  await f.service.reconcile(f.owner, { executionId: execution.id })
  finish({ state: 'pending', transactionHash: hash, evidence: {} }); await slow
  assert.equal((await f.service.list(f.owner, f.draft.id))[0]!.state, 'confirmed')
  f.chain.reconcile = async () => null
  assert.equal((await f.service.reconcile(f.owner, { executionId: execution.id })).execution.state, 'unverified')
  await assert.rejects(f.service.prepare(f.owner, randomUUID(), { planId: f.plan.id, step: 1 }), /wallet-transaction-unresolved/)
})

test('legacy fee artifacts remain recoverable for dock and revoke while registration and unrevocation are blocked', async () => {
  const f = await fixture(), original = (await createArtifacts(pool, profile).get(f.owner, f.artifact.artifactId)).payload
  const { draft } = await f.store.patch(f.owner, randomUUID(), { draftId: f.draft.id, expectedRevision: f.draft.revision, patch: { spec: { feeBps: 30 } } })
  const data = (original.program.slice(0, 16) + '1504002dc6c0' + original.program.slice(16)) as Hex
  const order = { ...original.order, data }, strategy = encodeAbiParameters(orderAbi, [{ ...order, traits: BigInt(order.traits) }]), decoded = decodeGuardedOrder(strategy)
  const artifactId = randomUUID(), payload = { ...original, revision: draft.revision, contentDigest: contentDigest(draft),
    specHash: digestJson({ spec: draft.spec, maker: draft.maker, allocations: draft.allocations, salt: draft.salt }),
    program: data, strategy, order, decoded, programHash: decoded.programHash, strategyHash: decoded.strategyHash, orderHash: decoded.orderHash,
    params: { ...original.params, program: { ...original.params.program, feeBps: 30 }, meta: { ...original.params.meta, paramsRevision: draft.revision } } }
  // Immutable fixture from the legacy encoder; new compilation cannot create it.
  await pool.query(`INSERT INTO builder.compiled_artifacts(id,owner,draft_id,revision,manifest_hash,content_digest,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [artifactId, f.owner, draft.id, draft.revision, payload.manifestHash, payload.contentDigest, digestJson(payload), JSON.stringify(payload)])
  const args = { draftId: draft.id, expectedRevision: draft.revision, artifactId }
  await assert.rejects(f.plans.prepareRegistration(f.owner, randomUUID(), args), /artifact-stale/)
  for (const kind of ['cancellation', 'guard-revoke', 'allowance-revoke'] as const) {
    const { plan } = kind === 'cancellation' ? await f.plans.prepareCancellation(f.owner, randomUUID(), args) : await f.plans.prepareControl(f.owner, randomUUID(), kind, args)
    const result = await f.service.prepare(f.owner, randomUUID(), { planId: plan.id, step: 0 })
    assert.equal(result.execution.state, 'awaiting-wallet')
    await f.service.rejected(f.owner, randomUUID(), result.execution.id)
  }
  const { plan } = await f.plans.prepareControl(f.owner, randomUUID(), 'guard-unrevoke', args)
  await assert.rejects(f.service.prepare(f.owner, randomUUID(), { planId: plan.id, step: 0 }), /fee-guard-incompatible/)
})
