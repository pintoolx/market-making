import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database, migrate, createStore, createRequirementReviews, createTemplates, createArtifacts, createTransactionPlans, createAutomation, revokeMessage } from '../src/index.ts'
import { defaultTemplatePermissions, digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>, url: URL
before(async () => {
  url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
})
after(async () => {
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
})

async function requirementDraft() {
  const account = privateKeyToAccount(generatePrivateKey()), owner = 'wallet:' + account.address.toLowerCase()
  const store = createStore(pool, profile.id), created = await store.create(owner, randomUUID(), { title: '需求確認模板', kind: 'template' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0,
      deadline: Math.floor(Date.now() / 1000) + 86400,
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
    upsertRequirements: [{ id: 'per-swap', text: '每筆基礎幣輸入不超過 0.005', priority: 'must', sourceMessageId: 'message-1', capabilityIds: ['guard.directions'],
      criteria: [{ type: 'parameter', field: 'maxAmountBasePerSwap', relation: 'at-most', expected: '0.005' }] }],
  } })
  return { account, owner, store, draft }
}

test('requirement review is a separate immutable receipt bound to the exact draft revision and publication gate', async () => {
  const p = await requirementDraft(), reviews = createRequirementReviews(pool, profile), templates = createTemplates(pool, profile, { origin: 'https://pintool.example', workflowPublicKey: '11'.repeat(32) })
  await assert.rejects(templates.prepare(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 2, templateId: null, permissions: defaultTemplatePermissions }), /requirement-review-required/)
  const prepared = await reviews.prepare(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 2 })
  assert.equal(prepared.review.registrationReady, false); assert.equal(prepared.review.requirements[0]!.criteria[0]!.matchesDraft, true)
  const confirmed = await reviews.confirm(p.owner, randomUUID(), { reviewId: prepared.review.id, digest: prepared.digest,
    decisions: [{ requirementId: 'per-swap', decision: 'confirm' }] })
  assert.equal(confirmed.receipt.userConfirmed, true); assert.equal(confirmed.receipt.revision, 2); assert.equal(confirmed.receipt.needsRecompile, false)
  assert.deepEqual((await reviews.current(p.owner, p.draft.id, 2)).receipt, confirmed.receipt)
  assert.deepEqual((await reviews.confirm(p.owner, randomUUID(), { reviewId: prepared.review.id, digest: prepared.digest,
    decisions: [{ requirementId: 'per-swap', decision: 'confirm' }] })).receipt, confirmed.receipt)
  await assert.rejects(reviews.confirm(p.owner, randomUUID(), { reviewId: prepared.review.id, digest: prepared.digest,
    decisions: [{ requirementId: 'per-swap', decision: 'accept-limitation' }] }), /already-confirmed/)
  const intent = (await pool.query('SELECT payload FROM builder.requirement_review_intents WHERE id=$1', [prepared.review.id])).rows[0].payload
  assert.equal(digestJson(intent), prepared.digest)
  const publication = await templates.prepare(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 2, templateId: null, permissions: defaultTemplatePermissions })
  assert.equal(publication.registrationReady, false)
})

test('an unmet interpreted criterion cannot be confirmed as true; explicit limitation creates a new revision and invalidates the old review', async () => {
  const p = await requirementDraft(), reviews = createRequirementReviews(pool, profile)
  await p.store.patch(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 2, patch: { upsertRequirements: [{
    id: 'per-swap', text: '每筆基礎幣輸入不超過 0.004', priority: 'must', sourceMessageId: 'message-2', capabilityIds: ['guard.directions'],
    criteria: [{ type: 'parameter', field: 'maxAmountBasePerSwap', relation: 'at-most', expected: '0.004' }],
  }] } })
  const prepared = await reviews.prepare(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 3 })
  await assert.rejects(reviews.confirm(p.owner, randomUUID(), { reviewId: prepared.review.id, digest: prepared.digest,
    decisions: [{ requirementId: 'per-swap', decision: 'confirm' }] }), /unmet requirement/)
  const result = await reviews.confirm(p.owner, randomUUID(), { reviewId: prepared.review.id, digest: prepared.digest,
    decisions: [{ requirementId: 'per-swap', decision: 'accept-limitation' }] })
  assert.equal(result.receipt.revision, 4); assert.equal(result.receipt.needsRecompile, false)
  assert.equal((await reviews.current(p.owner, p.draft.id, 4)).receipt?.reviewId, prepared.review.id)
  await assert.rejects(reviews.current(p.owner, p.draft.id, 3), /draft-changed/)
  assert.equal((await pool.query("SELECT kind FROM builder.outbox WHERE owner=$1 AND kind='requirements.confirmed'", [p.owner])).rowCount, 1)
})

