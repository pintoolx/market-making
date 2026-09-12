import { describe, expect, test } from 'bun:test'
import { computeAuthorization, makerToken0Ceiling, matchRule } from './intersect'
import {
	DIRECTION_TAKER_0_TO_1,
	DIRECTION_TAKER_1_TO_0,
	MAX_REPORT_LIFETIME_SEC,
	parsePrice,
	type MakerLimits,
	type MarketSnapshot,
	type ProviderStrategy,
	type ReportIdentity,
} from './types'

// ─── Fixtures (synthetic; nothing here is a real policy) ─────

const WETH = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString() // 18 decimals
const USDC = (n: number) => (BigInt(Math.round(n * 1e6))).toString() // 6 decimals

const identity: ReportIdentity = {
	chainId: 84532n,
	guard: '0x1111111111111111111111111111111111111111',
	router: '0x2222222222222222222222222222222222222222',
	maker: '0x3333333333333333333333333333333333333333',
	strategyHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
	token0: '0x5555555555555555555555555555555555555555',
	token1: '0x6666666666666666666666666666666666666666',
}

const strategy = (): ProviderStrategy => ({
	schemaVersion: 1,
	strategyId: 'test-strategy',
	rules: [
		{
			id: 'calm-two-sided',
			when: { priceMin: '1000', priceMax: '10000', volatilityBpsMax: 300 },
			allowMakerBuyToken0: true,
			allowMakerSellToken0: true,
			maxAmount0PerSwap: WETH(0.5),
			maxAmount1PerSwap: USDC(1500),
			ttlSec: 300,
		},
		{
			id: 'volatile-sell-only',
			when: { volatilityBpsMin: 301, volatilityBpsMax: 1000 },
			allowMakerBuyToken0: false,
			allowMakerSellToken0: true,
			maxAmount0PerSwap: WETH(0.1),
			maxAmount1PerSwap: USDC(300),
			ttlSec: 120,
		},
	],
	inventory: { maxBalance0: WETH(5), maxBalance1: USDC(50_000) },
})

const limits = (): MakerLimits => ({
	schemaVersion: 1,
	maxBudget1: USDC(10_000),
	maxToken0ShareBps: 6000,
	maxAmount0PerSwap: WETH(0.4),
	maxAmount1PerSwap: USDC(2000),
	maxTtlSec: 240,
})

const market = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
	midPrice: '3000',
	volatilityBps: 120,
	balance0: WETH(1),
	balance1: USDC(4000),
	decimals0: 18,
	decimals1: 6,
	...over,
})

const NOW = 1_800_000_000
const run = (over: {
	strategy?: ProviderStrategy
	limits?: MakerLimits
	market?: MarketSnapshot
	nowSec?: number
	nonce?: bigint
} = {}) =>
	computeAuthorization({
		strategy: over.strategy ?? strategy(),
		limits: over.limits ?? limits(),
		market: over.market ?? market(),
		identity,
		nowSec: over.nowSec ?? NOW,
		nonce: over.nonce ?? 7n,
	})

// ─── Tests ───────────────────────────────────────────────────

describe('computeAuthorization — happy path', () => {
	test('calm market: both directions, each cap taken from the stricter side', () => {
		const { report, trace } = run()

		expect(trace.matchedRuleId).toBe('calm-two-sided')
		expect(trace.pausedReason).toBeNull()
		expect(report.allowedDirections).toBe(DIRECTION_TAKER_0_TO_1 | DIRECTION_TAKER_1_TO_0)

		// token0 per-swap: maker 0.4 < provider 0.5 → maker binds
		expect(report.maxAmount0PerSwap).toBe(BigInt(WETH(0.4)))
		expect(trace.binding.maxAmount0PerSwap).toBe('maker')
		// token1 per-swap: provider 1500 < maker 2000 → provider binds
		expect(report.maxAmount1PerSwap).toBe(BigInt(USDC(1500)))
		expect(trace.binding.maxAmount1PerSwap).toBe('provider')

		// token1 inventory: maker budget 10k < provider 50k → maker binds
		expect(report.maxPostBalance1).toBe(BigInt(USDC(10_000)))
		expect(trace.binding.maxPostBalance1).toBe('maker')
		// token0 inventory: 60% × 10k USDC / 3000 = 2 WETH < provider 5 WETH → maker binds
		expect(report.maxPostBalance0).toBe(BigInt(WETH(2)))
		expect(trace.binding.maxPostBalance0).toBe('maker')

		// identity + nonce pass through untouched
		expect(report.schemaVersion).toBe(1)
		expect(report.chainId).toBe(identity.chainId)
		expect(report.maker).toBe(identity.maker)
		expect(report.strategyHash).toBe(identity.strategyHash)
		expect(report.nonce).toBe(7n)
	})

	test('Maker stricter than Provider on every axis → every cap is the Maker number', () => {
		const tight = limits()
		tight.maxAmount0PerSwap = WETH(0.01)
		tight.maxAmount1PerSwap = USDC(10)
		tight.maxBudget1 = USDC(100)
		tight.maxToken0ShareBps = 1000 // 10% × 100 USDC / 3000 ≈ 0.00333 WETH
		const { report, trace } = run({ limits: tight, market: market({ balance0: '0', balance1: '0' }) })

		expect(report.maxAmount0PerSwap).toBe(BigInt(WETH(0.01)))
		expect(report.maxAmount1PerSwap).toBe(BigInt(USDC(10)))
		expect(report.maxPostBalance1).toBe(BigInt(USDC(100)))
		expect(report.maxPostBalance0).toBe(makerToken0Ceiling(tight, market()))
		expect(Object.values(trace.binding).every((s) => s === 'maker')).toBe(true)
		expect(report.allowedDirections).toBe(3)
	})

	test('first matching rule wins and regime change flips directions', () => {
		const { report, trace } = run({ market: market({ volatilityBps: 500 }) })

		expect(trace.matchedRuleId).toBe('volatile-sell-only')
		expect(report.allowedDirections).toBe(DIRECTION_TAKER_1_TO_0) // sell only
		expect(report.maxAmount0PerSwap).toBe(BigInt(WETH(0.1)))
		expect(report.maxAmount1PerSwap).toBe(BigInt(USDC(300)))
	})
})

