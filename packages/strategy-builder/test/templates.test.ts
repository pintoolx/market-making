import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertTemplateInstance, canonical, defaultTemplatePermissions, digestJson, draftSchema, makeTemplateVersion,
  patchDraft, patchTemplateInstance, resolveTemplateSpec, sepoliaStandingProfile as profile, templateDigest,
  templateVersionSchema, type StrategyDraft, type StrategySpec } from '../src/index.ts'

const now = '2026-09-13T03:00:00.000Z', maker = '0x2222222222222222222222222222222222222222'
function fixture(model: StrategySpec['model'] = { kind: 'concentrated', minPrice: '2200', maxPrice: '2800' }) {
  const provider = draftSchema.parse({ schemaVersion: 1, id: 'provider-draft', owner: 'wallet:0x1111111111111111111111111111111111111111', kind: 'template',
    revision: 2, salt: '42', createdAt: now, updatedAt: now, requirements: [], spec: { title: 'Published pool', profileId: profile.id,
      baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model, feeBps: 0, deadline: 2000000000, modifiers: [],
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } } })
  const identity = { templateId: 'public-template', version: 1, permissions: defaultTemplatePermissions,
    policy: { keyId: digestJson('public-key'), envelopeDigest: digestJson('encrypted-policy') }, now }
  const template = makeTemplateVersion(provider, profile, identity)
  const baseline = resolveTemplateSpec(template, model?.kind === 'concentrated' && model.relativeWidthBps !== undefined ? {
    source: 'trusted-test-price', observedAt: now, baseToken: profile.tokens[0]!.address, quoteToken: profile.tokens[1]!.address, price: '2500',
  } : undefined)
  const draft = draftSchema.parse({ ...provider, id: 'instance', kind: 'maker', owner: 'wallet:' + maker, maker,
    templatePin: { templateId: template.templateId, version: template.version, digest: templateDigest(template) }, spec: baseline,
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' } })
  const patch = (d: StrategyDraft, p: Parameters<typeof patchTemplateInstance>[1]) => patchTemplateInstance(d, p, template, baseline, { owner: d.owner, expectedRevision: d.revision, now })
  return { provider, identity, template, baseline, draft, patch }
}

test('publication binds a complete Provider revision, permissions, profile and ciphertext commitment without Maker or secret fields', () => {
  const p = fixture()
  assert.equal(p.template.provider, p.provider.owner.slice(7)); assert.equal(p.template.manifestHash, digestJson(profile))
  assert.equal('maker' in p.template, false); assert.equal('allocations' in p.template, false)
  for (const extra of [{ ciphertext: 'private' }, { privatePolicy: {} }, { policy: { ...p.template.policy, plaintext: 'secret' } }]) {
    assert.throws(() => templateVersionSchema.parse({ ...p.template, ...extra }))
  }
  assert.throws(() => makeTemplateVersion(p.draft, profile, p.identity), /provider-template-required/)
  assert.throws(() => makeTemplateVersion({ ...p.provider, spec: { ...p.provider.spec, feeBps: 10 } }, profile, p.identity), /template-incomplete/)
  assert.throws(() => makeTemplateVersion(p.provider, profile, { ...p.identity, permissions: { ...defaultTemplatePermissions, peggedAmplification: { min: '1', max: '2' } } }), /curve-mismatch/)
  assert.notEqual(templateDigest(p.template), templateDigest({ ...p.template, permissions: { ...p.template.permissions, tightenCaps: false } }))
})

test('Maker changes are checked against the original publication and never loosen its public limits across turns', () => {
  const p = fixture(), initial = canonical(p.draft)
  assert.throws(() => patchDraft(p.draft, { spec: { title: 'edit' } }, { owner: p.draft.owner, expectedRevision: 2, now }), /permission validator/)
  let d = p.patch(p.draft, { spec: { model: { kind: 'concentrated', minPrice: '2300' }, guardEnvelope: { maxAmountQuotePerSwap: '10000000' } } }).draft
  d = p.patch(d, { spec: { title: 'Personal title', model: { kind: 'concentrated', maxPrice: '2700' } }, allocations: { quoteAtomic: '20000000' } }).draft
  assert.equal(d.spec.guardEnvelope?.maxAmountBasePerSwap, p.draft.spec.guardEnvelope?.maxAmountBasePerSwap)
  // Returning toward the original bounds is allowed; crossing them is not.
  d = p.patch(d, { spec: { model: { kind: 'concentrated', minPrice: '2200' }, guardEnvelope: { maxAmountQuotePerSwap: '12500000' } } }).draft
  for (const patch of [ { spec: { model: { kind: 'concentrated' as const, minPrice: '2199.999999999999999999' } } },
    { spec: { guardEnvelope: { maxAmountQuotePerSwap: '12500001' } } }, { spec: { deadline: 2000000001 } },
    { spec: { feeBps: 1 } }, { spec: { model: { kind: 'xyc' as const } } }, { maker: p.template.provider } ]) assert.throws(() => p.patch(d, patch))
  assert.equal(canonical(p.draft), initial)
  assert.throws(() => assertTemplateInstance({ ...d, templatePin: { ...d.templatePin!, digest: digestJson('tampered') } }, p.template, p.baseline), /pin-mismatch/)
  assert.throws(() => assertTemplateInstance(d, p.template, { ...p.baseline, deadline: 2000000001 }), /baseline-mismatch/)
})

test('relative CLMM resolves once using the paired observation and cannot replace the snapshot or follow a new price', () => {
  const p = fixture({ kind: 'concentrated', relativeWidthBps: 1000 })
  assert.equal(p.baseline.model?.kind === 'concentrated' && p.baseline.model.minPrice, '2250')
  assert.equal(p.baseline.model?.kind === 'concentrated' && p.baseline.model.maxPrice, '2750')
  assert.throws(() => resolveTemplateSpec(p.template), /snapshot-required/)
  const model = p.baseline.model; assert.ok(model?.kind === 'concentrated' && model.snapshot)
  const snapshot = model.snapshot
  assert.throws(() => resolveTemplateSpec(p.template, { ...snapshot, quoteToken: profile.tokens[0]!.address }), /pair-mismatch/)
  assert.throws(() => p.patch(p.draft, { spec: { model: { kind: 'concentrated', relativeWidthBps: 500 } } }), /range-permission/)
  assert.throws(() => p.patch(p.draft, { spec: { model: { kind: 'concentrated', snapshot: { ...snapshot, price: '2501' } } } }), /range-permission/)
  assertTemplateInstance(p.patch(p.draft, { spec: { model: { kind: 'concentrated', minPrice: '2300' } } }).draft, p.template, p.baseline)
})

test('locked permissions reject edits and explicit Pegged ranges use exact decimals with inclusive endpoints', () => {
  const p = fixture({ kind: 'pegged', referencePrice: '2500', amplification: '1' })
  const permissions = { ...defaultTemplatePermissions, tightenCaps: false, shortenDeadline: false,
    peggedReferencePrice: { min: '2000', max: '3000' }, peggedAmplification: { min: '0', max: '5000' } }
  const template = makeTemplateVersion(p.provider, profile, { ...p.identity, permissions }), baseline = resolveTemplateSpec(template)
  const draft = { ...p.draft, templatePin: { ...p.draft.templatePin!, digest: templateDigest(template) } }
  const change = (patch: Parameters<typeof patchTemplateInstance>[1]) => patchTemplateInstance(draft, patch, template, baseline, { owner: draft.owner, expectedRevision: 2, now })
  assert.doesNotThrow(() => change({ spec: { model: { kind: 'pegged', referencePrice: '3000', amplification: '0' } } }))
  assert.throws(() => change({ spec: { model: { kind: 'pegged', referencePrice: '3000.000000000000000001' } } }), /pegged-permission/)
  assert.throws(() => change({ spec: { deadline: 1999999999 } }), /deadline-permission/)
  assert.throws(() => change({ spec: { guardEnvelope: { maxAmountQuotePerSwap: '12000000' } } }), /cap-permission/)
  assert.throws(() => p.patch(p.draft, { spec: { model: { kind: 'pegged', amplification: '2' } } }), /pegged-permission/)
})
