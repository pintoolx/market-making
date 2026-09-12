import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertArtifactCurrent, contentDigest, DraftAccessDenied, DraftConflict, draftSchema, getCapabilities,
  patchDraft, restoreDraft, AQUA_OPCODES } from '../src/index.ts'

const now = '2026-09-13T03:00:00.000Z'
const start = () => draftSchema.parse({ schemaVersion: 1, id: 'draft-one', owner: 'privy:alice', revision: 1, kind: 'template',
  spec: { title: '我的 WETH/USDC', profileId: 'sepolia-standing-v2', feeBps: 0,
    model: { kind: 'concentrated', minPrice: '2000', maxPrice: '3000' }, modifiers: [{ kind: 'decay', periodSeconds: 30 }] },
  requirements: [{ id: 'r-inventory', text: '限制成交後 WETH 庫存', priority: 'must', sourceMessageId: 'message-1', capabilityIds: ['guard.inventory'] }],
  salt: '123', createdAt: now, updatedAt: now })
const change = (draft: ReturnType<typeof start>, patch: unknown) => patchDraft(draft, patch, { owner: draft.owner, expectedRevision: draft.revision, now })

test('multi-turn narrowing, fee edit and restore retain other requirements and invalidate old reviews', () => {
  const first = start()
  const review = { draftId: first.id, revision: 1, contentDigest: contentDigest(first), manifestHash: 'manifest-one' }
  const second = change(first, { spec: { model: { kind: 'concentrated', minPrice: '2200', maxPrice: '2800' } } })
  assert.equal(second.draft.revision, 2)
  assert.deepEqual(second.draft.requirements, first.requirements)
  assert.deepEqual(second.draft.spec.modifiers, first.spec.modifiers)
  assert.deepEqual(second.diff.map(d => d.path), ['spec.model.maxPrice', 'spec.model.minPrice'])
  const third = change(second.draft, { spec: { feeBps: 10 }, upsertRequirements: [{
    id: 'r-volatility', text: '希望能在波動增大時暫停', priority: 'must', sourceMessageId: 'message-3', capabilityIds: ['policy.market-rules'],
  }] })
  assert.equal(third.draft.requirements.length, 2)
  assert.deepEqual(third.draft.spec.model, second.draft.spec.model)
  assert.throws(() => assertArtifactCurrent(review, third.draft, 'manifest-one'), DraftConflict)
  const restored = restoreDraft(third.draft, first, { owner: first.owner, expectedRevision: 3, now })
  assert.equal(restored.draft.revision, 4)
  assert.deepEqual(restored.draft.spec, first.spec)
  assert.equal(restored.draft.salt, first.salt)
  assert.throws(() => assertArtifactCurrent(review, restored.draft, 'manifest-one'), DraftConflict)
})

test('patch cannot smuggle owner, approval, private policy or arbitrary calldata and cannot cross revision/owner boundaries', () => {
  const draft = start()
  for (const patch of [{ owner: 'mallory' }, { revision: 99 }, { spec: { calldata: '0x' } }, { privatePolicy: { priceMin: '100' } },
    { upsertRequirements: [{ ...draft.requirements[0], userAcceptedAlternative: true }] }]) assert.throws(() => change(draft, patch))
  assert.throws(() => patchDraft(draft, {}, { owner: 'privy:bob', expectedRevision: 1, now }), DraftAccessDenied)
  assert.throws(() => patchDraft(draft, {}, { owner: draft.owner, expectedRevision: 9, now }), DraftConflict)
  assert.throws(() => change(draft, { maker: '0x0000000000000000000000000000000000000001' }), /instance/)
  assert.throws(() => change(draft, { upsertRequirements: [draft.requirements[0], draft.requirements[0]] }))
})

test('empty or identical patches preserve revision and existing modifiers', () => {
  const first = start()
  assert.deepEqual(change(first, {}).draft, first)
  assert.equal(change(first, { spec: { title: first.spec.title } }).changed, false)
  assert.equal(change(first, { spec: { modifiers: [] } }).draft.spec.modifiers.length, 0)
})

test('editing one curve parameter preserves the rest; changing curve or relative-range intent clears incompatible settings', () => {
  const first = start()
  const second = change(first, { spec: { model: { kind: 'concentrated', minPrice: '2100' } } }).draft
  assert.deepEqual(second.spec.model, { kind: 'concentrated', minPrice: '2100', maxPrice: '3000' })
  const third = change(second, { spec: { model: { kind: 'xyc' } } }).draft
  assert.deepEqual(third.spec.model, { kind: 'xyc' })
  assert.deepEqual(third.requirements, first.requirements)
  const relative = change(second, { spec: { model: { kind: 'concentrated', relativeWidthBps: 500 } } }).draft
  assert.deepEqual(relative.spec.model, { kind: 'concentrated', relativeWidthBps: 500 })
  const absolute = change(relative, { spec: { model: { kind: 'concentrated', minPrice: '2000', maxPrice: '3000' } } }).draft
  assert.deepEqual(absolute.spec.model, { kind: 'concentrated', minPrice: '2000', maxPrice: '3000' })
})

test('changing an accepted alternative invalidates its acceptance; unknown private fields are rejected on persisted drafts', () => {
  const draft = start()
  draft.requirements[0]!.userAcceptedAlternative = true
  const updated = change(draft, { upsertRequirements: [{ id: 'r-inventory', text: '改為不同庫存限制', priority: 'must',
    sourceMessageId: 'message-4', capabilityIds: ['guard.inventory'] }] })
  assert.equal(updated.draft.requirements[0]!.userAcceptedAlternative, false)
  assert.throws(() => draftSchema.parse({ ...draft, secret: 'must not persist' }))
})

test('capabilities enumerate the deployed table including reserved gaps and keep readiness layers distinct', () => {
  assert.equal(AQUA_OPCODES.length, 34)
  assert.equal(AQUA_OPCODES[13], 'deadline')
  assert.equal(AQUA_OPCODES[32], 'extruction')
  assert.equal(AQUA_OPCODES[22], 'reserved')
  const all = getCapabilities()
  for (const [opcode, name] of AQUA_OPCODES.entries()) {
    if (name !== 'reserved') assert.ok(all.some(c => c.opcodes.includes(opcode)), `${name} is not accounted for`)
  }
  const fee = getCapabilities({ ids: ['fee.lp-input'] })[0]!
  assert.equal(fee.sourceImplemented.state, 'verified')
  assert.equal(fee.productEnabled.state, 'blocked')
  assert.equal(fee.routingCompatible.state, 'unverified')
  fee.productEnabled.state = 'verified'
  assert.equal(getCapabilities({ ids: [fee.id] })[0]!.productEnabled.state, 'blocked')
  assert.ok(getCapabilities({ text: '波動' }).some(c => c.id === 'policy.market-rules'))
})
