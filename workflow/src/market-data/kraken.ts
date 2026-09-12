import { parseUnits } from 'viem';
import { z } from 'zod';
import { assertFresh, type Config } from './config';
import { bookMetrics, volatilityBps, VOLATILITY_METHOD } from '../market-math';

const decimal = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/);
const timestamp = z.number().int().positive().safe();
const level = z.tuple([decimal, decimal, timestamp]);
const bookSchema = z.object({ error: z.array(z.string()).max(0), result: z.object({
  ETHUSDC: z.object({ bids: z.array(level).length(1), asks: z.array(level).length(1) }),
}).strict() });
const bar = z.tuple([timestamp, decimal, decimal, decimal, decimal, decimal, decimal, z.number().int().nonnegative().safe()]);
const ohlcSchema = z.object({ error: z.array(z.string()).max(0), result: z.object({
  // Live responses can include 720 historical bars plus the current bar.
  ETHUSDC: z.array(bar).min(31).max(721), last: timestamp,
}).strict() });
export type MarketObservation = {
  bid: bigint; ask: bigint; bidAt: bigint; askAt: bigint; httpResponseAt: bigint;
  // Canonical decimal integer strings permit exact consensus on completed bars.
  closePrices: string[]; tradeCounts: number[]; candleOpenTimes: number[];
};

export function parseBook(body: unknown, now: bigint, config: Config) {
  const book = bookSchema.parse(body).result.ETHUSDC;
  const [bid, bidQty, bidAt] = book.bids[0]!;
  const [ask, askQty, askAt] = book.asks[0]!;
  if (parseUnits(bidQty, 8) <= 0n || parseUnits(askQty, 8) <= 0n) throw new Error('Empty order book level');
  const result = { bid: parseUnits(bid, 8), ask: parseUnits(ask, 8), bidAt: BigInt(bidAt), askAt: BigInt(askAt) };
  validateBook(result, now, config);
  return result;
}

function validateBook(book: Pick<MarketObservation, 'bid' | 'ask' | 'bidAt' | 'askAt'>, now: bigint, config: Config) {
  assertFresh('Bid', book.bidAt, now, config.maxBookAgeSeconds, config.clockSkewSeconds);
  assertFresh('Ask', book.askAt, now, config.maxBookAgeSeconds, config.clockSkewSeconds);
  const metrics = bookMetrics(book.bid, book.ask);
  if (metrics.spreadBps > BigInt(config.maxSpreadBps)) throw new Error('Order book spread exceeds data-quality limit');
  return metrics;
}

export function windowEnd(now: bigint): number { return Number(now / 60n * 60n - 60n); }

export function parseCandles(body: unknown, now: bigint) {
  const bars = ohlcSchema.parse(body).result.ETHUSDC;
  const end = windowEnd(now);
  const first = end - 31 * 60;
  const byTime = new Map<number, z.infer<typeof bar>>();
  for (const row of bars) {
    if (row[0] % 60 !== 0 || byTime.has(row[0])) throw new Error('Duplicate or unaligned OHLC timestamp');
    byTime.set(row[0], row);
  }
  const closePrices: string[] = [], tradeCounts: number[] = [], candleOpenTimes: number[] = [];
  for (let t = first; t < end; t += 60) {
    const row = byTime.get(t);
    if (!row) throw new Error('Missing completed minute candle');
    const [open, high, low, close] = row.slice(1, 5).map(v => parseUnits(String(v), 8));
    if (low! <= 0n || low! > open! || low! > close! || high! < open! || high! < close!) throw new Error('Invalid OHLC price bounds');
    const volume = parseUnits(row[6], 8);
    if ((row[7] === 0) !== (volume === 0n)) throw new Error('Inconsistent candle trade count and volume');
    closePrices.push(close!.toString()); tradeCounts.push(row[7]); candleOpenTimes.push(t);
  }
  return { closePrices, tradeCounts, candleOpenTimes };
}

export function summarizeMarket(observation: MarketObservation, now: bigint, config: Config) {
  const { midpoint, spreadBps } = validateBook(observation, now, config);
  assertFresh('HTTP response', observation.httpResponseAt, now, config.maxHttpResponseAgeSeconds, config.clockSkewSeconds);
  const end = windowEnd(now);
  if (observation.candleOpenTimes.length !== 31 || observation.tradeCounts.length !== 31 ||
      observation.candleOpenTimes.some((t, i) => t !== end - (31 - i) * 60)) throw new Error('Incomplete volatility window');
  const tradedIntervals = observation.tradeCounts.slice(1).filter(n => n > 0).length;
  if (tradedIntervals < config.minTradedIntervals) throw new Error('Insufficient traded minute intervals');
  const lastIndex = observation.tradeCounts.findLastIndex(n => n > 0);
  if (lastIndex < 0) throw new Error('No completed traded candle');
  // Conservative start of the minute containing a trade, not an invented trade timestamp.
  const lastTradedCandleAt = observation.candleOpenTimes[lastIndex]!;
  assertFresh('Last traded candle', BigInt(lastTradedCandleAt), now, config.maxLastTradeAgeSeconds, config.clockSkewSeconds);
  return { midpoint, spreadBps: Number(spreadBps), volatility: {
    method: VOLATILITY_METHOD, bps: volatilityBps(observation.closePrices.map(BigInt)),
    lookbackMinutes: 30, intervalSeconds: 60, completionLagSeconds: 60,
    windowStart: end - 30 * 60, windowEnd: end, samples: 31, returns: 30,
    tradedIntervals, zeroTradeIntervals: 30 - tradedIntervals, lastTradedCandleAt,
    closePricesScaled: observation.closePrices, tradeCounts: observation.tradeCounts,
    candleOpenTimes: observation.candleOpenTimes,
  } };
}
