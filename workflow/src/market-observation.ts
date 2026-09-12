import { formatUnits, isAddress, parseUnits } from 'viem'
import { z } from 'zod'
import { bookMetrics, volatilityBps, VOLATILITY_METHOD } from './market-math'
import { marketSnapshotSchema, type MarketSnapshot } from './types'

// Ethereum Sepolia addresses: contracts/aqua-executor/deployments/11155111.json.
export const OBSERVATION_WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'
export const OBSERVATION_USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(s => BigInt(s) < 1n << 256n)
const price = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/)
const second = z.number().int().positive().safe()
const count = z.number().int().nonnegative().safe()
const token = z.object({ address: z.string(), decimals: count, balanceAtomic: uint })
const observationSchema = z.object({
	schemaVersion: z.literal('market-observation-v2'),
	observedAt: uint, maker: z.string().refine(isAddress),
	chain: z.object({ chainId: z.literal(11155111), chainSelector: z.literal('16015286601757825753'),
		blockNumber: uint, blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), blockTimestamp: uint, finality: z.literal('finalized') }),
	price: z.object({ source: z.literal('https://api.kraken.com/0/public/Depth?pair=ETHUSDC&count=1'),
		pair: z.literal('ETH/USDC'), kind: z.literal('mid-price'), value: price, scaled: uint, decimals: z.literal(8),
		bidScaled: uint, askScaled: uint, bidUpdatedAt: uint, askUpdatedAt: uint, httpResponseAt: uint, spreadBps: count }),
	volatility: z.object({ source: z.literal('https://api.kraken.com/0/public/OHLC?pair=ETHUSDC&interval=1'),
		method: z.literal(VOLATILITY_METHOD), bps: count, lookbackMinutes: z.literal(30), intervalSeconds: z.literal(60),
		completionLagSeconds: z.literal(60), windowStart: second, windowEnd: second, samples: z.literal(31), returns: z.literal(30),
		tradedIntervals: count, zeroTradeIntervals: count, lastTradedCandleAt: second,
		closePricesScaled: z.array(uint).length(31), tradeCounts: z.array(count).length(31), candleOpenTimes: z.array(second).length(31) }),
	balanceScope: z.literal('maker-wallet'), tokens: z.object({ WETH: token, USDC: token }),
	authorizationInput: z.object({ complete: z.literal(true), marketSnapshot: marketSnapshotSchema }).strict(),
})

/** Data-quality defaults, NOT trading thresholds. Changing volatility method/window
 * requires an explicit adapter revision and recalibration of Provider rules.
 */
export const observationQualitySchema = z.object({
	maxObservationAgeSeconds: z.number().int().min(1).max(300).default(90),
	maxBookAgeSeconds: z.number().int().min(1).max(300).default(90),
	maxFinalizedBlockAgeSeconds: z.number().int().min(1).max(3600).default(1800),
	clockSkewSeconds: z.number().int().min(0).max(30).default(15),
	maxSpreadBps: z.number().int().min(1).max(1000).default(100),
	minTradedIntervals: z.number().int().min(1).max(30).default(5),
	maxLastTradeAgeSeconds: z.number().int().min(60).max(1800).default(900),
}).strict()

/** Public-data adapter only. Validation does not authenticate JSON, attest a TEE,
 * authorize a strategy, or replace Aqua's per-strategy inventory checks.
 * Call from a trusted data acquisition boundary; never trust arbitrary HTTP input
 * merely because it passes this schema.
 */
export function marketFromObservation(input: unknown, context: {
	expectedMaker: string; nowSec: number; quality?: z.input<typeof observationQualitySchema>
}): MarketSnapshot {
	const o = observationSchema.parse(input)
	const q = observationQualitySchema.parse(context.quality ?? {})
	if (!isAddress(context.expectedMaker) || o.maker.toLowerCase() !== context.expectedMaker.toLowerCase()) throw new Error('Observation maker mismatch')
	if (!Number.isSafeInteger(context.nowSec) || context.nowSec <= 0) throw new Error('Invalid current time')
	const now = BigInt(context.nowSec)
	const fresh = (label: string, t: string | number, maxAge: number) => {
		const at = BigInt(t)
		if (at <= 0n || at > now + BigInt(q.clockSkewSeconds) || now - at > BigInt(maxAge)) throw new Error(`${label} is stale or in the future`)
	}
	fresh('Observation', o.observedAt, q.maxObservationAgeSeconds)
	fresh('HTTP response', o.price.httpResponseAt, q.maxObservationAgeSeconds)
	fresh('Bid', o.price.bidUpdatedAt, q.maxBookAgeSeconds)
	fresh('Ask', o.price.askUpdatedAt, q.maxBookAgeSeconds)
	fresh('Finalized block', o.chain.blockTimestamp, q.maxFinalizedBlockAgeSeconds)
	if (BigInt(o.chain.blockNumber) <= 0n) throw new Error('Invalid block number')
	const { WETH, USDC } = o.tokens
	if (WETH.address.toLowerCase() !== OBSERVATION_WETH || USDC.address.toLowerCase() !== OBSERVATION_USDC || WETH.decimals !== 18 || USDC.decimals !== 6) throw new Error('Observation token or decimals mismatch')
	const book = bookMetrics(BigInt(o.price.bidScaled), BigInt(o.price.askScaled))
	if (book.spreadBps > BigInt(q.maxSpreadBps) || book.spreadBps !== BigInt(o.price.spreadBps) ||
		book.midpoint !== BigInt(o.price.scaled) || book.midpoint !== parseUnits(o.price.value, 8)) throw new Error('Inconsistent or excessive book spread/midpoint')
	const v = o.volatility
	const end = Number(BigInt(o.observedAt) / 60n * 60n - 60n)
	if (v.windowEnd !== end || v.windowStart !== end - 1800 || v.candleOpenTimes.some((t, i) => t !== end - (31 - i) * 60)) throw new Error('Incomplete volatility window')
	const traded = v.tradeCounts.slice(1).filter(n => n > 0).length
	const lastIndex = v.tradeCounts.findLastIndex(n => n > 0)
	if (traded < q.minTradedIntervals || traded !== v.tradedIntervals || 30 - traded !== v.zeroTradeIntervals ||
		lastIndex < 0 || v.lastTradedCandleAt !== v.candleOpenTimes[lastIndex]) throw new Error('Invalid traded interval evidence')
	fresh('Last traded candle', v.lastTradedCandleAt, q.maxLastTradeAgeSeconds)
	const bps = volatilityBps(v.closePricesScaled.map(BigInt))
	if (bps !== v.bps) throw new Error('Volatility does not match minute closes')
	const result = marketSnapshotSchema.parse({ midPrice: formatUnits(book.midpoint, 8), volatilityBps: bps,
		balance0: WETH.balanceAtomic, balance1: USDC.balanceAtomic, decimals0: 18, decimals1: 6 })
	for (const key of Object.keys(result) as (keyof MarketSnapshot)[]) {
		if (o.authorizationInput.marketSnapshot[key] !== result[key]) throw new Error(`Authorization input mismatch: ${key}`)
	}
	return result
}
