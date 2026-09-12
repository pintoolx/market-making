import type { AquaStrategyParams } from './types.ts'

// The SDK builder is loaded through CJS by callers; keep only its used surface here.
interface CurveBuilder {
  xycSwapXD(): this
  peggedSwapGrowPriceRange2D(args: { x0: bigint; y0: bigint; linearWidth: bigint; rateLt: bigint; rateGt: bigint }): this
}
export function uint(value: string, name: string, max = (1n << 256n) - 1n): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 78) throw new Error(`invalid ${name}`)
  const n = BigInt(value)
  if (n > max) throw new Error(`invalid ${name}`)
  return n
}

/** Arguments follow address order; input references/rates always follow tokens[] order. */
export function peggedArgs(p: AquaStrategyParams) {
  if (p.program.kind !== 'pegged') throw new Error('expected pegged program')
  const { referenceBalances, rates } = p.program
  if (!Array.isArray(referenceBalances) || referenceBalances.length !== 2 || !Array.isArray(rates) || rates.length !== 2) throw new Error('pegged needs two references and rates')
  const refs = referenceBalances.map(n => uint(n, 'reference balance'))
  const multipliers = rates.map(n => uint(n, 'rate'))
  const normalized = refs.map((n, i) => n * multipliers[i]!)
  // Pinned implementation's documented arithmetic domain. Current inventory uses the same domain.
  if (normalized.some(n => n <= 0n || n > 10n ** 30n) || p.amounts.some((n, i) => BigInt(n) * multipliers[i]! > 10n ** 30n)) throw new Error('pegged normalized reserves must be positive and <= 1e30')
  const low = BigInt(p.tokens[0]!) < BigInt(p.tokens[1]!) ? 0 : 1, high = 1 - low
  return { x0: normalized[low]!, y0: normalized[high]!, rateLt: multipliers[low]!, rateGt: multipliers[high]!,
    linearWidth: uint(p.program.linearWidth, 'linearWidth', 5000n * 10n ** 27n) }
}

export function appendCurve<T extends CurveBuilder>(builder: T, p: AquaStrategyParams): T {
  if (p.program.kind === 'xyc') builder.xycSwapXD()
  else if (p.program.kind === 'pegged') builder.peggedSwapGrowPriceRange2D(peggedArgs(p))
  else throw new Error('unsupported program')
  return builder
}
