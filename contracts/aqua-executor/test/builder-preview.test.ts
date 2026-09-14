import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { draftSchema, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { previewBuilderScenarios, previewSwapMath } from '../src/builder-preview.ts'
import { compileBuilderStrategy } from '../src/builder-compile.ts'
import { builderSimulationFixture } from '../scripts/builder-simulation-fixture.ts'

const maker = '0x1111111111111111111111111111111111111111', now = 1789250000
test('integer previews match the previously recorded bidirectional, sequential onchain fork settlements for all three curves', async () => {
  for (const kind of ['xyc', 'concentrated', 'pegged'] as const) {
    const evidence = JSON.parse(await readFile(new URL(`../../../docs/builder-simulation/${kind}.json`, import.meta.url), 'utf8'))
    const draft = draftSchema.parse(evidence.draft)
    const trades = evidence.result.swaps.filter((s: { case: string }) => s.case === 'bidirectional-and-sequential-settlement')
    assert.equal(trades.length, 3)
    const preview = previewBuilderScenarios(draft, profile, { hypotheticalAllocations: null, scenarios: [{ name: 'recorded-sequence',
      trades: trades.map((s: { tokenIn: string; amountIn: string }) => ({ tokenIn: s.tokenIn === draft.spec.baseToken!.address ? 'base' : 'quote', amountInAtomic: s.amountIn })) }] }, Number(evidence.result.sourceTimestamp))
    assert.equal(preview.registrationReady, false)
    for (const [index, step] of preview.scenarios[0]!.trades.entries()) {
      assert.equal(step.admittedUnderAssumptions, true)
      assert.equal(step.amountOutAtomic, trades[index].amountOut, `${kind} step ${index}`)
    }
  }
})

test('nonzero LP fee requests cannot produce an executable preview under the current Guard', () => {
  const draft = builderSimulationFixture('xyc', maker, now)
  draft.spec.feeBps = 30
  assert.throws(() => previewBuilderScenarios(draft, profile, { hypotheticalAllocations: null,
    scenarios: [{ name: 'fee', trades: [{ tokenIn: 'base', amountInAtomic: '100000000000001' }] }] }, now), /zero LP fee|invalid|incomplete/)
})

test('preview sequences enforce both amount caps, actual post-inventory and zero output, preserving state on refusal', () => {
  const draft = builderSimulationFixture('xyc', maker, now)
  draft.spec.guardEnvelope!.maxAmountQuotePerSwap = '1'
  const input = { hypotheticalAllocations: null, scenarios: [{ name: 'cap-intersection', trades: [
    { tokenIn: 'base' as const, amountInAtomic: '100000000000000' }, { tokenIn: 'base' as const, amountInAtomic: '1' },
  ] }] }
  const result = previewBuilderScenarios(draft, profile, input, now)
  assert.ok(result.scenarios[0]!.trades[0]!.reasons.includes('guard-amount-cap'), 'output-token cap applies to a base-token input')
  assert.ok(result.scenarios[0]!.trades[1]!.reasons.includes('zero-output'))
  assert.deepEqual(result.scenarios[0]!.finalBalances, ['10000000000000000', '25000000'])
  draft.spec.guardEnvelope!.maxAmountQuotePerSwap = '12500000'; draft.spec.guardEnvelope!.maxPostBalanceBase = draft.allocations!.baseAtomic
  assert.ok(previewBuilderScenarios(draft, profile, input, now).scenarios[0]!.trades[0]!.reasons.includes('guard-post-inventory-cap'))
})

test('concentrated output uses pricing reserves but cannot spend more than real Aqua inventory', () => {
  const draft = builderSimulationFixture('concentrated', maker, now)
  draft.spec.guardEnvelope = { maxAmountBasePerSwap: '1000000000000000000', maxAmountQuotePerSwap: '2500000000',
    maxPostBalanceBase: '2000000000000000000', maxPostBalanceQuote: '5000000000' }
  const result = previewBuilderScenarios(draft, profile, { hypotheticalAllocations: null,
    scenarios: [{ name: 'drain', trades: [{ tokenIn: 'base', amountInAtomic: '1000000000000000000' }] }] }, now)
  assert.ok(result.scenarios[0]!.trades[0]!.reasons.includes('aqua-output-inventory'))
  assert.deepEqual(result.scenarios[0]!.trades[0]!.before, result.scenarios[0]!.trades[0]!.after)
})

test('templates require explicit hypothetical allocations; Maker inputs cannot replace saved allocations or escape uint256 arithmetic', () => {
  const fixture = builderSimulationFixture('xyc', maker, now), draft = { ...fixture, kind: 'template' as const, maker: undefined, allocations: undefined }
  const input = { hypotheticalAllocations: fixture.allocations as { baseAtomic: string; quoteAtomic: string },
    scenarios: [{ name: 'example', trades: [{ tokenIn: 'base' as const, amountInAtomic: '100000000000000' }] }] }
  const result = previewBuilderScenarios(draft, profile, input, now)
  assert.equal(result.allocationSource, 'hypothetical'); assert.equal(result.kind, 'template'); assert.equal('strategyHash' in result, false)
  assert.throws(() => previewBuilderScenarios(draft, profile, { ...input, hypotheticalAllocations: null }, now), /hypothetical-allocation-required/)
  assert.throws(() => previewBuilderScenarios(fixture, profile, input, now), /maker-allocation-override-forbidden/)
  const decoded = compileBuilderStrategy(fixture, profile, now).decoded
  assert.throws(() => previewSwapMath(decoded, [1n, 2n], 0, (1n << 256n) - 1n), /arithmetic-domain/)
  assert.throws(() => previewBuilderScenarios(fixture, profile, { ...input, hypotheticalAllocations: null, scenarios: [input.scenarios[0]!, input.scenarios[0]!] }, now), /duplicate-scenario/)
})

test('Pegged normalization is not an independent target price when reference balances come from allocations', () => {
  const draft = builderSimulationFixture('pegged', maker, now)
  draft.allocations!.quoteAtomic = '30000000'
  const input = { hypotheticalAllocations: null, scenarios: [{ name: 'small-trade', trades: [{ tokenIn: 'base' as const, amountInAtomic: '100000000000000' }] }] }
  const first = previewBuilderScenarios(draft, profile, input, now)
  draft.spec.model = { kind: 'pegged', referencePrice: '2000', amplification: '1' }
  const second = previewBuilderScenarios(draft, profile, input, now)
  assert.equal(first.scenarios[0]!.trades[0]!.amountOutAtomic, second.scenarios[0]!.trades[0]!.amountOutAtomic)
  assert.ok(first.observations[0]!.includes('allocation ratio'))
  for (const a of ['0', '0.000000000000000001', '5000']) {
    draft.spec.model.amplification = a
    const value = previewBuilderScenarios(draft, profile, input, now)
    assert.equal(value.scenarios[0]!.trades[0]!.admittedUnderAssumptions, true)
  }
})
