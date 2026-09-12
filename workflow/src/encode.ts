/**
 * ABI encoding of `GuardReportV1`, byte-for-byte compatible with
 * `contracts/aqua-executor/src/guard.ts` (`encodeGuardReport`) and the shared
 * fixture `docs/guard-report-v1/example.json`. Verified by `encode.test.ts`.
 */
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import type { GuardReportV1 } from './types'

/** Mirrors docs/guard-report-v1/abi.json exactly (order matters). */
export const guardReportV1Abi = [
	{
		name: 'report',
		type: 'tuple',
		components: [
			{ name: 'schemaVersion', type: 'uint16' },
			{ name: 'chainId', type: 'uint256' },
			{ name: 'guard', type: 'address' },
			{ name: 'router', type: 'address' },
			{ name: 'maker', type: 'address' },
			{ name: 'strategyHash', type: 'bytes32' },
			{ name: 'token0', type: 'address' },
			{ name: 'token1', type: 'address' },
			{ name: 'nonce', type: 'uint64' },
			{ name: 'validAfter', type: 'uint48' },
			{ name: 'validUntil', type: 'uint48' },
			{ name: 'allowedDirections', type: 'uint8' },
			{ name: 'maxAmount0PerSwap', type: 'uint128' },
			{ name: 'maxAmount1PerSwap', type: 'uint128' },
			{ name: 'maxPostBalance0', type: 'uint128' },
			{ name: 'maxPostBalance1', type: 'uint128' },
		],
	},
] as const

export const GUARD_REPORT_V1_BYTE_LENGTH = 512

export function encodeGuardReportV1(report: GuardReportV1): Hex {
	return encodeAbiParameters(guardReportV1Abi, [
		{
			schemaVersion: report.schemaVersion,
			chainId: report.chainId,
			guard: report.guard,
			router: report.router,
			maker: report.maker,
			strategyHash: report.strategyHash,
			token0: report.token0,
			token1: report.token1,
			nonce: report.nonce,
			validAfter: report.validAfter,
			validUntil: report.validUntil,
			allowedDirections: report.allowedDirections,
			maxAmount0PerSwap: report.maxAmount0PerSwap,
			maxAmount1PerSwap: report.maxAmount1PerSwap,
			maxPostBalance0: report.maxPostBalance0,
			maxPostBalance1: report.maxPostBalance1,
		},
	])
}

/** keccak256 of the encoded tuple — matches `reportHash` in the shared fixture. */
export function guardReportV1Hash(report: GuardReportV1): Hex {
	return keccak256(encodeGuardReportV1(report))
}

/** JSON-friendly view (bigint → decimal string) for logs and fixtures. */
export function guardReportV1ToJson(report: GuardReportV1): Record<string, string> {
	return {
		schemaVersion: String(report.schemaVersion),
		chainId: report.chainId.toString(),
		guard: report.guard,
		router: report.router,
		maker: report.maker,
		strategyHash: report.strategyHash,
		token0: report.token0,
		token1: report.token1,
		nonce: report.nonce.toString(),
		validAfter: String(report.validAfter),
		validUntil: String(report.validUntil),
		allowedDirections: String(report.allowedDirections),
		maxAmount0PerSwap: report.maxAmount0PerSwap.toString(),
		maxAmount1PerSwap: report.maxAmount1PerSwap.toString(),
		maxPostBalance0: report.maxPostBalance0.toString(),
		maxPostBalance1: report.maxPostBalance1.toString(),
	}
}
