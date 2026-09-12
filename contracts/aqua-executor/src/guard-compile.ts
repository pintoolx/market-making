import { createRequire } from 'node:module'
import { concatHex, encodePacked, getAddress, keccak256, zeroAddress } from 'viem'
import { appendCurve } from './curves.ts'
import { compile, type Compiled } from './compile.ts'
import type { AquaStrategyParams, Hex } from './types.ts'

// This module compiles public inputs only: no contract artifact loading, wallet context or environment access.
const S = createRequire(import.meta.url)('@1inch/swap-vm-sdk')

export interface GuardCaps {
  maxAmount0PerSwap: bigint
  maxAmount1PerSwap: bigint
  maxPostBalance0: bigint
  maxPostBalance1: bigint
}
export type GuardedCompiled = Compiled & {
  params: AquaStrategyParams & { executionTemplate: 'guarded-xyc-v1' | 'guarded-pegged-v1' | `guarded-${AquaStrategyParams['program']['kind']}-v2` }
  guard: Hex
  envelope: Hex
}
/** Fixed straight-line program. A report cannot authorize arbitrary replacement bytecode. */
export function compileGuarded(p: AquaStrategyParams, guard: Hex, caps: GuardCaps): GuardedCompiled {
  return guarded(p, guard, caps, 1)
}

/** Requires AquaGuardV2; a v1 address rejects the version-2 envelope. */
export function compileGuardedV2(p: AquaStrategyParams, guard: Hex, caps: GuardCaps): GuardedCompiled {
  return guarded(p, guard, caps, 2)
}

function guarded(p: AquaStrategyParams, guard: Hex, caps: GuardCaps, version: 1 | 2): GuardedCompiled {
  if (p.program.kind === 'concentrated' && version !== 2) throw new Error('concentrated liquidity requires Guard v2 real inventory accounting')
  const base = compile(p)
  if (p.program.feeBps !== 0) throw new Error('guarded recipes require zero fee: gross-input accounting is not implemented')
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
  return { ...base, params: { ...p, executionTemplate: version === 2 ? `guarded-${p.program.kind}-v2` : p.program.kind === 'xyc' ? 'guarded-xyc-v1' : 'guarded-pegged-v1' }, order: order.build(), strategy, strategyHash: keccak256(strategy), guard, envelope }
}

