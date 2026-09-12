import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { erc20Abi } from 'viem'
import { takerTraits, type Compiled } from './compile.ts'
import { compileExecution as compile } from './execution-compile.ts'
import type { Ctx } from './config.ts'
import { durableSender, ExecutionRevertedError, type SavedTransaction, type TransactionHook } from './durable-send.ts'
import { canonical, executionId, parseExecutionRequest, requestDigest, type ExecutionRequest } from './execution-request.ts'
import { ExecutionBusyError, ExecutionStore, json } from './execution-store.ts'
import { buildTx, DOCKED, expectState, quote, rawBalances, shipPreflight } from './executor.ts'
import { monitorOnce, monitorRead, type MonitorPlan } from './monitor.ts'
import { MonitorDataError, type PriceSnapshot } from './risk.ts'
import type { AquaStrategyParams, Deployment, Hex } from './types.ts'

export interface ExecutionSession {
  id: string
  createdBy: string
  status: 'starting' | 'active' | 'closed'
  plan: MonitorPlan
}
export interface ExecutionResult {
  schema: 'aqua-execution-result-v1'
  requestId: string
  sessionId: string
  action: ExecutionRequest['action']
  status: 'completed' | 'failed'
  outcome: string
  strategyHash: Hex
  plan: MonitorPlan
  transactions: { step: string; action: string; hash: Hex; status: string; blockNumber: string }[]
  risk?: unknown
  records: string
}
interface Attempt {
  request: ExecutionRequest
  digest: Hex
  status: 'pending' | 'completed' | 'failed'
  before: MonitorPlan
  beforeStatus: ExecutionSession['status']
  riskStop?: { strategy: AquaStrategyParams; observation: unknown }
  lastRisk?: unknown
  result?: ExecutionResult
}
export interface ControllerOptions {
  stateDir: string
  getPrices: () => Promise<PriceSnapshot>
  signal?: AbortSignal
  /** Fault-injection/telemetry hook. No CLI flag exposes it. */
  onTransaction?: TransactionHook
}
const activeOf = (plan: MonitorPlan) => compile(plan.rebalances?.at(-1)?.strategy ?? plan.strategy)
export class ExecutionConflictError extends Error {}

async function bindContext(ctx: Ctx, d: Deployment, store: ExecutionStore) {
  const [chainId, genesis] = await monitorRead(() => Promise.all([ctx.pc.getChainId(), ctx.pc.getBlock({ blockNumber: 0n })]))
  if (chainId !== ctx.chain.id || chainId !== d.chainId) throw new Error('execution chainId mismatch')
  const context = {
    version: 1, chainId, genesis: genesis.hash, maker: ctx.maker.account.address.toLowerCase(), taker: ctx.taker.account.address.toLowerCase(),
    aqua: d.aqua.toLowerCase(), router: d.router.toLowerCase(), tokens: Object.fromEntries(Object.entries(d.tokens).map(([k, v]) => [k, v.toLowerCase()])),
  }
  const saved = store.get('meta', 'context')
  if (saved && canonical(saved) !== canonical(context)) throw new Error('state directory belongs to a different chain, deployment or signer; do not reuse it')
  if (!saved) store.put('meta', 'context', context)
}
function checkStrategy(ctx: Ctx, d: Deployment, s: Compiled, previous?: Compiled) {
  if (s.params.chainId !== ctx.chain.id || s.params.maker.toLowerCase() !== ctx.maker.account.address.toLowerCase()) throw new Error('strategy chain/maker mismatch')
  const allowed = Object.values(d.tokens).map(t => t.toLowerCase())
  if (s.tokens.some(t => !allowed.includes(t.toLowerCase()))) throw new Error('strategy token is not in this deployment')
  if (previous && (canonical(s.tokens) !== canonical(previous.tokens) || s.strategyHash === previous.strategyHash)) throw new Error('rebalance needs the same token order and a new strategy hash')
}

