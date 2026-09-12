import { randomUUID } from 'node:crypto'
import { erc20Abi } from 'viem'
import { concentrationBounds, priceE18 } from './concentrated.ts'
import type { Ctx } from './config.ts'
import { compileExecution } from './execution-compile.ts'
import { executeRequest, executionStatus, type ControllerOptions, type ExecutionSession } from './execution-controller.ts'
import { canonical, executionId, parseExecutionRequest, type ExecutionRequest } from './execution-request.ts'
import { ExecutionStore } from './execution-store.ts'
import { rawBalances } from './executor.ts'
import { monitorRead } from './monitor.ts'
import { evaluateRisk, MonitorDataError } from './risk.ts'
import type { AquaStrategyParams, Deployment } from './types.ts'

export interface AutopilotPolicy {
  schema: 'aqua-autopilot-v1'
  /** Human token1/token0 hard bounds; no recenter outside this band. */
  minPrice: string
  maxPrice: string
  rangeWidthBps: number
  triggerBps: number
  cooldownSec: number
  ttlSec: number
  maxRebalances: number
  feeBps: number
  highMovementFeeBps: number
  movementThresholdBps: number
}
interface Pending {
  request: ExecutionRequest
  anchorPriceE18: string
}
interface AutoState {
  policy: AutopilotPolicy
  rebalances: number
  lastAt: number
  anchorPriceE18?: string
  pending?: Pending
  halted?: string
}
export function parseAutopilotPolicy(input: unknown): AutopilotPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid autopilot policy')
  const p = input as Record<string, unknown>
  const names = ['schema', 'minPrice', 'maxPrice', 'rangeWidthBps', 'triggerBps', 'cooldownSec', 'ttlSec', 'maxRebalances', 'feeBps', 'highMovementFeeBps', 'movementThresholdBps']
  if (Object.keys(p).some(k => !names.includes(k)) || p.schema !== 'aqua-autopilot-v1') throw new Error('invalid autopilot schema or fields')
  const n = (name: string, min: number, max: number) => {
    const v = p[name]; if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`invalid ${name}`)
    return v
  }
  const min = priceE18(p.minPrice as string), max = priceE18(p.maxPrice as string)
  if (min >= max) throw new Error('invalid autopilot price bounds')
  const result: AutopilotPolicy = { schema: p.schema, minPrice: p.minPrice as string, maxPrice: p.maxPrice as string,
    rangeWidthBps: n('rangeWidthBps', 1, 9000), triggerBps: n('triggerBps', 1, 10000), cooldownSec: n('cooldownSec', 1, 86400),
    ttlSec: n('ttlSec', 60, 86400), maxRebalances: n('maxRebalances', 1, 1000), feeBps: n('feeBps', 0, 9999),
    highMovementFeeBps: n('highMovementFeeBps', 0, 9999), movementThresholdBps: n('movementThresholdBps', 1, 10000) }
  if (result.highMovementFeeBps < result.feeBps) throw new Error('high movement fee must be >= base fee')
  return result
}
const displayPrice = (n: bigint) => `${n / 10n ** 18n}.${(n % 10n ** 18n).toString().padStart(18, '0')}`
const abs = (n: bigint) => n < 0n ? -n : n

