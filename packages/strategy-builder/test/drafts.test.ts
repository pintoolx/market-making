import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertArtifactCurrent, contentDigest, DraftAccessDenied, DraftConflict, draftSchema, getCapabilities,
  patchDraft, restoreDraft, AQUA_OPCODES, sepoliaStandingProfile as profile, validateStrategy } from '../src/index.ts'

const now = '2026-09-13T03:00:00.000Z'
const start = () => draftSchema.parse({ schemaVersion: 1, id: 'draft-one', owner: 'privy:alice', revision: 1, kind: 'template',
  spec: { title: 'My WETH/USDC', profileId: 'sepolia-standing-v2', feeBps: 0,
    model: { kind: 'concentrated', minPrice: '2000', maxPrice: '3000' }, modifiers: [{ kind: 'decay', periodSeconds: 30 }] },
  requirements: [{ id: 'r-inventory', text: 'Limit post-swap WETH inventory', priority: 'must', sourceMessageId: 'message-1', capabilityIds: ['guard.inventory'] }],
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
    id: 'r-volatility', text: 'Pause when volatility rises', priority: 'must', sourceMessageId: 'message-3', capabilityIds: ['policy.market-rules'],
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
  const updated = change(draft, { upsertRequirements: [{ id: 'r-inventory', text: 'Change inventory limits', priority: 'must',
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
  assert.equal(fee.productEnabled.state, 'verified')
  assert.equal(fee.routingCompatible.state, 'unverified')
  fee.productEnabled.state = 'blocked'
  assert.equal(getCapabilities({ ids: [fee.id] })[0]!.productEnabled.state, 'verified')
  assert.ok(getCapabilities({ text: 'volatility' }).some(c => c.id === 'policy.market-rules'))
})

test('individual Guard limits and allocations persist across turns but cannot become executable while incomplete', () => {
  let d = draftSchema.parse({ ...start(), kind: 'maker', maker: '0x1111111111111111111111111111111111111111', spec: {
    title: 'Incremental confirmation', profileId: profile.id, baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0, deadline: 10000,
  } })
  const limits = { maxAmountBasePerSwap: '50000000000000000', maxAmountQuotePerSwap: '125000000', maxPostBalanceBase: '2000000000000000000', maxPostBalanceQuote: '5000000000' }
  const expected: Record<string, string> = {}
  for (const [field, value] of Object.entries(limits)) {
    expected[field] = value
    d = change(d, { spec: { guardEnvelope: { [field]: value } } }).draft
    assert.deepEqual(d.spec.guardEnvelope, expected)
    const validation = validateStrategy(d, profile, 1)
    assert.equal(validation.ready, false); assert.deepEqual(validation.errors, [])
    assert.deepEqual(validation.missingFields.filter(f => f.startsWith('spec.guardEnvelope.')),
      Object.keys(limits).filter(f => !(f in expected)).map(f => `spec.guardEnvelope.${f}`))
  }
  d = change(d, { allocations: { baseAtomic: '1000000000000000000' } }).draft
  assert.deepEqual(validateStrategy(d, profile, 1).missingFields, ['allocations.quoteAtomic'])
  const partial = d
  d = change(d, { allocations: { quoteAtomic: '1000000000' } }).draft
  assert.deepEqual(d.allocations, { baseAtomic: '1000000000000000000', quoteAtomic: '1000000000' })
  assert.equal(validateStrategy(d, profile, 1).ready, true)
  const smaller = change(d, { spec: { guardEnvelope: { maxAmountBasePerSwap: '10000000000000000' } } }).draft
  assert.deepEqual(smaller.spec.guardEnvelope, { ...limits, maxAmountBasePerSwap: '10000000000000000' })
  assert.equal(validateStrategy(change(d, { allocations: { quoteAtomic: '5000000001' } }).draft, profile, 1).errors[0]?.code, 'inventory-above-envelope')
  const restored = restoreDraft(smaller, partial, { owner: d.owner, expectedRevision: smaller.revision, now }).draft
  assert.equal(validateStrategy(restored, profile, 1).ready, false)
  assert.deepEqual(restored.allocations, partial.allocations)
  assert.throws(() => change(d, { spec: { guardEnvelope: { maxPostBalanceBase: '0' } } }))
})

test('direct patches cannot relabel existing atomic amounts or price intent with a different pair', () => {
  const d = draftSchema.parse({ ...start(), spec: { ...start().spec, baseToken: profile.tokens[0], quoteToken: profile.tokens[1] } })
  assert.throws(() => change(d, { spec: { baseToken: profile.tokens[1], quoteToken: profile.tokens[0] } }), /requires a new draft/)
  const plain = change(d, { spec: { model: { kind: 'xyc' } } }).draft
  const capped = change(plain, { spec: { guardEnvelope: { maxAmountBasePerSwap: '1' } } }).draft
  assert.throws(() => change(capped, { spec: { baseToken: profile.tokens[1] } }), /requires a new draft/)
  assert.equal(change(capped, { spec: { baseToken: profile.tokens[0] } }).changed, false)
})
