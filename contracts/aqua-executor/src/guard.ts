import { encodeAbiParameters, encodeFunctionData, type Abi } from 'viem'
import { readJson } from './config.ts'
import type { Hex } from './types.ts'
import type { GuardCaps } from './guard-compile.ts'
export { compileGuarded, compileGuardedV2, type GuardCaps, type GuardedCompiled } from './guard-compile.ts'

export const guardArtifact = readJson('artifacts/AquaGuard.json') as { abi: Abi; bytecode: Hex }
export const guardTestForwarderArtifact = readJson('artifacts/GuardTestForwarder.json') as { abi: Abi; bytecode: Hex }

/** Draft PR #3 wire ABI. Keep fixture and Solidity GuardReportV1 aligned. */
export const guardReportAbi = [{ name: 'report', type: 'tuple', components: [
  { name: 'schemaVersion', type: 'uint16' }, { name: 'chainId', type: 'uint256' },
  { name: 'guard', type: 'address' }, { name: 'router', type: 'address' }, { name: 'maker', type: 'address' },
  { name: 'strategyHash', type: 'bytes32' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
  { name: 'nonce', type: 'uint64' }, { name: 'validAfter', type: 'uint48' }, { name: 'validUntil', type: 'uint48' },
  { name: 'allowedDirections', type: 'uint8' }, { name: 'maxAmount0PerSwap', type: 'uint128' },
  { name: 'maxAmount1PerSwap', type: 'uint128' }, { name: 'maxPostBalance0', type: 'uint128' }, { name: 'maxPostBalance1', type: 'uint128' },
] }] as const

export interface GuardReport extends GuardCaps {
  schemaVersion: number
  chainId: bigint
  guard: Hex
  router: Hex
  maker: Hex
  strategyHash: Hex
  token0: Hex
  token1: Hex
  nonce: bigint
  validAfter: number
  validUntil: number
  allowedDirections: number
}
export const encodeGuardReport = (report: GuardReport): Hex => encodeAbiParameters(guardReportAbi, [report])

/** Unsigned onReport calldata. Submit via the configured forwarder, never directly from an EOA. */
export const buildGuardReportTx = (guard: Hex, metadata: Hex, report: GuardReport) => ({
  to: guard, data: encodeFunctionData({ abi: guardArtifact.abi, functionName: 'onReport', args: [metadata, encodeGuardReport(report)] }),
})

/** Test harness only: neither this caller nor its empty metadata supplies a TEE attestation. */
export const buildTestReportTx = (forwarder: Hex, guard: Hex, report: GuardReport, metadata: Hex = '0x') => ({
  to: forwarder, data: encodeFunctionData({ abi: guardTestForwarderArtifact.abi, functionName: 'forward', args: [guard, metadata, encodeGuardReport(report)] }),
})