/** Pure proposal. Replaces only expired programs so inventory is frozen before its snapshot. */
export function proposeRollover(p: AquaStrategyParams, balances: bigint[], decimals: number[], price: bigint, now: number,
  policy: AutopilotPolicy, state: Pick<AutoState, 'rebalances' | 'lastAt' | 'anchorPriceE18'>) {
  if (p.program.kind !== 'concentrated') throw new Error('autopilot requires concentrated liquidity')
  if (p.guard && (policy.feeBps !== 0 || policy.highMovementFeeBps !== 0)) throw new Error('guarded autopilot requires zero fees')
  if (state.rebalances >= policy.maxRebalances) return { action: 'hold' as const, reason: 'rebalance-budget-exhausted' }
  if (price < priceE18(policy.minPrice) || price > priceE18(policy.maxPrice)) return { action: 'hold' as const, reason: 'price-outside-policy' }
  if (now <= p.program.deadline) return { action: 'hold' as const, reason: 'waiting-for-expiry' }
  if (now < state.lastAt + policy.cooldownSec) return { action: 'hold' as const, reason: 'cooldown' }
  if (balances.length !== 2 || balances.some(n => n <= 0n)) return { action: 'hold' as const, reason: 'one-sided-inventory' }
  const anchor = state.anchorPriceE18 ? BigInt(state.anchorPriceE18) : price
  const movement = abs(price - anchor) * 10000n / anchor
  const permitted = concentrationBounds(p.tokens, decimals, policy.minPrice, policy.maxPrice)
  const outsideBounds = BigInt(p.program.sqrtPriceMin) < BigInt(permitted.sqrtPriceMin) || BigInt(p.program.sqrtPriceMax) > BigInt(permitted.sqrtPriceMax)
  const recenter = !state.anchorPriceE18 || movement >= BigInt(policy.triggerBps) || outsideBounds
  let bounds = { sqrtPriceMin: p.program.sqrtPriceMin, sqrtPriceMax: p.program.sqrtPriceMax }
  if (recenter) {
    const low = price * BigInt(10000 - policy.rangeWidthBps) / 10000n, high = price * BigInt(10000 + policy.rangeWidthBps) / 10000n
    const floor = priceE18(policy.minPrice), ceiling = priceE18(policy.maxPrice)
    bounds = concentrationBounds(p.tokens, decimals, displayPrice(low < floor ? floor : low), displayPrice(high > ceiling ? ceiling : high))
  }
  const strategy: AquaStrategyParams = { ...p, amounts: balances.map(String), program: { ...p.program, ...bounds,
    salt: String(BigInt(p.program.salt) + 1n), deadline: now + policy.ttlSec,
    feeBps: movement >= BigInt(policy.movementThresholdBps) ? policy.highMovementFeeBps : policy.feeBps },
    meta: { ...p.meta, producer: 'fixed-params', paramsRevision: p.meta.paramsRevision + 1 } }
  // Validates the entire future order, including uint64 salt, cap limits and exact guard recipe.
  parseExecutionRequest({ schema: 'aqua-execution-v1', sessionId: 'preview', requestId: 'preview', action: 'rebalance',
    expectedStrategyHash: compileExecution(p).strategyHash, strategy })
  return { action: 'rebalance' as const, reason: recenter ? 'recenter-after-expiry' : 'renew-after-expiry', strategy,
    anchorPriceE18: String(recenter ? price : anchor), movementBps: String(movement), reportRequired: !!strategy.guard }
}

