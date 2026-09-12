import { compile, type Compiled } from './compile.ts'
import { compileGuarded, compileGuardedV2, type GuardCaps } from './guard.ts'
import type { AquaStrategyParams } from './types.ts'

/** Durable JSON explicitly carries the address, envelope version and immutable caps. */
export function compileExecution(p: AquaStrategyParams): Compiled {
  if ('executionTemplate' in p) throw new Error('compiled markers are not reconstructible; use an explicit guard recipe')
  if (!('guard' in p)) return compile(p)
  const { guard, ...plain } = p
  if (!guard || (guard.version !== 1 && guard.version !== 2)) throw new Error('invalid guard recipe')
  const caps = Object.fromEntries(Object.entries(guard.caps).map(([k, v]) => [k, BigInt(v)])) as unknown as GuardCaps
  const s = guard.version === 2 ? compileGuardedV2(plain, guard.address, caps) : compileGuarded(plain, guard.address, caps)
  return { ...s, params: p }
}
