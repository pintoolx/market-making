import { parseUnits } from 'viem'
import type { PriceSnapshot } from './risk.ts'
import type { Deployment } from './types.ts'

/** Separate USD quotes for ETH and USDC; never treat USDC as exactly one USD. */
export function parseUsdBook(body: unknown, pair: 'XETHZUSD' | 'USDCUSD', now: number) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid observation time')
  const input = body as { error?: unknown; result?: Record<string, { bids?: unknown; asks?: unknown }> }
  if (!input || !Array.isArray(input.error) || input.error.length || !input.result || Object.keys(input.result).length !== 1 || !input.result[pair]) throw new Error('Invalid Kraken USD book response')
  const parse = (rows: unknown) => {
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 3) throw new Error('Expected one price level')
    const [price, quantity, timestamp] = rows[0]
    if (typeof price !== 'string' || typeof quantity !== 'string' || !/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/.test(price) ||
      !/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/.test(quantity)) throw new Error('Invalid USD price precision')
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now + 15 || now - timestamp > 90) throw new Error('USD book timestamp is stale or in the future')
    const scaled = parseUnits(price, 8)
    if (scaled <= 0n || parseUnits(quantity, 8) <= 0n) throw new Error('Empty USD book level')
    return { scaled, timestamp: timestamp as number }
  }
  const bid = parse(input.result[pair].bids), ask = parse(input.result[pair].asks)
  const midpoint = (bid.scaled + ask.scaled) / 2n
  if (ask.scaled < bid.scaled || (ask.scaled - bid.scaled) * 10000n > midpoint * 100n) throw new Error('Crossed or excessively wide USD book')
  return { midpoint, asOf: Math.min(bid.timestamp, ask.timestamp), bid, ask }
}

export async function fetchKrakenRiskPrices(d: Deployment): Promise<PriceSnapshot> {
  if (d.chainId !== 11155111 || d.tokens.WETH?.toLowerCase() !== '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' ||
    d.tokens.USDC?.toLowerCase() !== '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') throw new Error('USD reference mapping requires canonical Ethereum Sepolia WETH/USDC')
  const observations = await Promise.all(([['ETHUSD', 'XETHZUSD'], ['USDCUSD', 'USDCUSD']] as const).map(async ([requestPair, resultPair]) => {
    const response = await fetch(`https://api.kraken.com/0/public/Depth?pair=${requestPair}&count=1`, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`Kraken USD book HTTP ${response.status}`)
    const responseAt = Math.floor(Date.parse(response.headers.get('date') ?? '') / 1000)
    const body = await response.json(), now = Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(responseAt) || responseAt > now + 15 || now - responseAt > 90) throw new Error('Stale USD book HTTP response')
    return { pair: requestPair, httpResponseAt: responseAt, ...parseUsdBook(body, resultPair, now) }
  }))
  return { asOf: Math.min(...observations.map(o => o.asOf)), source: 'Kraken ETH/USD and USDC/USD order-book midpoints', mode: 'live',
    usdE8: { [d.tokens.WETH!]: observations[0]!.midpoint.toString(), [d.tokens.USDC!]: observations[1]!.midpoint.toString() },
    evidence: { observations: observations.map(o => ({ ...o, midpoint: o.midpoint.toString(),
      bid: { ...o.bid, scaled: o.bid.scaled.toString() }, ask: { ...o.ask, scaled: o.ask.scaled.toString() } })) } }
}