/** One read/decision, or one durable action with explicit execute=true. Never issues a Guard report. */
export async function autopilotTick(ctx: Ctx, d: Deployment, sessionId: string, input: unknown,
  options: ControllerOptions & { execute?: boolean }) {
  executionId(sessionId)
  const policy = parseAutopilotPolicy(input)
  const status = await executionStatus(ctx, d, options.stateDir, sessionId)
  const active = status.session.plan.rebalances?.at(-1)?.strategy ?? status.session.plan.strategy
  if (active.program.kind !== 'concentrated') throw new Error('autopilot requires concentrated liquidity')
  if (active.guard && (policy.feeBps !== 0 || policy.highMovementFeeBps !== 0)) throw new Error('guarded autopilot requires zero fees')
  let state: AutoState
  const load = new ExecutionStore(options.stateDir)
  try {
    state = load.get<AutoState>('autopilot', sessionId) ?? { policy, rebalances: 0, lastAt: 0 }
    if (canonical(state.policy) !== canonical(policy)) throw new Error('autopilot policy is bound to this session; use its saved policy')
    if (options.execute && !load.get('autopilot', sessionId)) load.put('autopilot', sessionId, state)
    const pending = load.all<{ request: ExecutionRequest; status: string }>('requests').find(r => r.status === 'pending')
    if (pending && pending.request.requestId !== state.pending?.request.requestId) return { action: 'hold', reason: 'executor-request-pending', requestId: pending.request.requestId }
  } finally { load.close() }
  const finishPending = async () => {
    const pending = state.pending!
    if (!options.execute) return { action: 'resume', dryRun: true, request: pending.request }
    const result = await executeRequest(ctx, d, pending.request, options)
    let minedAt: number | undefined
    if (result.outcome === 'rebalanced') {
      const primary = result.transactions.find(tx => tx.step === 'primary' && tx.status === 'success')
      if (!primary) throw new Error('completed rollover is missing its successful transaction')
      const block = await monitorRead(() => ctx.pc.getBlock({ blockNumber: BigInt(primary.blockNumber) }))
      minedAt = Number(block.timestamp)
    }
    const store = new ExecutionStore(options.stateDir)
    try {
      const saved = store.get<AutoState>('autopilot', sessionId)!
      if (saved.pending?.request.requestId === pending.request.requestId) {
        if (result.status === 'failed') saved.halted = result.outcome
        if (result.outcome === 'rebalanced') {
          saved.rebalances++; saved.lastAt = minedAt!
          saved.anchorPriceE18 = pending.anchorPriceE18
        }
        delete saved.pending; store.put('autopilot', sessionId, saved)
      }
    } finally { store.close() }
    return { action: pending.request.action, dryRun: false, result, reportRequired: result.outcome === 'rebalanced' && pending.request.action === 'rebalance' && !!pending.request.strategy.guard }
  }
  if (state.pending) return finishPending()
  if (status.session.status !== 'active') return { action: 'hold', reason: 'session-not-active' }
  const p = status.session.plan.rebalances?.at(-1)?.strategy ?? status.session.plan.strategy
  const s = compileExecution(p)
  const block = await monitorRead(() => ctx.pc.getBlock({ blockTag: 'latest' }))
  const [raw, decimals] = await monitorRead(() => Promise.all([rawBalances(ctx, d, s, block.number),
    Promise.all(s.tokens.map(address => ctx.pc.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber: block.number })))]))
  if (raw.some(b => b.tokensCount !== 2)) return { action: 'hold', reason: 'inventory-not-active' }
  const prices = await monitorRead(options.getPrices), balances = raw.map(b => b.balance)
  // Reads can cross a second or stall. Validate both snapshots against the clock after all reads.
  const now = Math.floor(Date.now() / 1000)
  if (now - Number(block.timestamp) > 60 || Number(block.timestamp) > now + 5) throw new MonitorDataError('stale or future chain snapshot')
  let risk: ReturnType<typeof evaluateRisk>
  try { risk = evaluateRisk(status.session.plan.policy, balances, decimals, prices, now) }
  catch (e) { throw new MonitorDataError(e instanceof Error ? e.message : 'invalid oracle data') }
  const normalized = Object.fromEntries(Object.entries(prices.usdE8).map(([k, v]) => [k.toLowerCase(), BigInt(v)]))
  const price = normalized[s.tokens[0]!.toLowerCase()]! * 10n ** 18n / normalized[s.tokens[1]!.toLowerCase()]!
  const proposal = risk.breached ? { action: 'dock' as const, reason: 'maximum-loss' }
    : state.halted ? { action: 'hold' as const, reason: `halted: ${state.halted}` }
      : proposeRollover(p, balances, decimals, price, Number(block.timestamp), policy, state)
  const observation = { blockNumber: String(block.number), prices, risk, priceE18: String(price) }
  if (!options.execute || proposal.action === 'hold') return { ...proposal, dryRun: !options.execute, observation }
  // A competing local request could have advanced the session during reads. Bind the intent under the same OS lock.
  const store = new ExecutionStore(options.stateDir)
  try {
    const current = store.get<ExecutionSession>('sessions', sessionId)!
    const latest = current.plan.rebalances?.at(-1)?.strategy ?? current.plan.strategy
    const saved = store.get<AutoState>('autopilot', sessionId)!
    if (saved.pending || current.status !== 'active' || compileExecution(latest).strategyHash !== s.strategyHash ||
      store.all<{ status: string }>('requests').some(r => r.status === 'pending')) return { action: 'hold', reason: 'concurrent-change' }
    const base = { schema: 'aqua-execution-v1' as const, sessionId, requestId: `auto-${randomUUID()}`, expectedStrategyHash: s.strategyHash }
    const request: ExecutionRequest = proposal.action === 'dock' ? { ...base, action: 'dock' } : { ...base, action: 'rebalance', strategy: proposal.strategy }
    saved.pending = { request, anchorPriceE18: proposal.action === 'rebalance' ? proposal.anchorPriceE18 : String(price) }
    state = saved
    store.atomic(() => { store.put('autopilot', sessionId, saved); store.event(request.requestId, { kind: 'autopilot-decision', proposal, observation }) })
  } finally { store.close() }
  return finishPending()
}