test('registration and cancellation plans are immutable unsigned calldata bound to the current compiled hash', async () => {
  const account = privateKeyToAccount(generatePrivateKey()), owner = 'wallet:' + account.address.toLowerCase(), store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { title: 'Maker 計畫', kind: 'maker' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0,
      deadline: Math.floor(Date.now() / 1000) + 86400,
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' },
  } })
  const artifact = await createArtifacts(pool, profile).compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2 })
  const plans = createTransactionPlans(pool, profile), registration = await plans.prepareRegistration(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, artifactId: artifact.artifactId })
  assert.equal(registration.plan.registrationReady, false); assert.equal(registration.plan.transactions.length, 3)
  assert.deepEqual(registration.plan.transactions.map(t => t.kind), ['erc20-approve', 'erc20-approve', 'aqua-ship'])
  assert.ok(registration.plan.transactions.every(t => !('signature' in t) && t.value === '0x0'))
  assert.deepEqual((await plans.get(owner, registration.plan.id)).plan, registration.plan)
  const cancellation = await plans.prepareCancellation(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, artifactId: artifact.artifactId })
  assert.deepEqual(cancellation.plan.transactions.map(t => t.kind), ['aqua-dock'])
  await store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, patch: { spec: { title: '已修改的 Maker' } } })
  await assert.rejects(plans.prepareRegistration(owner, randomUUID(), { draftId: draft.id, expectedRevision: 3, artifactId: artifact.artifactId }), /artifact-stale/)
  await assert.rejects(plans.get('wallet:0x1111111111111111111111111111111111111111', registration.plan.id), /not-found/)
  const row = (await pool.query('SELECT payload,payload_digest FROM builder.transaction_plans WHERE id=$1', [registration.plan.id])).rows[0]
  assert.equal(row.payload_digest, digestJson(row.payload))
})

test('standing delivery requires an explicit Maker signature and is revocable without exposing a signing tool', async () => {
  const account = privateKeyToAccount(generatePrivateKey()), owner = 'wallet:' + account.address.toLowerCase(), store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { title: '事件續期 Maker', kind: 'maker' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0,
      deadline: Math.floor(Date.now() / 1000) + 86400,
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' },
  } })
  const artifact = await createArtifacts(pool, profile).compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2 })
  const automation = createAutomation(pool, profile)
  const prepared = await automation.prepare(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, artifactId: artifact.artifactId })
  assert.equal(prepared.intent.registrationReady, false); assert.match(prepared.intent.message, /standing-report-delivery/)
  const signature = await account.signMessage({ message: prepared.intent.message })
  const confirmed = await automation.confirm(owner, randomUUID(), { intentId: prepared.intent.id, digest: prepared.digest, signature })
  assert.equal(confirmed.consent.active, true); assert.equal(confirmed.consent.registrationReady, false)
  assert.deepEqual((await automation.current(owner, draft.id, 2)).consent, confirmed.consent)
  const revoked = await automation.revoke(owner, randomUUID(), { consentId: confirmed.consent.id,
    signature: await account.signMessage({ message: revokeMessage(confirmed.consent) }) })
  assert.equal(revoked.consent.active, false)
  assert.equal((await automation.current(owner, draft.id, 2)).consent, null)
  const attacker = privateKeyToAccount(generatePrivateKey())
  await assert.rejects(automation.confirm('wallet:' + attacker.address.toLowerCase(), randomUUID(), { intentId: prepared.intent.id, digest: prepared.digest, signature }), /not-found/)
})
