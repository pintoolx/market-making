import { allocationSchema, canonical, decodeGuardedOrder, digestJson, guardEnvelopeSchema, scaledDecimal, validateStrategy, type DeploymentProfile } from '@pintool/strategy-builder'
import { concentrationBounds } from './concentrated.ts'
import { compileGuardedV2 } from './guard-compile.ts'
import { peggedArgs } from './curves.ts'
import type { AquaStrategyParams } from './types.ts'

const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a }

/** Node-only adapter. Does not import signers, execute transactions or accept arbitrary bytecode. */
export function compileBuilderStrategy(input: unknown, profile: DeploymentProfile, nowSec: number) {
  const result = validateStrategy(input, profile, nowSec)
  if (!result.validated) throw new Error(`strategy is not valid: ${[...result.missingFields, ...result.errors.map(e => e.path + ': ' + e.message)].join('; ')}`)
  const { draft, manifestHash, contentDigest, recipeId } = result.validated
  if (draft.kind !== 'maker' || !draft.maker || !draft.allocations) throw new Error('a Provider template must be instantiated by a Maker before compiling')
  const { spec } = draft, base = spec.baseToken!, quote = spec.quoteToken!, model = spec.model!
  const caps = guardEnvelopeSchema.parse(spec.guardEnvelope), allocations = allocationSchema.parse(draft.allocations)
  const common = { feeBps: spec.feeBps!, deadline: spec.deadline!, salt: draft.salt }
  const amounts = [allocations.baseAtomic, allocations.quoteAtomic]
  let program: AquaStrategyParams['program']
  if (model.kind === 'xyc') program = { ...common, kind: 'xyc' }
  else if (model.kind === 'concentrated') program = { ...common, kind: 'concentrated',
    ...concentrationBounds([base.address, quote.address], [base.decimals, quote.decimals], model.minPrice!, model.maxPrice!) }
  else {
    const numerator = scaledDecimal(model.referencePrice!) * 10n ** BigInt(quote.decimals)
    const denominator = 10n ** 18n * 10n ** BigInt(base.decimals), divisor = gcd(numerator, denominator)
    program = { ...common, kind: 'pegged', linearWidth: String(scaledDecimal(model.amplification!, 27)),
      rates: [String(numerator / divisor), String(denominator / divisor)], referenceBalances: [amounts[0]!, amounts[1]!] }
  }
  const params: AquaStrategyParams = { schema: 'aqua-swapvm-v1.0.2', chainId: profile.chainId, maker: draft.maker,
    tokens: [base.address, quote.address], amounts, program,
    meta: { producer: 'fixed-params', strategyVersion: 1, paramsRevision: draft.revision } }
  const compiled = compileGuardedV2(params, profile.guard, { maxAmount0PerSwap: BigInt(caps.maxAmountBasePerSwap),
    maxAmount1PerSwap: BigInt(caps.maxAmountQuotePerSwap), maxPostBalance0: BigInt(caps.maxPostBalanceBase), maxPostBalance1: BigInt(caps.maxPostBalanceQuote) })
  const decoded = decodeGuardedOrder(compiled.strategy)
  const expectedCurve = program.kind === 'xyc' ? [] : program.kind === 'concentrated' ? [program.sqrtPriceMin, program.sqrtPriceMax]
    : (({ x0, y0, linearWidth, rateLt, rateGt }) => [x0, y0, linearWidth, rateLt, rateGt].map(String))(peggedArgs(params))
  if (decoded.guard !== profile.guard.toLowerCase() || decoded.maker !== draft.maker || decoded.kind !== model.kind || decoded.feeBps !== spec.feeBps ||
    decoded.baseToken !== base.address || decoded.quoteToken !== quote.address || decoded.deadline !== spec.deadline || decoded.salt !== draft.salt ||
    canonical(decoded.guardEnvelope) !== canonical(caps) || canonical(decoded.curveArgs) !== canonical(expectedCurve)) throw new Error('compiled program does not match reviewed strategy')
  const guardedParams: AquaStrategyParams = { ...params, guard: { address: profile.guard, version: 2, caps: {
    maxAmount0PerSwap: caps.maxAmountBasePerSwap, maxAmount1PerSwap: caps.maxAmountQuotePerSwap,
    maxPostBalance0: caps.maxPostBalanceBase, maxPostBalance1: caps.maxPostBalanceQuote,
  } } }
  return { schemaVersion: 1 as const, draftId: draft.id, revision: draft.revision, contentDigest, manifestHash, recipeId, recipeVersion: 1,
    specHash: digestJson({ spec, maker: draft.maker, allocations: draft.allocations, salt: draft.salt }),
    strategy: compiled.strategy, program: decoded.program, programHash: decoded.programHash, orderHash: decoded.orderHash, strategyHash: decoded.strategyHash,
    decoded, params: guardedParams, order: { ...compiled.order, traits: String(compiled.order.traits) }, tokens: compiled.tokens, amounts: compiled.amounts.map(String),
  }
}
