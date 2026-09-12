/** Deterministic, non-annualized 30-minute realized movement, in basis points.
 * sqrt(sum((close[i] / close[i-1] - 1)^2)); not sample standard deviation.
 * Each rounding is upward so integer arithmetic cannot understate the result.
 * Portable QuickJS/WASM module shared with the local CRE observation scaffold.
 */
export const VOLATILITY_METHOD = 'rss-simple-returns-30m-v1' as const
const SCALE = 1_000_000_000_000n
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d

export function volatilityBps(closes: readonly bigint[]): number {
	if (closes.length !== 31 || closes.some(p => p <= 0n)) throw new Error('Expected 31 positive minute closes')
	let sum = 0n
	for (let i = 1; i < closes.length; i++) {
		const delta = closes[i]! - closes[i - 1]!
		const r = ceilDiv((delta < 0n ? -delta : delta) * SCALE, closes[i - 1]!)
		sum += r * r
	}
	if (sum === 0n) return 0
	let root = sum
	let next = (root + 1n) / 2n
	while (next < root) { root = next; next = (root + sum / root) / 2n }
	if (root * root < sum) root++
	const bps = ceilDiv(root * 10_000n, SCALE)
	if (bps > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Volatility exceeds safe integer range')
	return Number(bps)
}

export function bookMetrics(bid: bigint, ask: bigint) {
	if (bid <= 0n || ask < bid) throw new Error('Invalid or crossed order book')
	const midpoint = (bid + ask) / 2n
	return { midpoint, spreadBps: ceilDiv((ask - bid) * 10_000n, midpoint) }
}
