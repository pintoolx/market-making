import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { draftSchema, patchDraft, sepoliaStandingProfile } from '@pintool/strategy-builder'
import { createDesignTools, designEditSchema, editToPatch, resolveProfileToken, visibleDraft } from '../src/design-tools.ts'

const profile = sepoliaStandingProfile
const draft = () => draftSchema.parse({ schemaVersion: 1, id: 'draft', owner: 'wallet:0x1111111111111111111111111111111111111111', revision: 1, kind: 'maker',
  maker: '0x1111111111111111111111111111111111111111', spec: { title: 'bounded design', profileId: profile.id,
    baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'concentrated', minPrice: '2000', maxPrice: '3000' }, feeBps: 0 },
  requirements: [{ id: 'keep-zero-fee', text: '維持零費率', priority: 'must', sourceMessageId: 'first', capabilityIds: ['curve.concentrated'] }],
  salt: '1', createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' })
const input = (edits: { field: string; value: string }[]) => designEditSchema.parse({ expectedRevision: 1, operation: 'patch', restoreRevision: null, edits, requirements: [] })

test('history tool results contain JSON values even when a repository returns PostgreSQL Date objects', async () => {
  const d = draft(), tools = createDesignTools({ profile, turnId: 'turn', sourceMessageId: 'message', nowSec: 1, repository: {
    read: async () => d, history: async () => [{ revision: '1', createdAt: new Date(d.createdAt), diff: [] }],
    patch: async () => { throw new Error('unused') }, restore: async () => { throw new Error('unused') },
  } })
  const result = await tools.inspectStrategy.execute!({ view: 'history' }, { toolCallId: 'history', messages: [], context: {} })
  assert.doesNotThrow(() => z.json().parse(result))
  assert.match(JSON.stringify(result), /2026-09-13T00:00:00.000Z/)
})

test('live-model chain-qualified token queries resolve before Guard amount edits without cross-chain substitutions', () => {
  for (const query of ['WETH', ' Ethereum Sepolia WETH ', 'WETH on Ethereum Sepolia', 'sepolia weth', profile.tokens[0]!.address.toUpperCase()]) {
    assert.deepEqual(resolveProfileToken(query, profile), profile.tokens[0])
  }
  for (const query of ['Base Sepolia WETH', 'WETH on Ethereum mainnet', 'ETH', 'unknown WETH', 'USDC.e']) {
    assert.equal(resolveProfileToken(query, profile), null)
  }
  assert.equal(resolveProfileToken('Sepolia WETH', { ...profile, chainId: 1 }), null)
  const d = draft(); delete d.spec.baseToken; delete d.spec.quoteToken
  const patch = editToPatch(input([
    { field: 'maxAmountBasePerSwap', value: '0.05' }, { field: 'maxAmountQuotePerSwap', value: '125' },
    { field: 'maxPostBalanceBase', value: '2' }, { field: 'maxPostBalanceQuote', value: '5000' },
    { field: 'baseToken', value: 'Ethereum Sepolia WETH' }, { field: 'quoteToken', value: 'USDC on Ethereum Sepolia' },
  ]), d, profile, 'live-regression')
  assert.deepEqual(patch.spec?.guardEnvelope, { maxAmountBasePerSwap: '50000000000000000', maxAmountQuotePerSwap: '125000000',
    maxPostBalanceBase: '2000000000000000000', maxPostBalanceQuote: '5000000000' })
  assert.equal(patch.spec?.baseToken?.address, profile.tokens[0]!.address)
})

test('agent edits preserve untouched limits and convert human amounts exactly to token atomic units', () => {
  const d = draft(), patch = editToPatch(input([{ field: 'maxPrice', value: '2800' }, { field: 'allocationBase', value: '0.05' }, { field: 'allocationQuote', value: '125' }]), d, profile, 'second')
  const next = patchDraft(d, patch, { owner: d.owner, expectedRevision: 1, now: d.updatedAt }).draft
  assert.deepEqual(next.spec.model, { kind: 'concentrated', minPrice: '2000', maxPrice: '2800' })
  assert.deepEqual(next.allocations, { baseAtomic: '50000000000000000', quoteAtomic: '125000000' })
  assert.equal(next.spec.feeBps, 0); assert.deepEqual(next.requirements, d.requirements)
  assert.throws(() => editToPatch(input([{ field: 'allocationBase', value: '1' }, { field: 'allocationQuote', value: '0.0000001' }]), d, profile, 'third'), /too many decimal places/)
})

test('agent cannot inject private fields, silently retarget funded pairs or assign fake requirement/capability identities', () => {
  const d = draft()
  assert.throws(() => designEditSchema.parse({ ...input([]), owner: 'attacker' }))
  assert.throws(() => input([{ field: 'privatePolicy', value: 'secret' }]))
  assert.throws(() => input([{ field: 'calldata', value: '0xabcd' }]))
  assert.throws(() => editToPatch(input([{ field: 'title', value: 'A' }, { field: 'title', value: 'B' }]), d, profile, 'second'), /duplicate-edit/)
  d.allocations = { baseAtomic: '1', quoteAtomic: '1' }
  assert.throws(() => editToPatch(input([{ field: 'baseToken', value: 'USDC' }]), d, profile, 'second'), /new-draft/)
  const r = { id: null, text: 'new requirement', priority: 'must' as const, capabilityIds: ['nonexistent'] }
  assert.throws(() => editToPatch({ ...input([]), requirements: [r] }, d, profile, 'second'), /unknown-capability/)
  assert.throws(() => editToPatch({ ...input([]), requirements: [{ ...r, id: 'forged', capabilityIds: [] }] }, d, profile, 'second'), /unknown-requirement/)
  const visible = visibleDraft(d)
  assert.equal('owner' in visible, false); assert.equal('salt' in visible, false)
  assert.throws(() => visibleDraft({ ...d, privatePolicy: 'must-not-forward' } as never))
  assert.throws(() => editToPatch(input([{ field: 'allocationBase', value: '1' }, { field: 'allocationQuote', value: '2' }]),
    { ...d, kind: 'template' }, profile, 'second'), /maker-allocation-not-template/)
})

test('design tools accept a single new limit or allocation and normalize curve selection before its parameters', () => {
  const d = draft()
  const cap = editToPatch(input([{ field: 'maxAmountBasePerSwap', value: '0.05' }]), d, profile, 'single-cap')
  assert.deepEqual(cap.spec?.guardEnvelope, { maxAmountBasePerSwap: '50000000000000000' })
  const first = patchDraft(d, cap, { owner: d.owner, expectedRevision: 1, now: d.updatedAt }).draft
  const quote = editToPatch(input([{ field: 'maxAmountQuotePerSwap', value: '125' }]), first, profile, 'second-cap')
  assert.deepEqual(quote.spec?.guardEnvelope, { maxAmountBasePerSwap: '50000000000000000', maxAmountQuotePerSwap: '125000000' })
  assert.deepEqual(editToPatch(input([{ field: 'allocationBase', value: '1' }]), d, profile, 'base-only').allocations, { baseAtomic: '1000000000000000000' })
  const curve = editToPatch(input([{ field: 'referencePrice', value: '2500' }, { field: 'amplification', value: '1' }, { field: 'curve', value: 'pegged' }]), d, profile, 'switch')
  assert.deepEqual(curve.spec?.model, { kind: 'pegged', referencePrice: '2500', amplification: '1' })
  assert.throws(() => editToPatch(input([{ field: 'relativeWidthBps', value: '500' }, { field: 'maxPrice', value: '2700' }]), d, profile, 'ambiguous'), /choose-fixed-or-relative/)
})
