import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database, migrate, createStore, createRequirementReviews, createTemplates } from '../src/index.ts'
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
