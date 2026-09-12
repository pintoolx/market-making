import { isAddress } from 'viem'
import type { Hex } from './types.ts'

/** Persist this benchmark across rebalances; amounts are raw units in exactly this token order. */
export interface RiskPolicy {
  tokens: Hex[]
  baselineAmounts: string[]
  /** Shortfall relative to HODL at the same current prices, not drawdown from a historical peak. */
  maxDrawdownBps: number
  maxPriceAgeSec: number
}

/** USD per whole token, scaled by 1e8. Supply prices independently of this strategy's AMM quote. */
export interface PriceSnapshot {
  asOf: number
  source: string
  usdE8: Record<Hex, string>
  mode?: 'live' | 'simulated' | 'file'
  /** Source-specific audit information; asOf remains the oldest actual observation time. */
  evidence?: Record<string, unknown>
}

/** Read failures may be retried. Errors after a transaction submission must not be blindly retried. */
export class MonitorDataError extends Error {}

const positiveInteger = (value: string, label: string) => {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${label} must be a positive integer string`)
  return BigInt(value)
}

export function validatePolicy(policy: RiskPolicy) {
  if (policy.tokens.length !== 2 || policy.baselineAmounts.length !== 2) throw new Error('risk policy needs two tokens and two baseline amounts')
  if (policy.tokens.some(t => !isAddress(t, { strict: false })) || new Set(policy.tokens.map(t => t.toLowerCase())).size !== 2) {
    throw new Error('risk policy needs two distinct token addresses')
  }
  policy.baselineAmounts.forEach(a => positiveInteger(a, 'baseline amount'))
  if (!Number.isInteger(policy.maxDrawdownBps) || policy.maxDrawdownBps < 1 || policy.maxDrawdownBps > 10_000) {
    throw new Error('maxDrawdownBps must be an integer from 1 to 10000')
  }
  if (!Number.isSafeInteger(policy.maxPriceAgeSec) || policy.maxPriceAgeSec < 1) throw new Error('maxPriceAgeSec must be a positive integer')
}

/** Exact integer valuation: compare the unrounded ratio at the threshold; lossBps is display-only. */
export function evaluateRisk(policy: RiskPolicy, balances: bigint[], decimals: number[], prices: PriceSnapshot, now: number) {
  validatePolicy(policy)
  if (balances.length !== 2 || balances.some(b => typeof b !== 'bigint' || b < 0n)) throw new Error('risk needs two nonnegative balances')
  if (decimals.length !== 2 || decimals.some(d => !Number.isInteger(d) || d < 0 || d > 255)) throw new Error('invalid token decimals')
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(prices.asOf) || prices.asOf < 0 || prices.asOf > now) throw new Error('invalid or future price timestamp')
  if (now - prices.asOf > policy.maxPriceAgeSec) throw new Error('stale prices')
  if (typeof prices.source !== 'string' || !prices.source.trim()) throw new Error('price source is required')
  const byToken = new Map<string, bigint>()
  for (const [token, price] of Object.entries(prices.usdE8)) {
    if (!isAddress(token, { strict: false }) || byToken.has(token.toLowerCase())) throw new Error('invalid or duplicate price token')
    byToken.set(token.toLowerCase(), positiveInteger(price, 'USD price'))
  }
  const scale = Math.max(...decimals)
  const weights = policy.tokens.map((token, i) => {
    const price = byToken.get(token.toLowerCase())
    if (price === undefined) throw new Error(`missing price for ${token}`)
    return price * 10n ** BigInt(scale - decimals[i]!)
  })
  const value = (amounts: bigint[]) => amounts.reduce((sum, a, i) => sum + a * weights[i]!, 0n)
  const hodlValue = value(policy.baselineAmounts.map(BigInt))
  const strategyValue = value(balances)
  const pnlValue = strategyValue - hodlValue
  const shortfall = pnlValue < 0n ? -pnlValue : 0n
  return {
    // All value fields have the same scale: USD * 10^(8 + valueTokenDecimals).
    valueTokenDecimals: scale, hodlValue, strategyValue, pnlValue,
    lossBps: shortfall * 10_000n / hodlValue,
    breached: shortfall * 10_000n >= hodlValue * BigInt(policy.maxDrawdownBps),
  }
}