/** One durable, idempotent request. All processes using these signers must share this state directory. */
export async function executeRequest(ctx: Ctx, d: Deployment, input: unknown, options: ControllerOptions): Promise<ExecutionResult> {
  const request = parseExecutionRequest(input)
  const store = new ExecutionStore(options.stateDir)
  let accepted = false
  try {
    await bindContext(ctx, d, store)
    const digest = requestDigest(request)
    let attempt = store.get<Attempt>('requests', request.requestId)
    if (attempt && attempt.digest !== digest) throw new Error('requestId is already bound to different request content')
    if (!attempt) {
      const pending = store.all<Attempt>('requests').find(r => r.status === 'pending')
      if (pending) throw new ExecutionConflictError(`resume pending request ${pending.request.requestId} before submitting another request`)
      let session = store.get<ExecutionSession>('sessions', request.sessionId)
      if (request.action === 'ship') {
        if (session) throw new Error('sessionId already exists; use its original requestId to resume')
        checkStrategy(ctx, d, compile(request.strategy))
        session = { id: request.sessionId, createdBy: request.requestId, status: 'starting', plan: { strategy: request.strategy, policy: request.policy, rebalances: [], finished: false } }
      } else {
        if (!session) throw new Error('unknown sessionId; submit a ship request first')
        const active = activeOf(session.plan)
        if (request.expectedStrategyHash !== active.strategyHash) throw new ExecutionConflictError('expectedStrategyHash does not match the current strategy')
        if (session.status !== 'active' && request.action !== 'dock' && request.action !== 'monitor') throw new Error('session is not active')
        if (request.action === 'rebalance') checkStrategy(ctx, d, compile(request.strategy), active)
        if (request.action === 'swap' && !active.tokens.includes(request.tokenIn)) throw new Error('swap tokenIn does not belong to the strategy')
      }
      if ((request.action === 'ship' || request.action === 'rebalance') && BigInt(request.strategy.program.deadline) <= (await ctx.pc.getBlock({ blockTag: 'latest' })).timestamp) throw new Error('new strategy deadline has expired')
      attempt = { request, digest, status: 'pending', before: structuredClone(session.plan), beforeStatus: session.status }
      store.atomic(() => { store.put('sessions', session.id, session); store.put('requests', request.requestId, attempt) })
    }
    accepted = true
    const rec = store.recorder(request.requestId, d.chainId, ctx.explorer)
    const sender = durableSender(ctx, store, request.requestId, rec, options.onTransaction, options.signal)
    await sender.audit()
    if (attempt.result) return attempt.result

    const saveAttempt = () => store.put('requests', request.requestId, attempt)
    const session = () => store.get<ExecutionSession>('sessions', request.sessionId)!
    const saveSession = (s: ExecutionSession) => store.put('sessions', s.id, s)
    const closeSession = () => { const s = session(); s.status = 'closed'; s.plan.finished = true; saveSession(s) }
    const finish = (outcome: string, failed = false): ExecutionResult => {
      const s = session()
      const txs = store.all<SavedTransaction>('txs').filter(t => t.requestId === request.requestId)
      const result: ExecutionResult = JSON.parse(json({
        schema: 'aqua-execution-result-v1', requestId: request.requestId, sessionId: request.sessionId,
        action: request.action, status: failed ? 'failed' : 'completed', outcome, strategyHash: activeOf(s.plan).strategyHash,
        plan: s.plan, risk: attempt!.lastRisk, records: rec.file,
        transactions: txs.map(t => ({ step: t.step, action: t.action, hash: t.hash, status: t.receipt?.status ?? 'pending', blockNumber: t.receipt?.blockNumber ?? '' })),
      }))
      attempt!.status = result.status
      attempt!.result = result
      store.atomic(() => {
        saveAttempt()
        rec.write({ kind: 'request-result', ...result })
      })
      return result
    }
    const ensureActive = async (s: Compiled) => {
      const state = await rawBalances(ctx, d, s)
      if (state.some(b => b.tokensCount !== s.tokens.length)) throw new Error('on-chain strategy is not active')
    }
    const fresh = async (s: Compiled) => {
      const block = await ctx.pc.getBlock({ blockTag: 'latest' })
      if (BigInt(s.params.program.deadline) <= block.timestamp) throw new ExecutionRevertedError('strategy deadline has expired; signed transactions will not be changed')
    }
    const approveMaker = async (s: Compiled) => {
      for (const [i, token] of s.tokens.entries()) await sender.send(`maker-approve-${i}`, ctx.maker, 'maker-approve', s.strategyHash, async () => buildTx.approve(token, d.aqua, s.amounts[i]!))
    }
    const settleRisk = async (): Promise<ExecutionResult> => {
      const decision = attempt!.riskStop!, s = compile(decision.strategy)
      // A receipt may exist even though the strategy is already docked. Recover that transaction first.
      if (sender.get('risk-dock') || !(await rawBalances(ctx, d, s)).every(b => b.tokensCount === DOCKED)) {
        await sender.send('risk-dock', ctx.maker, 'risk-dock', s.strategyHash, async () => buildTx.dock(d, s))
      }
      await expectState(ctx, d, s, DOCKED, rec, 'after durable risk dock')
      closeSession()
      return finish('risk-docked')
    }
    const guard = async (s: Compiled): Promise<ExecutionResult | undefined> => {
      const risk = await monitorOnce(ctx, d, s, session().plan.policy, options.getPrices, rec, { dryRun: true, signal: options.signal })
      attempt!.lastRisk = risk
      saveAttempt()
      if (risk.status === 'already-docked') { closeSession(); return finish('already-docked') }
      if (risk.status === 'would-dock') {
        attempt!.riskStop = { strategy: s.params, observation: risk }
        saveAttempt() // Persist the observed breach before preparing a dock; recovery must not reset it.
        return settleRisk()
      }
    }
    try {
      if (attempt.riskStop) return await settleRisk()
      const before = activeOf(attempt.before)
      if (request.action === 'ship') {
        const s = compile(request.strategy)
        if (!sender.get('primary')) {
          await fresh(s)
          if ((await rawBalances(ctx, d, s)).some(b => b.tokensCount !== 0)) throw new Error('strategy already exists on chain without this request receipt; refusing to infer ownership')
        }
        await approveMaker(s)
        await sender.send('primary', ctx.maker, 'ship', s.strategyHash, async () => { await fresh(s); await shipPreflight(ctx, d, s); return buildTx.ship(d, s) })
        await expectState(ctx, d, s, s.tokens.length, rec, 'after durable ship')
        const state = session(); state.status = 'active'; saveSession(state)
        return await guard(s) ?? finish('shipped')
      }
      if (request.action === 'rebalance') {
        const s = compile(request.strategy)
        if (!sender.get('primary')) {
          const stopped = await guard(before); if (stopped) return stopped
          await fresh(s)
        }
        await approveMaker(s)
        const receipt = await sender.send('primary', ctx.maker, 'rebalance', s.strategyHash, async () => {
          await ensureActive(before); await fresh(s); await shipPreflight(ctx, d, s)
          return buildTx.rebalance(d, before, s)
        })
        const state = session(), current = activeOf(state.plan)
        if (current.strategyHash === before.strategyHash) {
          state.plan.rebalances = [...(state.plan.rebalances ?? []), { strategy: s.params, txHash: receipt.transactionHash }]
          saveSession(state)
          rec.write({ kind: 'monitor-follow', from_strategy_hash: before.strategyHash, strategy_hash: s.strategyHash, tx_hash: receipt.transactionHash, policy: state.plan.policy })
        } else if (current.strategyHash !== s.strategyHash || state.plan.rebalances?.at(-1)?.txHash !== receipt.transactionHash) throw new Error('session transition conflicts with the recovered rebalance')
        await expectState(ctx, d, before, DOCKED, rec, 'old strategy after durable rebalance')
        await expectState(ctx, d, s, s.tokens.length, rec, 'new strategy after durable rebalance')
        return await guard(s) ?? finish('rebalanced')
      }
      if (request.action === 'swap') {
        if (!sender.get('primary')) { const stopped = await guard(before); if (stopped) return stopped }
        const tokenOut = before.tokens.find(t => t !== request.tokenIn)!, amountIn = BigInt(request.amountIn)
        await sender.send('taker-approve', ctx.taker, 'taker-approve', before.strategyHash, async () => buildTx.approve(request.tokenIn, d.router, amountIn))
        await sender.send('primary', ctx.taker, 'swap', before.strategyHash, async () => {
          await ensureActive(before); await fresh(before)
          const q = await quote(ctx, d, before, request.tokenIn, tokenOut, amountIn)
          const [balance, allowance, block] = await Promise.all([
            ctx.pc.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'balanceOf', args: [before.params.maker] }),
            ctx.pc.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'allowance', args: [before.params.maker, d.aqua] }),
            ctx.pc.getBlock({ blockTag: 'latest' }),
          ])
          if (balance < q.amountOut || allowance < q.amountOut) throw new Error('maker cannot cover the quoted swap')
          const minOut = q.amountOut * BigInt(10000 - request.slippageBps) / 10000n
          rec.write({ kind: 'swap-quote', strategy_hash: before.strategyHash, quote: q, min_out: minOut })
          return buildTx.swap(d, before, request.tokenIn, tokenOut, amountIn, takerTraits(minOut, block.timestamp + 300n))
        })
        return await guard(before) ?? finish('swapped')
      }
      if (request.action === 'monitor') return await guard(before) ?? finish('within-limit')
      const dockState = await rawBalances(ctx, d, before)
      const neverShipped = attempt.beforeStatus === 'starting' && dockState.every(b => b.tokensCount === 0) && !sender.get('primary')
      if (!neverShipped && (sender.get('primary') || !dockState.every(b => b.tokensCount === DOCKED))) {
        await sender.send('primary', ctx.maker, 'dock', before.strategyHash, async () => buildTx.dock(d, before))
      }
      await expectState(ctx, d, before, neverShipped ? 0 : DOCKED, rec, neverShipped ? 'unshipped session cleanup' : 'after durable dock')
      closeSession()
      if (request.revokeAllowances) for (const [i, token] of before.tokens.entries()) {
        await sender.send(`maker-revoke-${i}`, ctx.maker, 'maker-revoke', before.strategyHash, async () => buildTx.approve(token, d.aqua, 0n))
      }
      return finish(neverShipped ? 'not-shipped' : 'docked')
    } catch (e) {
      if (e instanceof ExecutionRevertedError) return finish(e.message, true)
      // A failed read-only observation has no pending transaction. A watcher can issue a fresh observation later.
      if (request.action === 'monitor' && e instanceof MonitorDataError && !attempt.riskStop && !sender.get('risk-dock')) finish('price-or-chain-data-unavailable', true)
      rec.write({ kind: 'request-interrupted', status: attempt.status, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  } finally {
    try { if (accepted) store.export(request.requestId) } finally { store.close() }
  }
}

/** Inspect persisted sessions/requests without exposing signed bytes or private keys. */
export async function executionStatus(ctx: Ctx, d: Deployment, stateDir: string, sessionId: string) {
  executionId(sessionId)
  const store = new ExecutionStore(stateDir)
  try {
    await bindContext(ctx, d, store)
    const session = store.get<ExecutionSession>('sessions', sessionId)
    if (!session) throw new Error('unknown sessionId')
    const txs = store.all<SavedTransaction>('txs')
    return { session, strategyHash: activeOf(session.plan).strategyHash, requests: store.all<Attempt>('requests').filter(r => r.request.sessionId === sessionId).map(r => ({
      requestId: r.request.requestId, action: r.request.action, status: r.status, result: r.result,
      transactions: txs.filter(t => t.requestId === r.request.requestId).map(t => ({ step: t.step, action: t.action, hash: t.hash, sender: t.sender, nonce: t.nonce, status: t.receipt?.status ?? 'unconfirmed', blockNumber: t.receipt?.blockNumber })),
    })) }
  } finally { store.close() }
}

/** Each poll releases the cross-process lock, letting TEE requests rebalance between checks. */
export async function watchExecution(ctx: Ctx, d: Deployment, sessionId: string, options: ControllerOptions & { intervalMs?: number; maxChecks?: number; onCheck?: (r: ExecutionResult) => void | Promise<void> }) {
  executionId(sessionId)
  const interval = options.intervalMs ?? 5000
  if (!Number.isSafeInteger(interval) || interval < 100) throw new Error('intervalMs must be >= 100')
  if (options.maxChecks !== undefined && (!Number.isSafeInteger(options.maxChecks) || options.maxChecks < 1)) throw new Error('maxChecks must be positive')
  let checks = 0, failures = 0
  while (!options.signal?.aborted) {
    try {
      let input: ExecutionRequest
      const store = new ExecutionStore(options.stateDir)
      try {
        await bindContext(ctx, d, store)
        const pending = store.all<Attempt>('requests').find(r => r.status === 'pending')
        const session = store.get<ExecutionSession>('sessions', sessionId)
        if (!session) throw new Error('unknown sessionId')
        if (pending && pending.request.sessionId !== sessionId) throw new Error(`resume pending request ${pending.request.requestId} first`)
        input = pending?.request ?? { schema: 'aqua-execution-v1', requestId: `watch-${randomUUID()}`, sessionId, action: 'monitor', expectedStrategyHash: activeOf(session.plan).strategyHash }
      } finally { store.close() }
      const result = await executeRequest(ctx, d, input, options)
      failures = 0; checks++; await options.onCheck?.(result)
      if (result.status === 'failed' || result.plan.finished || (options.maxChecks && checks >= options.maxChecks)) return result
    } catch (e) {
      if (options.signal?.aborted) break
      if (!(e instanceof MonitorDataError) && !(e instanceof ExecutionBusyError) && !(e instanceof ExecutionConflictError)) throw e
      failures++
      console.error(`executor monitor degraded; retry ${failures}`)
    }
    try { await sleep(Math.min(Math.max(interval, 30000), interval * 2 ** Math.min(failures, 10)), undefined, { signal: options.signal }) }
    catch (e) { if (!options.signal?.aborted) throw e }
  }
  return { status: 'stopped' as const }
}