describe('computeAuthorization — incompatibility → everything forbidden', () => {
	test('Maker per-swap cap of zero on one token disables both directions and zeroes all caps', () => {
		const l = limits()
		l.maxAmount1PerSwap = '0'
		const { report, trace } = run({ limits: l })

		expect(trace.pausedReason).toBe('per-swap-cap-zero')
		expect(report.allowedDirections).toBe(0)
		expect(report.maxAmount0PerSwap).toBe(0n)
		expect(report.maxAmount1PerSwap).toBe(0n)
		expect(report.maxPostBalance0).toBe(0n)
		expect(report.maxPostBalance1).toBe(0n)
	})

	test('no rule matches the market → paused, no rule id, still a valid window', () => {
		const { report, trace } = run({ market: market({ volatilityBps: 5000 }) })

		expect(trace.matchedRuleId).toBeNull()
		expect(trace.pausedReason).toBe('no-rule-matched')
		expect(report.allowedDirections).toBe(0)
		expect(report.validUntil - report.validAfter).toBe(240) // maker TTL still bounds a pause
	})

	test('rule that allows neither direction → paused with its own reason', () => {
		const s = strategy()
		s.rules[0].allowMakerBuyToken0 = false
		s.rules[0].allowMakerSellToken0 = false
		const { report, trace } = run({ strategy: s })

		expect(trace.matchedRuleId).toBe('calm-two-sided')
		expect(trace.pausedReason).toBe('rule-disallows-both-directions')
		expect(report.allowedDirections).toBe(0)
	})
})

describe('computeAuthorization — inventory exhausted', () => {
	test('both inventories at/over cap → paused, zero caps', () => {
		const { report, trace } = run({
			market: market({ balance0: WETH(2), balance1: USDC(10_000) }), // exactly at both caps
		})

		expect(trace.pausedReason).toBe('inventory-exhausted-both-directions')
		expect(report.allowedDirections).toBe(0)
		expect(report.maxPostBalance0).toBe(0n)
		expect(report.maxPostBalance1).toBe(0n)
	})

	test('only token0 inventory exhausted → Maker may still sell token0 (taker 1→0)', () => {
		const { report, trace } = run({ market: market({ balance0: WETH(2.5) }) })

		expect(trace.pausedReason).toBeNull()
		expect(report.allowedDirections).toBe(DIRECTION_TAKER_1_TO_0)
		expect(report.maxPostBalance0).toBe(BigInt(WETH(2))) // caps stay published for the open direction
	})

	test('only token1 inventory exhausted → Maker may still buy token0 (taker 0→1)', () => {
		const { report } = run({ market: market({ balance1: USDC(10_000) }) })

		expect(report.allowedDirections).toBe(DIRECTION_TAKER_0_TO_1)
	})
})

describe('computeAuthorization — expiry', () => {
	test('validity = min(rule TTL, Maker TTL) and never exceeds the Guard maximum', () => {
		const a = run() // rule 300, maker 240
		expect(a.report.validAfter).toBe(NOW)
		expect(a.report.validUntil).toBe(NOW + 240)

		const l = limits()
		l.maxTtlSec = 600
		const b = run({ limits: l }) // rule 300, maker 600
		expect(b.report.validUntil - b.report.validAfter).toBe(300)

		const s = strategy()
		s.rules[0].ttlSec = 600
		const c = run({ strategy: s, limits: l })
		expect(c.report.validUntil - c.report.validAfter).toBe(MAX_REPORT_LIFETIME_SEC)
	})

	test('rejects a non-positive nonce and a bad clock', () => {
		expect(() => run({ nonce: 0n })).toThrow('nonce')
		expect(() => run({ nowSec: -1 })).toThrow('nowSec')
	})
})

describe('helpers', () => {
	test('parsePrice keeps 8 decimals and truncates beyond', () => {
		expect(parsePrice('3000')).toBe(300_000_000_000n)
		expect(parsePrice('3000.25')).toBe(300_025_000_000n)
		expect(parsePrice('0.123456789')).toBe(12_345_678n)
	})

	test('makerToken0Ceiling: 60% of 10 000 USDC at 2 500 USDC/WETH = 2.4 WETH', () => {
		expect(makerToken0Ceiling(limits(), market({ midPrice: '2500' }))).toBe(BigInt(WETH(2.4)))
	})

	test('makerToken0Ceiling throws on a zero price instead of dividing by zero', () => {
		expect(() => makerToken0Ceiling(limits(), market({ midPrice: '0' }))).toThrow('midPrice')
	})

	test('matchRule respects inclusive bounds', () => {
		const s = strategy()
		expect(matchRule(s, market({ midPrice: '1000' }))?.id).toBe('calm-two-sided')
		expect(matchRule(s, market({ midPrice: '10000' }))?.id).toBe('calm-two-sided')
		expect(matchRule(s, market({ midPrice: '10000.00000001' }))).toBeNull()
		expect(matchRule(s, market({ volatilityBps: 300 }))?.id).toBe('calm-two-sided')
		expect(matchRule(s, market({ volatilityBps: 301 }))?.id).toBe('volatile-sell-only')
	})
})
