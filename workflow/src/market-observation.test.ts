import { expect, test } from 'bun:test'
import { marketFromObservation, OBSERVATION_USDC, OBSERVATION_WETH } from './market-observation'
import { volatilityBps, VOLATILITY_METHOD } from './market-math'
import { computeAuthorization } from './intersect'
import type { ReportIdentity } from './types'

const NOW = 1_800_000_000
const MAKER = '0x3333333333333333333333333333333333333333'
const context = { nowSec: NOW, expectedMaker: MAKER }
const fixture = () => ({
	schemaVersion: 'market-observation-v2', observedAt: String(NOW), maker: MAKER,
	chain: { chainId: 11155111, chainSelector: '16015286601757825753', blockNumber: '100',
		blockHash: `0x${'ab'.repeat(32)}`, blockTimestamp: String(NOW - 600), finality: 'finalized' },
	price: { source: 'https://api.kraken.com/0/public/Depth?pair=ETHUSDC&count=1', pair: 'ETH/USDC', kind: 'mid-price',
		value: '2500', scaled: '250000000000', decimals: 8, bidScaled: '249900000000', askScaled: '250100000000',
		bidUpdatedAt: String(NOW), askUpdatedAt: String(NOW), httpResponseAt: String(NOW), spreadBps: 8 },
	volatility: { source: 'https://api.kraken.com/0/public/OHLC?pair=ETHUSDC&interval=1', method: VOLATILITY_METHOD,
		bps: 0, lookbackMinutes: 30, intervalSeconds: 60, completionLagSeconds: 60, windowStart: NOW - 1860, windowEnd: NOW - 60,
		samples: 31, returns: 30, tradedIntervals: 30, zeroTradeIntervals: 0, lastTradedCandleAt: NOW - 120,
		closePricesScaled: Array<string>(31).fill('250000000000'), tradeCounts: Array<number>(31).fill(1),
		candleOpenTimes: Array.from({ length: 31 }, (_, i) => NOW - 60 - (31 - i) * 60) },
	balanceScope: 'maker-wallet', tokens: {
		WETH: { address: OBSERVATION_WETH, decimals: 18, balanceAtomic: '4000000000000000' },
		USDC: { address: OBSERVATION_USDC, decimals: 6, balanceAtomic: '10000000' } },
	authorizationInput: { complete: true, marketSnapshot: { midPrice: '2500', volatilityBps: 0,
		balance0: '4000000000000000', balance1: '10000000', decimals0: 18, decimals1: 6 } },
})

test('validated observation produces the exact existing market schema', () => {
	const o = fixture()
	expect(marketFromObservation(o, context)).toEqual(o.authorizationInput.marketSnapshot)
	expect(() => marketFromObservation(o, { ...context, nowSec: NOW + 90 })).not.toThrow()
	expect(() => marketFromObservation(o, { ...context, nowSec: NOW + 91 })).toThrow('Observation is stale')
})

test('wrong identity, network, scope, precision, amount bounds and incomplete inputs fail', () => {
	const changes: ((o: ReturnType<typeof fixture>) => void)[] = [
		o => { o.maker = OBSERVATION_USDC }, o => { o.chain.chainId = 84532 },
		o => { o.chain.chainSelector = '1' }, o => { o.chain.finality = 'latest' },
		o => { o.tokens.USDC.address = OBSERVATION_WETH }, o => { o.tokens.USDC.decimals = 18 },
		o => { o.tokens.WETH.balanceAtomic = (1n << 256n).toString() },
		o => { o.balanceScope = 'aqua-strategy' }, o => { o.authorizationInput.complete = false },
		o => { o.price.value = '2500.000000001' }, o => { o.schemaVersion = 'market-observation-v1' },
	]
	for (const change of changes) { const o = fixture(); change(o); expect(() => marketFromObservation(o, context)).toThrow() }
})

test('stale/future market data and inconsistent embedded authorization inputs fail', () => {
	for (const field of ['bidUpdatedAt', 'askUpdatedAt', 'httpResponseAt'] as const) {
		for (const at of [NOW - 91, NOW + 16]) {
			const o = fixture(); o.price[field] = String(at)
			expect(() => marketFromObservation(o, context)).toThrow()
		}
	}
	const old = fixture(); old.chain.blockTimestamp = String(NOW - 1801)
	expect(() => marketFromObservation(old, context)).toThrow('Finalized block')
	const altered = fixture(); altered.authorizationInput.marketSnapshot.balance0 = '0'
	expect(() => marketFromObservation(altered, context)).toThrow('Authorization input mismatch')
	const mid = fixture(); mid.price.scaled = '250100000000'
	expect(() => marketFromObservation(mid, context)).toThrow('midpoint')
})

test('volatility is re-derived from aligned completed samples and trade evidence', () => {
	const changes: ((o: ReturnType<typeof fixture>) => void)[] = [
		o => { o.volatility.bps = 1 }, o => { o.volatility.candleOpenTimes[1] += 60 },
		o => { o.volatility.windowEnd += 60 }, o => { o.volatility.tradeCounts.fill(0) },
		o => { o.volatility.tradedIntervals = 29 }, o => { o.volatility.lastTradedCandleAt++ },
		o => { o.volatility.closePricesScaled[0] = '0' },
	]
	for (const change of changes) { const o = fixture(); change(o); expect(() => marketFromObservation(o, context)).toThrow() }
})

test('public synthetic policy can pause on a defined volatility threshold through the existing evaluator', () => {
	const o = fixture()
	o.volatility.closePricesScaled = ['10000000000', ...Array<string>(30).fill('10100000000')]
	o.volatility.bps = volatilityBps(o.volatility.closePricesScaled.map(BigInt))
	o.authorizationInput.marketSnapshot.volatilityBps = o.volatility.bps
	const market = marketFromObservation(o, context)
	expect(market.volatilityBps).toBe(100)
	const input = {
		market, nowSec: NOW, nonce: 1n,
		identity: { chainId: 11155111n, guard: MAKER, router: MAKER, maker: MAKER,
			strategyHash: `0x${'11'.repeat(32)}`, token0: OBSERVATION_WETH, token1: OBSERVATION_USDC } as ReportIdentity,
		strategy: { schemaVersion: 1 as const, strategyId: 'public-test-only', rules: [{ id: 'calm', when: { volatilityBpsMax: 100 },
			allowMakerBuyToken0: true, allowMakerSellToken0: true, maxAmount0PerSwap: '100000000000000', maxAmount1PerSwap: '1000000', ttlSec: 120 }],
			inventory: { maxBalance0: '1000000000000000000', maxBalance1: '1000000000' } },
		limits: { schemaVersion: 1 as const, maxBudget1: '100000000', maxToken0ShareBps: 6000,
			maxAmount0PerSwap: '100000000000000', maxAmount1PerSwap: '1000000', maxTtlSec: 120 },
	}
	expect(computeAuthorization(input).report.allowedDirections).toBe(3)
	input.strategy.rules[0]!.when.volatilityBpsMax = 99
	const paused = computeAuthorization(input).report
	expect(paused.allowedDirections).toBe(0)
	expect(paused.maxAmount0PerSwap).toBe(0n)
})
