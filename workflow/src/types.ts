/**
 * Shared types for the confidential market-making authorization workflow.
 *
 * Two confidential inputs (Provider strategy, Maker limits) are intersected
 * inside the TEE and reduced to a public `GuardReportV1` — the only thing that
 * ever leaves the enclave. The report format mirrors
 * `docs/GUARD-REPORT-V1.md` / `docs/guard-report-v1/abi.json` field for field.
 *
 * Units: every token amount is an atomic integer (respecting the token's own
 * decimals), carried as a decimal string in JSON and as `bigint` in TypeScript.
 * Prices are "token1 per token0" scaled by PRICE_SCALE (see below).
 */
import { z } from 'zod'

/** Decimal-string integer (atomic token units) — JSON never carries floats. */
const uintString = z.string().regex(/^\d+$/, 'expected a non-negative integer string')

/** Prices are decimal strings like "3000.25"; parsed to bigint × PRICE_SCALE. */
const priceString = z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal price string')

/** Price fixed-point scale: 1e8 keeps sub-cent precision without BigInt overflow risk. */
export const PRICE_SCALE = 100_000_000n

/** Basis points denominator. */
export const BPS = 10_000n

/** Guard enforces `validUntil - validAfter <= 600` (AquaGuard.sol MAX_REPORT_LIFETIME). */
export const MAX_REPORT_LIFETIME_SEC = 600

/**
 * Direction bits — taker perspective, exactly as `GuardReportV1.allowedDirections`:
 *   bit 1 (value 1): taker sends token0, receives token1 → the Maker BUYS token0.
 *   bit 2 (value 2): taker sends token1, receives token0 → the Maker SELLS token0.
 * 0 = paused, 3 = both.
 */
export const DIRECTION_TAKER_0_TO_1 = 1
export const DIRECTION_TAKER_1_TO_0 = 2

// ─── Provider strategy (secret #1) ───────────────────────────
//
// A strategy is an ordered list of rules. The first rule whose `when` clause
// matches the market snapshot wins; if none matches the strategy is paused.
// The Provider never reveals thresholds, rule shape or inventory ceilings.

export const marketConditionSchema = z
	.object({
		/** Inclusive lower bound on mid price (token1 per token0). */
		priceMin: priceString.optional(),
		/** Inclusive upper bound on mid price. */
		priceMax: priceString.optional(),
		/** Inclusive lower bound on realised volatility (bps). */
		volatilityBpsMin: z.number().int().nonnegative().optional(),
		/** Inclusive upper bound on realised volatility (bps). */
		volatilityBpsMax: z.number().int().nonnegative().optional(),
	})
	.strict()

export const strategyRuleSchema = z
	.object({
		id: z.string().min(1),
		when: marketConditionSchema.default({}),
		/** Maker may buy token0 (taker 0→1). */
		allowMakerBuyToken0: z.boolean(),
		/** Maker may sell token0 (taker 1→0). */
		allowMakerSellToken0: z.boolean(),
		/** Per-swap ceiling on token0 exchanged (atomic). */
		maxAmount0PerSwap: uintString,
		/** Per-swap ceiling on token1 exchanged (atomic). */
		maxAmount1PerSwap: uintString,
		/** How long an authorization produced under this rule stays valid. */
		ttlSec: z.number().int().positive().max(MAX_REPORT_LIFETIME_SEC),
	})
	.strict()

export const providerStrategySchema = z
	.object({
		schemaVersion: z.literal(1),
		strategyId: z.string().min(1),
		rules: z.array(strategyRuleSchema).min(1),
		/** Provider's own inventory ceilings (atomic), applied on top of the Maker's. */
		inventory: z
			.object({
				maxBalance0: uintString,
				maxBalance1: uintString,
			})
			.strict(),
	})
	.strict()

export type ProviderStrategy = z.infer<typeof providerStrategySchema>
export type StrategyRule = z.infer<typeof strategyRuleSchema>

// ─── Maker limits (secret #2) ────────────────────────────────
//
// The Maker states risk limits in their own terms; the enclave translates them
// into the Guard's absolute caps at the current price.

export const makerLimitsV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		/** Max total capital deployed, measured in token1 atomic units (e.g. USDC). */
		maxBudget1: uintString,
		/** Max share of that budget that may sit in token0, in bps (6000 = 60 %). */
		maxToken0ShareBps: z.number().int().min(0).max(10_000),
		/** Per-swap ceilings the Maker will tolerate (atomic). */
		maxAmount0PerSwap: uintString,
		maxAmount1PerSwap: uintString,
		/** Maker's own upper bound on authorization lifetime. */
		maxTtlSec: z.number().int().positive().max(MAX_REPORT_LIFETIME_SEC),
	})
	.strict()

