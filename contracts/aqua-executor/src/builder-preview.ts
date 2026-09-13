import { allocationSchema, canonical, contentDigest, decodeGuardedOrder, digestJson, draftSchema, idSchema, positiveAtomicSchema,
  type DeploymentProfile, type StrategyDraft } from '@pintool/strategy-builder'
import { z } from 'zod'
import { compileBuilderStrategy } from './builder-compile.ts'
import { sqrt } from './concentrated.ts'

export const previewEngine = 'builder-math-v1'
export const scenarioInputSchema = z.object({
  hypotheticalAllocations: allocationSchema.nullable(),
  scenarios: z.array(z.object({ name: idSchema,
    trades: z.array(z.object({ tokenIn: z.enum(['base', 'quote']), amountInAtomic: positiveAtomicSchema }).strict()).min(1).max(12),
  }).strict()).min(1).max(8),
}).strict()
export type ScenarioInput = z.infer<typeof scenarioInputSchema>
type Decoded = ReturnType<typeof decodeGuardedOrder>
const U256 = (1n << 256n) - 1n, E18 = 10n ** 18n, E27 = 10n ** 27n
const uint = (n: bigint) => { if (n < 0n || n > U256) throw new Error('curve-arithmetic-domain'); return n }
const add = (a: bigint, b: bigint) => uint(a + b), mul = (a: bigint, b: bigint) => uint(a * b)
const div = (a: bigint, b: bigint) => { if (b === 0n) throw new Error('curve-division-by-zero'); return uint(a / b) }
const ceil = (a: bigint, b: bigint) => add(div(a, b), a % b === 0n ? 0n : 1n)
// Solidity Math.mulDiv has a 512-bit intermediate; ordinary multiplication does not.
const md = (a: bigint, b: bigint, denominator: bigint) => div(a * b, denominator)
const sqrtUp = (n: bigint) => { const r = sqrt(n); return r * r === n ? r : r + 1n }

/** Independent bigint transcription of swap-vm@32c687c: XYCConcentrate,
 * XYCSwap, PeggedSwap and PeggedSwapMath. Preserve operation order/rounding and
 * checked uint256 intermediates. No RPC, report authorization or ERC20 transfer. */
export function previewSwapMath(decoded: Decoded, balances: readonly [bigint, bigint], tokenIn: 0 | 1, amount: bigint) {
  uint(balances[0]); uint(balances[1]); uint(amount)
  if (amount === 0n) throw new Error('zero-input')
  const feeScale = BigInt(decoded.feeBps) * 100_000n, pricingAmount = feeScale === 0n ? amount : (() => {
    const fee = ceil(mul(amount, feeScale), 1_000_000_000n)
    if (fee >= amount) throw new Error('fee-exceeds-input')
    return amount - fee
  })()
  let x = balances[tokenIn], y = balances[1 - tokenIn]!
  const inLt = BigInt(tokenIn === 0 ? decoded.baseToken : decoded.quoteToken) < BigInt(tokenIn === 0 ? decoded.quoteToken : decoded.baseToken)
  if (decoded.kind === 'concentrated') {
    const [lo, hi] = decoded.curveArgs.map(BigInt) as [bigint, bigint]
    const [bLt, bGt] = inLt ? [x, y] : [y, x]
    const alpha = uint(E18 - md(lo, E18, hi))
    const beta = add(md(bLt, lo, E18), md(bGt, E18, hi))
    const fourAC = mul(md(mul(4n, alpha), bLt, E18), bGt)
    const liquidity = md(add(beta, sqrt(add(mul(beta, beta), fourAC))), E18, mul(2n, alpha))
    x = add(x, inLt ? ceil(mul(liquidity, E18), hi) : ceil(mul(liquidity, lo), E18))
    y = add(y, inLt ? md(liquidity, lo, E18) : md(liquidity, E18, hi))
  }
  let amountOut: bigint
  if (decoded.kind !== 'pegged') {
    if (x === 0n || y === 0n) throw new Error('curve-empty-reserve')
    amountOut = div(mul(pricingAmount, y), add(x, pricingAmount))
  } else {
    const [xLt, yGt, a, rateLt, rateGt] = decoded.curveArgs.map(BigInt) as [bigint, bigint, bigint, bigint, bigint]
    const [xRef, yRef, rateIn, rateOut] = inLt ? [xLt, yGt, rateLt, rateGt] : [yGt, xLt, rateGt, rateLt]
    if (x === 0n && y === 0n) throw new Error('curve-empty-reserve')
    x = mul(x, rateIn); y = mul(y, rateOut)
    const u = div(mul(x, E27), xRef), v = div(mul(y, E27), yRef)
    const invariant = add(add(sqrt(mul(u, E27)), sqrt(mul(v, E27))), div(mul(a, add(u, v)), E27))
    const nextU = div(mul(add(x, mul(pricingAmount, rateIn)), E27), xRef)
    const used = add(sqrt(mul(nextU, E27)), div(mul(a, nextU), E27))
    if (used > invariant) throw new Error('curve-price-boundary')
    const right = invariant - used
    let nextV: bigint
    if (a === 0n) nextV = div(mul(right, right), E27)
    else {
      const discriminant = add(E27, div(mul(mul(4n, a), right), E27))
      const root = sqrtUp(mul(discriminant, E27))
      const w = div(mul(mul(2n, right), E27), add(E27, root))
      nextV = div(mul(w, w), E27)
    }
    const nextY = ceil(mul(nextV, yRef), E27)
    amountOut = div(uint(y - nextY), rateOut)
  }
  return { amountIn: amount, pricingAmountIn: pricingAmount, feeAmountIn: amount - pricingAmount, amountOut, pricingBalanceIn: x, pricingBalanceOut: y }
}

