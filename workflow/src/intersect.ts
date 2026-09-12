/**
 * Pure intersection of the Provider strategy and the Maker limits.
 *
 * No runtime, no I/O, no clock: everything the enclave needs is passed in, so
 * this file is unit-testable outside the TEE and deterministic for a given
 * input (the enclave result is attested and must be reproducible).
 *
 * Output is a `GuardReportV1` (the public, on-chain authorization) plus a
 * `DecisionTrace` that must never leave the enclave.
 */
import {
	BPS,
	DIRECTION_TAKER_0_TO_1,
	DIRECTION_TAKER_1_TO_0,
	MAX_REPORT_LIFETIME_SEC,
	PRICE_SCALE,
	UINT128_MAX,
	UINT48_MAX,
	UINT64_MAX,
	parsePrice,
	type Authorization,
	type DecisionTrace,
	type GuardReportV1,
	type MakerLimits,
	type MarketSnapshot,
	type ProviderStrategy,
	type ReportIdentity,
	type StrategyRule,
} from './types'

export type IntersectInput = {
	strategy: ProviderStrategy
	limits: MakerLimits
	market: MarketSnapshot
	identity: ReportIdentity
	/** Unix seconds (from `runtime.now()`, never `Date.now()`). */
	nowSec: number
	/** Strictly increasing per (maker, strategyHash); the caller owns the source. */
	nonce: bigint
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

type Side = 'provider' | 'maker' | 'equal'
const whoBinds = (provider: bigint, maker: bigint): Side =>
	provider === maker ? 'equal' : provider < maker ? 'provider' : 'maker'

/** First rule whose every stated condition holds for the snapshot; null if none. */
export function matchRule(strategy: ProviderStrategy, market: MarketSnapshot): StrategyRule | null {
	const price = parsePrice(market.midPrice)
	for (const rule of strategy.rules) {
		const w = rule.when
		if (w.priceMin !== undefined && price < parsePrice(w.priceMin)) continue
		if (w.priceMax !== undefined && price > parsePrice(w.priceMax)) continue
		if (w.volatilityBpsMin !== undefined && market.volatilityBps < w.volatilityBpsMin) continue
		if (w.volatilityBpsMax !== undefined && market.volatilityBps > w.volatilityBpsMax) continue
		return rule
	}
	return null
}

/**
 * Maker's token0 ceiling implied by "at most `maxToken0ShareBps` of
 * `maxBudget1` may sit in token0", valued at the current mid price.
 *
 *   value1 = maxBudget1 * share / BPS                     (token1 atomic)
 *   amount0 = value1 * 10^dec0 * PRICE_SCALE / (price * 10^dec1)
 */
const token1ValueToToken0 = (value1: bigint, market: MarketSnapshot): bigint => {
	const price = parsePrice(market.midPrice)
	if (price <= 0n) throw new Error('market snapshot: midPrice must be positive')
	const num = value1 * 10n ** BigInt(market.decimals0) * PRICE_SCALE
	const den = price * 10n ** BigInt(market.decimals1)
	return num / den
}

export function makerToken0Ceiling(limits: MakerLimits, market: MarketSnapshot): bigint {
	const shareValue1 = (BigInt(limits.maxBudget1) * BigInt(limits.maxToken0ShareBps)) / BPS
	const value1 = limits.schemaVersion === 2 ? min(shareValue1, BigInt(limits.maxToken0Value1)) : shareValue1
	return token1ValueToToken0(value1, market)
}

const clampU128 = (v: bigint): bigint => (v > UINT128_MAX ? UINT128_MAX : v)

export function computeAuthorization(input: IntersectInput): Authorization {
	const { strategy, limits, market, identity, nowSec, nonce } = input

	if (nonce <= 0n || nonce > UINT64_MAX) throw new Error('nonce must be in (0, 2^64)')
	if (!Number.isInteger(nowSec) || nowSec < 0 || BigInt(nowSec) > UINT48_MAX) {
		throw new Error('nowSec must be a uint48 unix timestamp')
	}

	const balance0 = BigInt(market.balance0)
	const balance1 = BigInt(market.balance1)

	// ── 1. Provider picks the regime ──
	const rule = matchRule(strategy, market)

	// ── 2. Per-swap caps: the stricter side wins ──
	const providerCap0 = rule ? BigInt(rule.maxAmount0PerSwap) : 0n
	const providerCap1 = rule ? BigInt(rule.maxAmount1PerSwap) : 0n
	const makerCap0 = limits.schemaVersion === 2
		? token1ValueToToken0(BigInt(limits.maxSwapValue1), market)
		: BigInt(limits.maxAmount0PerSwap)
	const makerCap1 = limits.schemaVersion === 2 ? BigInt(limits.maxSwapValue1) : BigInt(limits.maxAmount1PerSwap)
	let maxAmount0PerSwap = clampU128(min(providerCap0, makerCap0))
	let maxAmount1PerSwap = clampU128(min(providerCap1, makerCap1))

	// ── 3. Inventory caps: Maker's budget/share translated at the current price,
	//       then intersected with the Provider's own inventory ceilings ──
	const makerPost0 = makerToken0Ceiling(limits, market)
	const makerPost1 = BigInt(limits.maxBudget1)
	const providerPost0 = BigInt(strategy.inventory.maxBalance0)
	const providerPost1 = BigInt(strategy.inventory.maxBalance1)
	let maxPostBalance0 = clampU128(min(providerPost0, makerPost0))
	let maxPostBalance1 = clampU128(min(providerPost1, makerPost1))

	const binding: DecisionTrace['binding'] = {
		maxAmount0PerSwap: whoBinds(providerCap0, makerCap0),
		maxAmount1PerSwap: whoBinds(providerCap1, makerCap1),
		maxPostBalance0: whoBinds(providerPost0, makerPost0),
		maxPostBalance1: whoBinds(providerPost1, makerPost1),
	}

	// ── 4. Directions ──
	// Taker 0→1 (bit 1): Maker receives token0 → needs room under maxPostBalance0.
	// Taker 1→0 (bit 2): Maker receives token1 → needs room under maxPostBalance1.
	let allowedDirections = 0
	let pausedReason: DecisionTrace['pausedReason'] = null

	if (!rule) {
		pausedReason = 'no-rule-matched'
	} else if (!rule.allowMakerBuyToken0 && !rule.allowMakerSellToken0) {
		pausedReason = 'rule-disallows-both-directions'
	} else if (maxAmount0PerSwap === 0n || maxAmount1PerSwap === 0n) {
		// Guard: both amount caps apply to both directions and must be positive
		// for an enabled direction — a zero cap on either token disables everything.
		pausedReason = 'per-swap-cap-zero'
	} else {
		if (rule.allowMakerBuyToken0 && balance0 < maxPostBalance0) allowedDirections |= DIRECTION_TAKER_0_TO_1
		if (rule.allowMakerSellToken0 && balance1 < maxPostBalance1) allowedDirections |= DIRECTION_TAKER_1_TO_0
		if (allowedDirections === 0) pausedReason = 'inventory-exhausted-both-directions'
	}

	// Paused reports carry zero caps: nothing to enforce, nothing extra to reveal.
	if (allowedDirections === 0) {
		maxAmount0PerSwap = 0n
		maxAmount1PerSwap = 0n
		maxPostBalance0 = 0n
		maxPostBalance1 = 0n
	}

	// ── 5. Validity window: the shortest of rule TTL, Maker TTL, Guard maximum ──
	const ttlSec = Math.min(rule?.ttlSec ?? MAX_REPORT_LIFETIME_SEC, limits.maxTtlSec, MAX_REPORT_LIFETIME_SEC)
	const validAfter = nowSec
	const validUntil = nowSec + ttlSec

	const report: GuardReportV1 = {
		schemaVersion: 1,
		chainId: identity.chainId,
		guard: identity.guard,
		router: identity.router,
		maker: identity.maker,
		strategyHash: identity.strategyHash,
		token0: identity.token0,
		token1: identity.token1,
		nonce,
		validAfter,
		validUntil,
		allowedDirections,
		maxAmount0PerSwap,
		maxAmount1PerSwap,
		maxPostBalance0,
		maxPostBalance1,
	}

	return {
		report,
		trace: { matchedRuleId: rule?.id ?? null, pausedReason, binding },
	}
}
