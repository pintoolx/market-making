import { createRequire } from 'node:module'
import { concatHex, encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, keccak256, zeroAddress, type Abi } from 'viem'
import { appendCurve } from './curves.ts'
import { compile, type Compiled } from './compile.ts'
import { readJson } from './config.ts'
import type { AquaStrategyParams, Hex } from './types.ts'

const S = createRequire(import.meta.url)('@1inch/swap-vm-sdk')
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

export interface GuardCaps {
  maxAmount0PerSwap: bigint
  maxAmount1PerSwap: bigint
  maxPostBalance0: bigint
  maxPostBalance1: bigint
}
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
export type GuardedCompiled = Compiled & {
  params: AquaStrategyParams & { executionTemplate: 'guarded-xyc-v1' | 'guarded-pegged-v1' | 'guarded-concentrated-v2' }
  guard: Hex
  envelope: Hex
}
export const encodeGuardReport = (report: GuardReport): Hex => encodeAbiParameters(guardReportAbi, [report])

/** Fixed straight-line program. A report cannot authorize arbitrary replacement bytecode. */
export function compileGuarded(p: AquaStrategyParams, guard: Hex, caps: GuardCaps): GuardedCompiled {
  return guarded(p, guard, caps, 1)
}

/** Requires AquaGuardV2; a v1 address rejects the version-2 envelope. */
export function compileGuardedV2(p: AquaStrategyParams, guard: Hex, caps: GuardCaps): GuardedCompiled {
  if (p.program.kind !== 'concentrated') throw new Error('v2 template requires concentrated program')
  return guarded(p, guard, caps, 2)
}

function guarded(p: AquaStrategyParams, guard: Hex, caps: GuardCaps, version: 1 | 2): GuardedCompiled {
  if (p.program.kind === 'concentrated' && version !== 2) throw new Error('concentrated liquidity requires Guard v2 real inventory accounting')
  const base = compile(p)
  if (p.program.feeBps !== 0) throw new Error('guarded v1 requires zero fee: gross-input accounting is not implemented')
  for (const address of [p.maker, ...p.tokens, guard]) {
    if (getAddress(address) === zeroAddress) throw new Error('guarded v1 requires nonzero addresses')
  }
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0 || !Number.isSafeInteger(p.program.deadline) ||
    p.program.deadline <= 0 || p.program.deadline >= 2 ** 40 || !/^(0|[1-9]\d*)$/.test(p.program.salt) ||
    BigInt(p.program.salt) >= 1n << 64n) throw new Error('invalid guarded domain, deadline or salt')
  const limits = [caps.maxAmount0PerSwap, caps.maxAmount1PerSwap, caps.maxPostBalance0, caps.maxPostBalance1] as const
  if (limits.some(n => typeof n !== 'bigint' || n <= 0n || n >= 1n << 128n)) throw new Error('guard caps must be positive uint128')
  if (base.amounts[0]! > caps.maxPostBalance0 || base.amounts[1]! > caps.maxPostBalance1) throw new Error('initial inventory exceeds guard envelope')
  const envelope = encodePacked(['uint8', 'address', 'address', 'uint128', 'uint128', 'uint128', 'uint128'],
    [version, p.tokens[0]!, p.tokens[1]!, ...limits])
  const prefix = appendCurve(new S.AquaProgramBuilder().deadline({ deadline: BigInt(p.program.deadline) }), p)
    .salt({ salt: BigInt(p.program.salt) }).build()
  // SDK 0.4.4's Aqua builder has no Extruction method. Append the pinned router's
  // opcode 32, with 125 argument bytes (target + envelope); golden and real-router tests bind it.
  const program = new S.SwapVmProgram(concatHex([prefix.toString(), '0x207d', guard, envelope]))
  const order = S.Order.new({ maker: new S.Address(p.maker), program, traits: S.MakerTraits.default() })
  const strategy: Hex = order.encode().toString()
  // The legacy JSON parser rejects this marker instead of silently recompiling an unguarded XYC order.
  return { ...base, params: { ...p, executionTemplate: version === 2 ? 'guarded-concentrated-v2' : p.program.kind === 'xyc' ? 'guarded-xyc-v1' : 'guarded-pegged-v1' }, order: order.build(), strategy, strategyHash: keccak256(strategy), guard, envelope }
}

/** Unsigned onReport calldata. Submit via the configured forwarder, never directly from an EOA. */
export const buildGuardReportTx = (guard: Hex, metadata: Hex, report: GuardReport) => ({
  to: guard, data: encodeFunctionData({ abi: guardArtifact.abi, functionName: 'onReport', args: [metadata, encodeGuardReport(report)] }),
})

/** Test harness only: neither this caller nor its empty metadata supplies a TEE attestation. */
export const buildTestReportTx = (forwarder: Hex, guard: Hex, report: GuardReport, metadata: Hex = '0x') => ({
  to: forwarder, data: encodeFunctionData({ abi: guardTestForwarderArtifact.abi, functionName: 'forward', args: [guard, metadata, encodeGuardReport(report)] }),
})
