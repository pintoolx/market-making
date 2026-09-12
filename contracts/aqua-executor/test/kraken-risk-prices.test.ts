import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUsdBook } from '../src/kraken-risk-prices.ts'

const now = 1800000000
const book = () => ({ error: [], result: { USDCUSD: { bids: [['0.9998', '10', now]], asks: [['0.9999', '10', now - 20]] } } })
test('USD risk references retain observed USDC price and oldest quote timestamp', () => {
  const quote = parseUsdBook(book(), 'USDCUSD', now)
  assert.equal(quote.midpoint, 99985000n)
  assert.equal(quote.asOf, now - 20)
})
test('USD risk prices reject stale, crossed, malformed, wrong-pair and excessive-spread observations', () => {
  const cases = [
    (b: ReturnType<typeof book>) => { b.result.USDCUSD.asks[0]![2] = now - 91 },
    (b: ReturnType<typeof book>) => { b.result.USDCUSD.asks[0]![2] = now + 16 },
    (b: ReturnType<typeof book>) => { b.result.USDCUSD.asks[0]![0] = '0.9' },
    (b: ReturnType<typeof book>) => { b.result.USDCUSD.asks[0]![0] = '1.000000001' },
    (b: ReturnType<typeof book>) => { b.result.USDCUSD.bids[0]![0] = '0.8' },
    (b: ReturnType<typeof book>) => { b.result.USDCUSD.bids[0]![1] = '0' },
  ]
  for (const change of cases) { const b = book(); change(b); assert.throws(() => parseUsdBook(b, 'USDCUSD', now)) }
  assert.throws(() => parseUsdBook(book(), 'XETHZUSD', now))
  assert.throws(() => parseUsdBook(null, 'USDCUSD', now))
  assert.throws(() => parseUsdBook(book(), 'USDCUSD', NaN))
})
