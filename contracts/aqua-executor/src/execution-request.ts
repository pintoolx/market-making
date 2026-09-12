import { isAddress, keccak256, stringToHex } from 'viem'
import { compileExecution } from './execution-compile.ts'
import { validatePolicy, type RiskPolicy } from './risk.ts'
import type { AquaStrategyParams, Hex } from './types.ts'

interface Envelope {
  schema: 'aqua-execution-v1'
  requestId: string
  sessionId: string
}
export type ExecutionRequest = Envelope & (
  | { action: 'ship'; strategy: AquaStrategyParams; policy: RiskPolicy }
  | { action: 'rebalance'; expectedStrategyHash: Hex; strategy: AquaStrategyParams }
  | { action: 'swap'; expectedStrategyHash: Hex; tokenIn: Hex; amountIn: string; slippageBps: number }
  | { action: 'monitor'; expectedStrategyHash: Hex }
  | { action: 'dock'; expectedStrategyHash: Hex; revokeAllowances?: boolean }
)

const object = (v: unknown, name: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object`)
  return v as Record<string, unknown>
}
const keys = (v: Record<string, unknown>, allowed: string[]) => {
  const bad = Object.keys(v).filter(k => !allowed.includes(k))
  if (bad.length) throw new Error(`unknown fields: ${bad.join(', ')}`)
}
const integer = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`invalid ${name}`)
  return v
}
const decimal = (v: unknown, name: string, min: bigint, max: bigint): string => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 78 || BigInt(v) < min || BigInt(v) > max) throw new Error(`invalid ${name}: use a canonical decimal string`)
  return v
}
const address = (v: unknown, name: string): Hex => {
  if (typeof v !== 'string' || !isAddress(v, { strict: false }) || /^0x0{40}$/i.test(v)) throw new Error(`invalid ${name}`)
  return v.toLowerCase() as Hex
}
export const executionId = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v)) throw new Error('IDs must be 1–96 letters, digits, dots, underscores or hyphens, starting with a letter or digit')
  return v
}

/** Validate untrusted JSON before any signing. Freshness is checked later only for new transactions. */
export function parseStrategy(input: unknown): AquaStrategyParams {
  const p = object(input, 'strategy')
  keys(p, ['schema', 'chainId', 'maker', 'tokens', 'amounts', 'program', 'meta', 'guard'])
  if (p.schema !== 'aqua-swapvm-v1.0.2') throw new Error('unsupported strategy schema')
  if (!Array.isArray(p.tokens) || p.tokens.length !== 2 || !Array.isArray(p.amounts) || p.amounts.length !== 2) throw new Error('strategy needs two tokens and amounts')
  const program = object(p.program, 'program'), meta = object(p.meta, 'meta')
  const extra = program.kind === 'pegged' ? ['linearWidth', 'referenceBalances', 'rates'] : program.kind === 'concentrated' ? ['sqrtPriceMin', 'sqrtPriceMax'] : []
  keys(program, ['kind', 'feeBps', 'deadline', 'salt', ...extra])
  keys(meta, ['producer', 'strategyVersion', 'paramsRevision'])
  if (program.kind !== 'xyc' && program.kind !== 'pegged' && program.kind !== 'concentrated') throw new Error('unsupported strategy kind')
  const pair = (v: unknown, name: string): [string, string] => {
    if (!Array.isArray(v) || v.length !== 2) throw new Error(`invalid ${name}`)
    return v.map(n => decimal(n, name, 1n, 2n ** 256n - 1n)) as [string, string]
  }
  const curve = program.kind === 'xyc' ? { kind: 'xyc' as const } : program.kind === 'concentrated' ? { kind: 'concentrated' as const,
    sqrtPriceMin: decimal(program.sqrtPriceMin, 'sqrtPriceMin', 1n, 2n ** 256n - 1n), sqrtPriceMax: decimal(program.sqrtPriceMax, 'sqrtPriceMax', 1n, 2n ** 256n - 1n) } : { kind: 'pegged' as const,
    linearWidth: decimal(program.linearWidth, 'linearWidth', 0n, 5000n * 10n ** 27n),
    referenceBalances: pair(program.referenceBalances, 'referenceBalances'), rates: pair(program.rates, 'rates') }
  if (meta.producer !== 'tee' && meta.producer !== 'fixed-params') throw new Error('invalid strategy producer')
  const result: AquaStrategyParams = {
    schema: p.schema, chainId: integer(p.chainId, 'chainId', 1, Number.MAX_SAFE_INTEGER), maker: address(p.maker, 'maker'),
    tokens: p.tokens.map(t => address(t, 'token')), amounts: p.amounts.map(a => decimal(a, 'amount', 1n, 2n ** 256n - 1n)),
    program: { ...curve, feeBps: integer(program.feeBps, 'feeBps', 0, 9999), deadline: integer(program.deadline, 'deadline', 1, 2 ** 40 - 1), salt: decimal(program.salt, 'salt', 0n, 2n ** 64n - 1n) },
    meta: { producer: meta.producer, strategyVersion: integer(meta.strategyVersion, 'strategyVersion', 1, Number.MAX_SAFE_INTEGER), paramsRevision: integer(meta.paramsRevision, 'paramsRevision', 1, Number.MAX_SAFE_INTEGER) },
  }
  if ('guard' in p) {
    const g = object(p.guard, 'guard'); keys(g, ['address', 'version', 'caps'])
    const c = object(g.caps, 'guard caps'); keys(c, ['maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1'])
    result.guard = { address: address(g.address, 'guard address'), version: integer(g.version, 'guard version', 1, 2) as 1 | 2,
      caps: { maxAmount0PerSwap: decimal(c.maxAmount0PerSwap, 'maxAmount0PerSwap', 1n, (1n << 128n) - 1n),
        maxAmount1PerSwap: decimal(c.maxAmount1PerSwap, 'maxAmount1PerSwap', 1n, (1n << 128n) - 1n),
        maxPostBalance0: decimal(c.maxPostBalance0, 'maxPostBalance0', 1n, (1n << 128n) - 1n),
        maxPostBalance1: decimal(c.maxPostBalance1, 'maxPostBalance1', 1n, (1n << 128n) - 1n) } }
  }
  compileExecution(result)
  return result
}

export function parseExecutionRequest(input: unknown): ExecutionRequest {
  const r = object(input, 'request')
  if (r.schema !== 'aqua-execution-v1') throw new Error('unsupported execution schema')
  const base = { schema: r.schema, requestId: executionId(r.requestId), sessionId: executionId(r.sessionId) } as const
  const common = ['schema', 'requestId', 'sessionId', 'action']
  if (r.action === 'ship') {
    keys(r, [...common, 'strategy', 'policy'])
    const strategy = parseStrategy(r.strategy), p = object(r.policy, 'policy')
    keys(p, ['tokens', 'baselineAmounts', 'maxDrawdownBps', 'maxPriceAgeSec'])
    if (!Array.isArray(p.tokens) || !Array.isArray(p.baselineAmounts)) throw new Error('invalid risk policy arrays')
    const policy: RiskPolicy = {
      tokens: p.tokens.map(t => address(t, 'policy token')), baselineAmounts: p.baselineAmounts.map(a => decimal(a, 'baseline amount', 1n, 2n ** 256n - 1n)),
      maxDrawdownBps: integer(p.maxDrawdownBps, 'maxDrawdownBps', 1, 10000), maxPriceAgeSec: integer(p.maxPriceAgeSec, 'maxPriceAgeSec', 1, Number.MAX_SAFE_INTEGER),
    }
    validatePolicy(policy)
    if (canonical(policy.tokens) !== canonical(strategy.tokens) || canonical(policy.baselineAmounts) !== canonical(strategy.amounts)) throw new Error('ship policy must use the original strategy tokens and funded amounts')
    return { ...base, action: 'ship', strategy, policy }
  }
  if (typeof r.expectedStrategyHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(r.expectedStrategyHash)) throw new Error('expectedStrategyHash is required')
  const expectedStrategyHash = r.expectedStrategyHash.toLowerCase() as Hex
  if (r.action === 'rebalance') {
    keys(r, [...common, 'expectedStrategyHash', 'strategy'])
    return { ...base, action: 'rebalance', expectedStrategyHash, strategy: parseStrategy(r.strategy) }
  }
  if (r.action === 'swap') {
    keys(r, [...common, 'expectedStrategyHash', 'tokenIn', 'amountIn', 'slippageBps'])
    return { ...base, action: 'swap', expectedStrategyHash, tokenIn: address(r.tokenIn, 'tokenIn'), amountIn: decimal(r.amountIn, 'amountIn', 1n, 2n ** 256n - 1n), slippageBps: integer(r.slippageBps, 'slippageBps', 0, 9999) }
  }
  if (r.action === 'monitor') {
    keys(r, [...common, 'expectedStrategyHash'])
    return { ...base, action: 'monitor', expectedStrategyHash }
  }
  if (r.action === 'dock') {
    keys(r, [...common, 'expectedStrategyHash', 'revokeAllowances'])
    if (r.revokeAllowances !== undefined && typeof r.revokeAllowances !== 'boolean') throw new Error('revokeAllowances must be boolean')
    return { ...base, action: 'dock', expectedStrategyHash, revokeAllowances: r.revokeAllowances ?? false }
  }
  throw new Error('action must be ship, rebalance, swap, monitor or dock')
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export const requestDigest = (r: ExecutionRequest) => keccak256(stringToHex(canonical(r)))