/** A fixed public envelope and hypothetical active, bidirectional report are
 * assumptions. Real authorization, wallet balance/allowance and settlement are separate. */
export function previewBuilderScenarios(input: StrategyDraft, profile: DeploymentProfile, options: ScenarioInput, nowSec: number) {
  const draft = draftSchema.parse(input), value = scenarioInputSchema.parse(options)
  if (draft.kind === 'maker' && value.hypotheticalAllocations) throw new Error('maker-allocation-override-forbidden')
  if (draft.kind === 'template' && !value.hypotheticalAllocations) throw new Error('hypothetical-allocation-required')
  if (new Set(value.scenarios.map(s => s.name)).size !== value.scenarios.length) throw new Error('duplicate-scenario-name')
  // Templates have no Maker funds. This local-only projection is never persisted
  // as a compilation or exposed as executable bytes/hash/registration readiness.
  const projection: StrategyDraft = draft.kind === 'maker' ? draft : { ...draft, kind: 'maker', maker: '0x0000000000000000000000000000000000000001', allocations: value.hypotheticalAllocations! }
  const compiled = compileBuilderStrategy(projection, profile, nowSec), decoded = decodeGuardedOrder(compiled.strategy)
  if (canonical(decoded) !== canonical(compiled.decoded)) throw new Error('preview-decoder-mismatch')
  const allocations = allocationSchema.parse(projection.allocations)
  const initial = [BigInt(allocations.baseAtomic), BigInt(allocations.quoteAtomic)] as [bigint, bigint]
  const caps = decoded.guardEnvelope
  const amountCaps = [BigInt(caps.maxAmountBasePerSwap), BigInt(caps.maxAmountQuotePerSwap)]
  const postCaps = [BigInt(caps.maxPostBalanceBase), BigInt(caps.maxPostBalanceQuote)]
  const scenarios = value.scenarios.map(scenario => {
    let balances: [bigint, bigint] = [...initial]
    const trades = scenario.trades.map(trade => {
      const index = trade.tokenIn === 'base' ? 0 : 1, out = 1 - index, amount = BigInt(trade.amountInAtomic)
      const before = balances.map(String)
      try {
        const math = previewSwapMath(decoded, balances, index, amount), reasons: string[] = []
        if (math.amountOut === 0n) reasons.push('zero-output')
        if (amount > amountCaps[index]! || math.amountOut > amountCaps[out]!) reasons.push('guard-amount-cap')
        if (math.amountOut > balances[out]!) reasons.push('aqua-output-inventory')
        const next: [bigint, bigint] = [...balances]
        next[index] = add(balances[index], amount)
        next[out] = balances[out]! - math.amountOut
        if (next.some((n, i) => n > postCaps[i]!)) reasons.push('guard-post-inventory-cap')
        if (!reasons.length) balances = next
        const baseAmount = index === 0 ? amount : math.amountOut, quoteAmount = index === 0 ? math.amountOut : amount
        return { ...trade, amountOutAtomic: String(math.amountOut), pricingAmountInAtomic: String(math.pricingAmountIn), feeAmountInAtomic: String(math.feeAmountIn), admittedUnderAssumptions: reasons.length === 0, reasons, before, after: balances.map(String),
          executionPriceQuotePerBase: baseAmount === 0n ? null : { numerator: String(quoteAmount * 10n ** BigInt(draft.spec.baseToken!.decimals)),
            denominator: String(baseAmount * 10n ** BigInt(draft.spec.quoteToken!.decimals)) } }
      } catch (error) {
        return { ...trade, amountOutAtomic: null, pricingAmountInAtomic: null, feeAmountInAtomic: null, admittedUnderAssumptions: false,
          reasons: [error instanceof Error && error.message.startsWith('curve-') ? error.message : 'preview-unavailable'], before, after: before, executionPriceQuotePerBase: null }
      }
    })
    return { name: scenario.name, trades, finalBalances: balances.map(String) }
  })
  return { schemaVersion: 1 as const, engineVersion: previewEngine, mode: 'mathematical-preview' as const,
    draftId: draft.id, revision: draft.revision, contentDigest: contentDigest(draft), manifestHash: digestJson(profile), inputDigest: digestJson(value),
    evaluatedAt: nowSec, kind: draft.kind, model: decoded.kind, pair: [draft.spec.baseToken!, draft.spec.quoteToken!], allocations,
    allocationSource: draft.kind === 'maker' ? 'draft' as const : 'hypothetical' as const,
    assumptions: ['Each scenario starts from the stated allocation; trades within it are sequential.',
      'Guard report is assumed active, unrevoked, bidirectional and equal to the public envelope.',
      'Rejected trades leave balances unchanged. Wallet funds, allowance, gas and live report are not checked.',
      'A fixed LP input fee is deducted from the taker input for curve pricing, then the gross input is credited to Aqua; rounding is upward and the fee remains with the Maker.',
      'Prices are quote per base, derived from integer trade amounts; no market forecast or return guarantee.'],
    observations: decoded.kind === 'pegged' ? ['Pegged initial marginal price depends on the allocation ratio. With references derived from these allocations, the referencePrice normalization alone does not set the initial execution price.'] : [],
    scenarios, registrationReady: false as const }
}
