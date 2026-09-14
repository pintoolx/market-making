import { digestJson, sepoliaStandingProfile, type StrategySpec } from '@pintool/strategy-builder'
import { normalizeMarketUpdate, type EventSource } from './event-adapters.ts'
import { priceFromKrakenBook, readKrakenBook } from './template-price.ts'

/** A public observation wakes the evaluator; it is never an authorization.
 * Timestamp-only book refreshes do not produce another event. A new completed
 * minute does: the workflow's rolling volatility window has then changed. */
export function createKrakenMarketSource(options: {
  intervalMs?: number; clock?: () => number; read?: typeof readKrakenBook
} = {}): EventSource {
  const interval = options.intervalMs ?? 30000, clock = options.clock ?? Date.now, read = options.read ?? readKrakenBook
  if (!Number.isSafeInteger(interval) || interval < 15000 || interval > 60000) throw new Error('invalid-market-source-interval')
  const spec: StrategySpec = { title: 'Public ETH/USDC proxy', profileId: sepoliaStandingProfile.id,
    baseToken: sepoliaStandingProfile.tokens.find(t => t.symbol === 'WETH'), quoteToken: sepoliaStandingProfile.tokens.find(t => t.symbol === 'USDC'), modifiers: [] }
  let nextPoll = 0
  return {
    source: 'market.kraken',
    async poll(signal, cursor) {
      // A skipped poll must not refresh source health or erase an outage.
      if (clock() < nextPoll) return { events: [], skipped: true }
      nextPoll = clock() + interval
      const observation = await read(signal), price = priceFromKrakenBook({ spec }, observation.body, observation.receivedAt)
      const minute = Math.floor(Date.parse(price.observedAt) / 60000)
      const identity = digestJson({ price: price.price, minute })
      // On a price returning to an earlier level in the same minute, preserve
      // distinct observation identity while still deduplicating restart replay.
      const eventId = digestJson({ identity, previous: cursor?.identity ?? null, observedAt: price.observedAt })
      return { events: cursor?.identity === identity ? [] : [normalizeMarketUpdate('market.kraken', { eventId, price: price.price, observedAt: price.observedAt })],
        cursor: { identity }, observedAt: price.observedAt }
    },
  }
}
