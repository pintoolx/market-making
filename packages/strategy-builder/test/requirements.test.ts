import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acknowledgeRequirements, assessRequirementCriteria, assessRequirementCriterion, canonical, contentDigest, draftSchema, patchDraft, requirementInputSchema,
  restoreDraft, sepoliaStandingProfile as profile, type RequirementCriterion } from '../src/index.ts'

function fixture() {
  const now = '2026-09-13T00:00:00.000Z'
  return draftSchema.parse({ schemaVersion: 1, id: 'review-draft', revision: 1, kind: 'maker', owner: 'wallet:0x2222222222222222222222222222222222222222',
    maker: '0x2222222222222222222222222222222222222222', salt: '42', createdAt: now, updatedAt: now,
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' },
    spec: { title: 'Requirement review', profileId: profile.id, baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'concentrated', minPrice: '2200', maxPrice: '2800' },
      feeBps: 0, deadline: 2_000_000_000, guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
    requirements: [{ id: 'per-swap', text: 'Each WETH input is at most 0.005', priority: 'must', sourceMessageId: 'message-1', capabilityIds: ['guard.per-swap'] }] })
}
const parameter = (field: Extract<RequirementCriterion, {type:'parameter'}>['field'], expected: string,
  relation: 'equal' | 'at-most' | 'at-least' = 'equal'): RequirementCriterion => ({ type: 'parameter', field, expected, relation })

test('proposed parameter meanings use exact token units and separate configured caps from guarantees', () => {
  const draft = fixture(), compare = (c: RequirementCriterion) => assessRequirementCriterion(c, draft)
  assert.equal(compare(parameter('maxAmountBasePerSwap', '0.005', 'at-most')).matchesDraft, true)
  assert.equal(compare(parameter('maxAmountBasePerSwap', '0.004999999999999999', 'at-most')).matchesDraft, false)
  assert.equal(compare(parameter('maxAmountQuotePerSwap', '12.500001', 'at-most')).matchesDraft, true)
  assert.equal(compare(parameter('maxAmountQuotePerSwap', '12.499999', 'at-most')).matchesDraft, false)
  assert.match(compare(parameter('maxPostBalanceBase', '0.02')).limitation, /not a daily cumulative/)
  const allocation = compare(parameter('allocationQuote', '25'))
  assert.equal(allocation.matchesDraft, true); assert.equal(allocation.enforcement, 'preflight_only')
  assert.match(allocation.limitation, /not independently reserved/)
  assert.equal(compare(parameter('baseToken', 'USDC')).matchesDraft, false)
  assert.equal(compare(parameter('curve', 'concentrated')).matchesDraft, true)
  assert.match(compare(parameter('minPrice', '2200', 'at-least')).limitation, /not an external market-price check on every swap/)
  assert.equal(compare(parameter('maxAmountQuotePerSwap', '0.0000001')).enforcement, 'unsupported')
  assert.equal(compare(parameter('feeBps', '0.1')).enforcement, 'unsupported')
  assert.equal(compare(parameter('curve', 'concentrated', 'at-least')).enforcement, 'unsupported')
  assert.equal(assessRequirementCriterion(parameter('feeBps', '30'), { ...draft, spec: { ...draft.spec, feeBps: 30 } }).enforcement, 'unsupported')
  assert.match(compare(parameter('feeBps', '30')).limitation, /gross input/)
})

test('only explicit complete decisions can acknowledge interpreted requirements; limitations create a new revision', () => {
  const draft = fixture(), context = { owner: draft.owner, expectedRevision: 1, now: draft.updatedAt }
  const confirm = [{ requirementId: 'per-swap', decision: 'confirm' }]
  const waive = [{ requirementId: 'per-swap', decision: 'accept-limitation' }]
  assert.throws(() => acknowledgeRequirements(draft, waive, context), /clarification/)
  draft.requirements[0]!.criteria = [parameter('maxAmountBasePerSwap', '0.005', 'at-most')]
  assert.equal(acknowledgeRequirements(draft, confirm, context).changed, false)
  assert.throws(() => acknowledgeRequirements(draft, confirm, { ...context, owner: 'wallet:another' }), /another user/)
  assert.throws(() => acknowledgeRequirements(draft, confirm, { ...context, expectedRevision: 2 }), /changed/)
  for (const decisions of [[], [...confirm, ...confirm], [{ requirementId: 'other', decision: 'confirm' }]])
    assert.throws(() => acknowledgeRequirements(draft, decisions, context), /explicit decision/)
  draft.requirements[0]!.criteria = [parameter('maxAmountBasePerSwap', '0.004', 'at-most')]
  assert.throws(() => acknowledgeRequirements(draft, confirm, context), /unmet requirement/)
  const accepted = acknowledgeRequirements(draft, waive, context)
  assert.equal(accepted.draft.revision, 2); assert.equal(accepted.draft.requirements[0]!.userAcceptedAlternative, true)
  assert.equal(assessRequirementCriteria(accepted.draft)[0]!.userConfirmed, false)
  draft.requirements[0]!.criteria = [{ type: 'unsupported', topic: 'daily-cumulative-budget' }]
  assert.throws(() => acknowledgeRequirements(draft, confirm, context), /unmet requirement/)
  assert.equal(acknowledgeRequirements(draft, waive, context).changed, true)
  draft.requirements[0]!.criteria = [parameter('referencePrice', '2500')]
  assert.throws(() => acknowledgeRequirements(draft, waive, context), /clarification/)
  draft.requirements[0]!.criteria = [{ type: 'mechanism', capabilityId: 'guard.standing' }]
  assert.equal(acknowledgeRequirements(draft, confirm, context).changed, false)
  assert.throws(() => acknowledgeRequirements(draft, [{ ...confirm[0], userConfirmed: true }], context))
})