/**
 * Browser-facing limits keep every value in token1 terms. The TEE converts
 * value ceilings to token0 amounts using the same market snapshot as the
 * Provider-rule evaluation, so no ordinary server has to infer WETH units.
 */
export const makerLimitsV2Schema = z
	.object({
		schemaVersion: z.literal(2),
		maxBudget1: uintString,
		maxToken0ShareBps: z.number().int().min(0).max(10_000),
		maxToken0Value1: uintString,
		maxSwapValue1: uintString,
		maxTtlSec: z.number().int().positive().max(MAX_REPORT_LIFETIME_SEC),
	})
	.strict()

/** Explicit standing consent; legacy envelopes keep their original bounded TTL. */
export const makerLimitsV3Schema = makerLimitsV2Schema.omit({ maxTtlSec: true }).extend({
    schemaVersion: z.literal(3),
    authorization: z.literal('until-changed'),
}).strict()

export const makerLimitsSchema = z.discriminatedUnion('schemaVersion', [makerLimitsV1Schema, makerLimitsV2Schema, makerLimitsV3Schema])

export type MakerLimitsV1 = z.infer<typeof makerLimitsV1Schema>
export type MakerLimitsV2 = z.infer<typeof makerLimitsV2Schema>
export type MakerLimits = z.infer<typeof makerLimitsSchema>

// ─── Market snapshot (non-secret observation) ───────────────

export const marketSnapshotSchema = z
	.object({
		/** Mid price, token1 per token0, decimal string (e.g. "3000.25"). */
		midPrice: priceString,
		/** Realised volatility in bps over the lookback window. */
		volatilityBps: z.number().int().nonnegative(),
		/** Maker's current token0 balance (atomic). */
		balance0: uintString,
		/** Maker's current token1 balance (atomic). */
		balance1: uintString,
		/** Decimals of token0 / token1 — needed to convert value ⇄ atomic units. */
		decimals0: z.number().int().min(0).max(36),
		decimals1: z.number().int().min(0).max(36),
	})
	.strict()

export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>

// ─── Identity of the report (public constants, not secrets) ─

export type ReportIdentity = {
	chainId: bigint
	guard: `0x${string}`
	router: `0x${string}`
	maker: `0x${string}`
	strategyHash: `0x${string}`
	token0: `0x${string}`
	token1: `0x${string}`
}

// ─── Output: GuardReportV1 (the only thing that leaves the TEE) ─

export type GuardReportV1 = {
	schemaVersion: number // uint16: 1 = bounded, 2 = standing
	chainId: bigint // uint256
	guard: `0x${string}`
	router: `0x${string}`
	maker: `0x${string}`
	strategyHash: `0x${string}` // bytes32
	token0: `0x${string}`
	token1: `0x${string}`
	nonce: bigint // uint64, strictly increasing per (maker, strategyHash)
	validAfter: number // uint48, unix seconds
	validUntil: number // uint48, unix seconds
	allowedDirections: number // uint8 bitmask, see DIRECTION_*
	maxAmount0PerSwap: bigint // uint128
	maxAmount1PerSwap: bigint // uint128
	maxPostBalance0: bigint // uint128
	maxPostBalance1: bigint // uint128
}

/** Why the enclave decided what it decided. Never leaves the TEE. */
export type DecisionTrace = {
	matchedRuleId: string | null
	pausedReason:
		| null
		| 'no-rule-matched'
		| 'rule-disallows-both-directions'
		| 'per-swap-cap-zero'
		| 'inventory-exhausted-both-directions'
	/** Which side's number won each cap (for the demo narrative only). */
	binding: {
		maxAmount0PerSwap: 'provider' | 'maker' | 'equal'
		maxAmount1PerSwap: 'provider' | 'maker' | 'equal'
		maxPostBalance0: 'provider' | 'maker' | 'equal'
		maxPostBalance1: 'provider' | 'maker' | 'equal'
	}
}

export type Authorization = {
	report: GuardReportV1
	trace: DecisionTrace
}

// ─── Helpers ─────────────────────────────────────────────────

/** "3000.25" → 300025000000n (× PRICE_SCALE). Truncates beyond 8 decimals. */
export function parsePrice(price: string): bigint {
	const [whole, frac = ''] = price.split('.')
	const fracPadded = (frac + '00000000').slice(0, 8)
	return BigInt(whole) * PRICE_SCALE + BigInt(fracPadded)
}

export const UINT128_MAX = (1n << 128n) - 1n
export const UINT64_MAX = (1n << 64n) - 1n
export const UINT48_MAX = (1n << 48n) - 1n
