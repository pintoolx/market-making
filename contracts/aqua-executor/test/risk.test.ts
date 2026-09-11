import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateRisk, type PriceSnapshot, type RiskPolicy } from '../src/risk.ts'

const weth = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const usdc = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const policy: RiskPolicy = {
  tokens: [weth, usdc], baselineAmounts: ['2000000000000000000', '5000000000'],
  maxDrawdownBps: 2500, maxPriceAgeSec: 60,
}
const prices: PriceSnapshot = { source: 'test fixture', asOf: 1_800_000_000, usdE8: { [weth]: '250000000000', [usdc]: '100000000' } }
const evaluate = (balances: bigint[], p = policy, snapshot = prices) => evaluateRisk(p, balances, [18, 6], snapshot, prices.asOf)

test('risk compares the original holdings and current inventory at the same prices, with mixed token decimals', () => {
  // Baseline = $10,000; inventory = $7,500. Exactly 25% below HODL.
  const result = evaluate([10n ** 18n, 5_000_000_000n])
  assert.equal(result.hodlValue, 10_000n * 10n ** 26n)
  assert.equal(result.strategyValue, 7_500n * 10n ** 26n)
  assert.equal(result.lossBps, 2500n)
  assert.equal(result.breached, true)
  assert.equal(evaluate([10n ** 18n, 5_000_000_000n], { ...policy, maxDrawdownBps: 2501 }).breached, false)
  // A changed token allocation can still have the same total value.
  assert.equal(evaluate([10n ** 18n, 7_500_000_000n]).lossBps, 0n)
  assert.equal(evaluate([2n * 10n ** 18n, 6_000_000_000n]).breached, false)
})

test('risk threshold comparison preserves wei precision at an exact boundary', () => {
  // One wei above the boundary is still below the 25% loss threshold.
  const above = evaluate([10n ** 18n + 1n, 5_000_000_000n])
  const below = evaluate([10n ** 18n - 1n, 5_000_000_000n])
  assert.equal(above.breached, false)
  assert.equal(below.breached, true)
  assert.equal(above.lossBps, 2499n)
  assert.equal(below.lossBps, 2500n)
})

test('a price move alone is not a loss relative to HODL when inventory is unchanged', () => {
  const result = evaluate(policy.baselineAmounts.map(BigInt), policy, { ...prices, usdE8: { [weth]: '1000000000000', [usdc]: '100000000' } })
  assert.equal(result.lossBps, 0n)
  assert.equal(result.breached, false)
})

test('risk refuses stale, future, missing, zero, and ambiguous prices', () => {
  const balances = policy.baselineAmounts.map(BigInt)
  assert.throws(() => evaluate(balances, policy, { ...prices, asOf: prices.asOf - 61 }), /stale prices/)
  assert.throws(() => evaluate(balances, policy, { ...prices, asOf: prices.asOf + 1 }), /future price timestamp/)
  assert.throws(() => evaluate(balances, policy, { ...prices, usdE8: { [weth]: '1' } }), /missing price/)
  assert.throws(() => evaluate(balances, policy, { ...prices, usdE8: { ...prices.usdE8, [weth]: '0' } }), /positive integer/)
  assert.throws(() => evaluate(balances, policy, { ...prices, usdE8: { ...prices.usdE8, [usdc]: '1.5' } }), /positive integer/)
  assert.throws(() => evaluate(balances, policy, { ...prices, source: '' }), /source is required/)
  assert.throws(() => evaluate(balances, policy, { ...prices, usdE8: { ...prices.usdE8, ['0x' + weth.slice(2).toUpperCase()]: '1' } }), /duplicate price token/)
  assert.throws(() => evaluate(balances, { ...policy, baselineAmounts: ['0', '1'] }), /positive integer/)
  for (const bps of [0, -1, 1.5, 10001, NaN]) {
    assert.throws(() => evaluate(balances, { ...policy, maxDrawdownBps: bps }), /maxDrawdownBps/)
  }
})