test('mechanism descriptions, missing fields and unsupported effects never claim an active authorization or user confirmation', () => {
  const draft = fixture()
  const policy = assessRequirementCriterion({ type: 'mechanism', capabilityId: 'policy.market-rules' }, draft)
  assert.equal(policy.matchesDraft, null); assert.equal(policy.enforcement, 'informational'); assert.match(policy.limitation, /never enter the conversation/)
  const standing = assessRequirementCriterion({ type: 'mechanism', capabilityId: 'guard.standing' }, draft)
  assert.equal(standing.matchesDraft, null); assert.match(standing.limitation, /does not automatically expire/)
  assert.equal(assessRequirementCriterion(parameter('referencePrice', '2500'), draft).matchesDraft, null)
  const unavailable = assessRequirementCriterion({ type: 'unsupported', topic: 'daily-cumulative-budget' }, draft)
  assert.equal(unavailable.matchesDraft, false); assert.match(unavailable.limitation, /cannot replace a daily budget with a per-swap cap/)
  assert.equal(assessRequirementCriteria(draft)[0]!.needsInterpretation, true)
  draft.requirements[0]!.criteria = [parameter('maxAmountBasePerSwap', '0.005', 'at-most')]
  draft.requirements[0]!.userAcceptedAlternative = true
  const row = assessRequirementCriteria(draft)[0]!
  assert.equal(row.criteria[0]!.matchesDraft, true)
  assert.equal(row.userConfirmed, false); assert.equal(row.registrationReady, false)
  assert.throws(() => requirementInputSchema.parse({ ...draft.requirements[0], privateRules: [] }))
})

test('optional criteria do not change legacy signed JSON or digests and cannot contain confirmations or private fields', () => {
  const draft = fixture(), before = canonical(draft), digest = contentDigest(draft)
  assert.equal(canonical(draftSchema.parse(JSON.parse(before))), before)
  assert.equal(contentDigest(draftSchema.parse(JSON.parse(before))), digest)
  assert.equal('criteria' in draft.requirements[0]!, false)
  const { userAcceptedAlternative: _accepted, ...input } = draft.requirements[0]!
  assert.deepEqual(requirementInputSchema.parse(input), input)
  assert.throws(() => requirementInputSchema.parse({ ...input, userConfirmed: true }))
  assert.throws(() => requirementInputSchema.parse({ ...input, criteria: [{ type: 'parameter', field: 'privatePriceThreshold', relation: 'equal', expected: '2500' }] }))
  assert.throws(() => requirementInputSchema.parse({ ...input, criteria: [{ type: 'mechanism', capabilityId: 'invented.guard' }] }))
})

test('criterion refinements and restoration retain provenance and create revisions; a changed meaning clears legacy acceptance', () => {
  const draft = fixture(), r = draft.requirements[0]!
  r.criteria = [parameter('maxAmountBasePerSwap', '0.005', 'at-most')]; r.userAcceptedAlternative = true
  const { userAcceptedAlternative: _accepted, ...input } = r
  const context = { owner: draft.owner, expectedRevision: 1, now: draft.updatedAt }
  const unchanged = patchDraft(draft, { upsertRequirements: [input] }, context)
  assert.equal(unchanged.changed, false)
  const edited = patchDraft(draft, { upsertRequirements: [{ ...input, criteria: [parameter('maxAmountBasePerSwap', '0.004', 'at-most')] }] }, context)
  assert.equal(edited.draft.revision, 2); assert.equal(edited.draft.requirements[0]!.userAcceptedAlternative, false)
  assert.equal(assessRequirementCriteria(edited.draft)[0]!.criteria[0]!.matchesDraft, false)
  const restored = restoreDraft(edited.draft, draft, { ...context, expectedRevision: 2 })
  assert.equal(restored.draft.revision, 3); assert.deepEqual(restored.draft.requirements[0]!.criteria, r.criteria)
  assert.equal(assessRequirementCriteria(restored.draft)[0]!.userConfirmed, false)
})
