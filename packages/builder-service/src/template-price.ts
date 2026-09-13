import { z } from 'zod'
import { formatUnits } from 'viem'
import { scaledDecimal, sepoliaStandingProfile, type PriceSnapshot, type TemplateVersion } from '@pintool/strategy-builder'
import { ServiceError } from './errors.ts'

export const TEMPLATE_PRICE_SOURCE = 'https://api.kraken.com/0/public/Depth?pair=ETHUSDC&count=1'
const amount = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/)
const level = z.tuple([amount, amount, z.number().int().positive().safe()])
const bookSchema = z.object({ error: z.array(z.string()).max(0), result: z.object({
  ETHUSDC: z.object({ bids: z.array(level).length(1), asks: z.array(level).length(1) }).strict(),
}).strict() }).strict()

/** Mirrors workflow market-data quality rules for a single price observation:
 * 60s book age, 5s skew, positive levels, uncrossed book, upward-rounded <=100bps spread.
 * ETH/USDC is explicitly a market proxy for these Sepolia tokens, not their redemption value. */
export function priceFromKrakenBook(template: Pick<TemplateVersion, 'spec'>, body: unknown, observedAt: number): PriceSnapshot {
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw new Error('invalid-observation-time')
  const spec = template.spec, weth = sepoliaStandingProfile.tokens.find(t => t.symbol === 'WETH')!, usdc = sepoliaStandingProfile.tokens.find(t => t.symbol === 'USDC')!
  const forward = spec.baseToken?.address === weth.address && spec.quoteToken?.address === usdc.address
  const reversed = spec.baseToken?.address === usdc.address && spec.quoteToken?.address === weth.address
  if (spec.profileId !== sepoliaStandingProfile.id || (!forward && !reversed)) throw new Error('price-pair-unsupported')
  const book = bookSchema.parse(body).result.ETHUSDC, nowSec = Math.floor(observedAt / 1000)
  for (const [price, quantity, at] of [book.bids[0]!, book.asks[0]!]) {
    if (scaledDecimal(price, 8) <= 0n || scaledDecimal(quantity, 8) <= 0n || nowSec - at > 60 || at > nowSec + 5) throw new Error('invalid-or-stale-price-level')
  }
  const bid = scaledDecimal(book.bids[0]![0], 8), ask = scaledDecimal(book.asks[0]![0], 8), midpoint = (bid + ask) / 2n
  if (ask < bid || ((ask - bid) * 10000n + midpoint - 1n) / midpoint > 100n) throw new Error('invalid-price-spread')
  const price = forward ? formatUnits(midpoint, 8) : formatUnits(10n ** 26n / midpoint, 18)
  if (scaledDecimal(price) === 0n) throw new Error('reciprocal-price-collapses')
  // Use the older book level time so a later database commit cannot grant another
  // freshness window to market data that was already nearly 60 seconds old.
  const oldestAt = Math.min(observedAt, Number(book.bids[0]![2]) * 1000, Number(book.asks[0]![2]) * 1000)
  return { source: `${TEMPLATE_PRICE_SOURCE}#ETH-USDC-proxy${reversed ? '-reciprocal' : ''}`, observedAt: new Date(oldestAt).toISOString(),
    baseToken: spec.baseToken!.address, quoteToken: spec.quoteToken!.address, price }
}

/** Operator adapter: one fixed public URL, no credentials, redirects or caller-selected source. */
export async function readKrakenBook(signal?: AbortSignal): Promise<{ body: unknown; receivedAt: number }> {
  const combined = AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])])
  try {
    const response = await fetch(TEMPLATE_PRICE_SOURCE, { signal: combined, redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok || !response.body) throw new Error('price-fetch-failed')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 16384) throw new Error('price-response-too-large')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), receivedAt: Date.now() }
  } catch { throw new ServiceError('template-price-unavailable', 503) }
}

export async function krakenTemplatePrice(template: TemplateVersion, signal?: AbortSignal): Promise<PriceSnapshot> {
  const observation = await readKrakenBook(signal)
  return priceFromKrakenBook(template, observation.body, observation.receivedAt)
}
