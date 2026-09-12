import { isAddress } from 'viem'
import type { Hex } from './types.ts'

export function sqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('negative square root')
  if (n < 2n) return n
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2))
  for (;;) { const y = (x + n / x) / 2n; if (y >= x) return x; x = y }
}
export function priceE18(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,35})(\.\d{1,18})?$/.test(value)) throw new Error('price requires a positive decimal with at most 18 fractional digits')
  const [whole, fraction = ''] = value.split('.')
  const n = BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
  if (!n) throw new Error('price must be positive')
  return n
}

/** Human token1/token0 prices -> address-sorted raw sqrt prices. Rounds bounds inward. */
export function concentrationBounds(tokens: Hex[], decimals: number[], min: string, max: string) {
  if (tokens.length !== 2 || tokens.some(t => !isAddress(t, { strict: false })) || tokens[0]!.toLowerCase() === tokens[1]!.toLowerCase() ||
    decimals.length !== 2 || decimals.some(n => !Number.isInteger(n) || n < 0 || n > 36)) throw new Error('invalid tokens or decimals')
  const lo = priceE18(min), hi = priceE18(max)
  if (lo >= hi) throw new Error('invalid price range')
  const reversed = BigInt(tokens[0]!) > BigInt(tokens[1]!)
  const ratio = (price: bigint): [bigint, bigint] => {
    const n = price * 10n ** BigInt(decimals[1]!), d = 10n ** BigInt(decimals[0]!) * 10n ** 18n
    return reversed ? [d, n] : [n, d]
  }
  const bound = (p: bigint, up: boolean) => {
    const [n, d] = ratio(p), scaled = n * 10n ** 36n, root = sqrt(scaled / d)
    return root + (up && root * root * d < scaled ? 1n : 0n)
  }
  const sqrtPriceMin = bound(reversed ? hi : lo, true), sqrtPriceMax = bound(reversed ? lo : hi, false)
  if (sqrtPriceMin <= 0n || sqrtPriceMin >= sqrtPriceMax || sqrtPriceMax >= 1n << 256n) throw new Error('range collapses at fixed-point precision')
  return { sqrtPriceMin: String(sqrtPriceMin), sqrtPriceMax: String(sqrtPriceMax) }
}
