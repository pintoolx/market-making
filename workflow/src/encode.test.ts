import { describe, expect, test } from 'bun:test'
import { encodeGuardReportV1, guardReportV1Hash, GUARD_REPORT_V1_BYTE_LENGTH } from './encode'
import type { GuardReportV1 } from './types'

// Shared fixture owned by the contracts side — if this test breaks, the two
// sides have diverged and docs/GUARD-REPORT-V1.md needs a decision.
// node:fs is deliberately unavailable under the CRE SDK's restricted-node-modules types; use Bun.
const fixturePath = `${import.meta.dir}/../../docs/guard-report-v1/example.json`
const fixture = (await Bun.file(fixturePath).json()) as {
	report: Record<string, string>
	encodedReport: `0x${string}`
	encodedByteLength: number
	reportHash: `0x${string}`
}

const fromFixture = (r: Record<string, string>): GuardReportV1 => ({
	schemaVersion: Number(r.schemaVersion),
	chainId: BigInt(r.chainId),
	guard: r.guard as `0x${string}`,
	router: r.router as `0x${string}`,
	maker: r.maker as `0x${string}`,
	strategyHash: r.strategyHash as `0x${string}`,
	token0: r.token0 as `0x${string}`,
	token1: r.token1 as `0x${string}`,
	nonce: BigInt(r.nonce),
	validAfter: Number(r.validAfter),
	validUntil: Number(r.validUntil),
	allowedDirections: Number(r.allowedDirections),
	maxAmount0PerSwap: BigInt(r.maxAmount0PerSwap),
	maxAmount1PerSwap: BigInt(r.maxAmount1PerSwap),
	maxPostBalance0: BigInt(r.maxPostBalance0),
	maxPostBalance1: BigInt(r.maxPostBalance1),
})

describe('encodeGuardReportV1 (golden against docs/guard-report-v1/example.json)', () => {
	test('encodes byte-for-byte identically to the contracts-side fixture', () => {
		const encoded = encodeGuardReportV1(fromFixture(fixture.report))
		expect(encoded).toBe(fixture.encodedReport)
	})

	test('is exactly 512 bytes (16 words), as AquaGuard requires', () => {
		const encoded = encodeGuardReportV1(fromFixture(fixture.report))
		expect((encoded.length - 2) / 2).toBe(GUARD_REPORT_V1_BYTE_LENGTH)
		expect(fixture.encodedByteLength).toBe(GUARD_REPORT_V1_BYTE_LENGTH)
	})

	test('keccak256 of the encoding matches the fixture reportHash', () => {
		expect(guardReportV1Hash(fromFixture(fixture.report))).toBe(fixture.reportHash)
	})
})
