import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKrakenMarketSource } from '../src/market-source.ts'

test('resident public market observations deduplicate changes, retain restart cursors and never refresh failed health on a skipped poll', async () => {
  let now = 1800000010000, price = '2500', fail = false, stale = false, calls = 0
  const read = async () => {
    calls++
    if (fail) throw new Error('source unavailable')
    const timestamp = Math.floor(now / 1000) - (stale ? 100 : 0)
    return { receivedAt: now, body: { error: [], result: { ETHUSDC: { bids: [[price, '1', timestamp]], asks: [[price, '1', timestamp]] } } } }
  }
  const options = { read, clock: () => now }, source = createKrakenMarketSource(options), signal = new AbortController().signal
  const first = await source.poll(signal); assert.equal(first.events.length, 1)
  assert.equal((await source.poll(signal, first.cursor)).skipped, true); assert.equal(calls, 1)
  now += 30000
  const unchanged = await source.poll(signal, first.cursor); assert.equal(unchanged.events.length, 0)
  assert.equal(unchanged.observedAt, new Date(now).toISOString())
  assert.equal((await createKrakenMarketSource(options).poll(signal, unchanged.cursor)).events.length, 0)
  now += 30000
  const minute = await source.poll(signal, unchanged.cursor); assert.equal(minute.events.length, 1, 'rolling window changed')
  now += 30000; price = '2490'
  const changed = await source.poll(signal, minute.cursor); assert.equal(changed.events.length, 1)
  now += 30000; fail = true
  await assert.rejects(source.poll(signal, changed.cursor), /unavailable/)
  assert.deepEqual(await source.poll(signal, changed.cursor), { events: [], skipped: true })
  now += 30000; fail = false; stale = true
  await assert.rejects(source.poll(signal, changed.cursor), /stale-price/)
  now += 30000; stale = false
  assert.equal((await source.poll(signal, changed.cursor)).events.length, 1)
})
