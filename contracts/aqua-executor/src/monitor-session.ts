import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Compiled } from './compile.ts'
import { compileExecution as compile } from './execution-compile.ts'
import type { Ctx } from './config.ts'
import { buildTx, DOCKED, expectState, send, shipPreflight } from './executor.ts'
import { monitorOnce, monitorRead, type MonitorPlan } from './monitor.ts'
import type { Recorder } from './records.ts'
import { MonitorDataError, validatePolicy, type PriceSnapshot } from './risk.ts'
import type { AquaStrategyParams, Deployment } from './types.ts'

/** Publish the whole plan with an atomic rename; readers cannot see a partially written JSON file. */
export function writeMonitorPlan(file: string, plan: MonitorPlan) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(plan, null, 2) + '\n')
  renameSync(temp, file)
}

/** One writer per maker. Checks and managed rebalances share a queue, so they never race for its nonce. */
export function createMonitorSession(
  ctx: Ctx, d: Deployment, initial: MonitorPlan, getPrices: () => Promise<PriceSnapshot>, rec: Recorder,
  o: { stateFile?: string; getPlan?: () => Promise<MonitorPlan>; dryRun?: boolean; signal?: AbortSignal } = {},
) {
  validatePolicy(initial.policy)
  const root = structuredClone({ strategy: initial.strategy, policy: initial.policy })
  let plan: MonitorPlan = { ...structuredClone(root), rebalances: [], finished: false }
  let active = compile(root.strategy)
  let pending = structuredClone(initial)
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.catch(() => {})
    return result
  }
  const persist = () => { if (o.stateFile) writeMonitorPlan(o.stateFile, plan) }
  const compatible = (s: Compiled) => {
    if (s.params.chainId !== ctx.chain.id || d.chainId !== ctx.chain.id || s.params.maker.toLowerCase() !== ctx.maker.account.address.toLowerCase()) {
      throw new Error('replacement strategy chain/maker mismatch')
    }
    if (s.tokens.length !== root.policy.tokens.length || s.tokens.some((t, i) => t.toLowerCase() !== root.policy.tokens[i]!.toLowerCase())) {
      throw new Error('replacement strategy token order mismatch')
    }
  }
  compatible(active)

  // A published transition is accepted only with a successful maker transaction containing the exact atomic calls.
  const synchronize = async () => {
    const latest = o.getPlan ? await monitorRead(o.getPlan) : pending
    if (!isDeepStrictEqual({ strategy: latest.strategy, policy: latest.policy }, root)) throw new Error('monitor plan changed its original strategy or risk benchmark')
    const previous = plan.rebalances ?? []
    const updates = latest.rebalances ?? []
    if (updates.length < previous.length || !isDeepStrictEqual(updates.slice(0, previous.length), previous)) throw new Error('monitor rebalance history was rewritten or rolled back')
    let next = active
    for (const step of updates.slice(previous.length)) {
      const replacement = compile(step.strategy)
      compatible(replacement)
      if (replacement.strategyHash === next.strategyHash) throw new Error('rebalance must use a new strategy hash')
      const [receipt, tx, blockNumber] = await monitorRead(() => Promise.all([
        ctx.pc.getTransactionReceipt({ hash: step.txHash }),
        ctx.pc.getTransaction({ hash: step.txHash }),
        ctx.pc.getBlockNumber({ cacheTime: 0 }),
      ]))
      if (blockNumber < receipt.blockNumber) throw new MonitorDataError('rebalance receipt is ahead of the latest chain state')
      if (receipt.status !== 'success' || tx.from.toLowerCase() !== ctx.maker.account.address.toLowerCase() ||
          tx.to?.toLowerCase() !== d.aqua.toLowerCase() || tx.input.toLowerCase() !== buildTx.rebalance(d, next, replacement).data.toLowerCase()) {
        throw new Error('rebalance proof is not the expected successful atomic maker transaction')
      }
      rec.write({ kind: 'monitor-follow', from_strategy_hash: next.strategyHash, strategy_hash: replacement.strategyHash, tx_hash: step.txHash, block_number: receipt.blockNumber, policy: root.policy })
      next = replacement
    }
    active = next
    plan = structuredClone({ ...root, rebalances: updates, finished: latest.finished ?? false })
  }

  const check = async () => {
    await synchronize()
    const result = await monitorOnce(ctx, d, active, root.policy, getPrices, rec, { dryRun: o.dryRun, signal: o.signal })
    if (result.status === 'docked') {
      plan.finished = true
      pending = structuredClone(plan)
      persist()
    }
    return result
  }

  return {
    get active() { return active },
    get plan() { return structuredClone(plan) },
    check: () => serial(check),
    /** Approve and rebalance under the same lock as risk checks, then immediately check the replacement. */
    rebalance: (params: AquaStrategyParams) => serial(async () => {
      if (o.dryRun) throw new Error('a dry-run monitor cannot execute a rebalance')
      const before = await check()
      if (before.status !== 'within-limit') throw new Error(`cannot rebalance: ${before.status}`)
      const replacement = compile(params)
      compatible(replacement)
      if (replacement.strategyHash === active.strategyHash) throw new Error('rebalance must use a new strategy hash')
      for (const [i, token] of replacement.tokens.entries()) {
        await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, replacement.amounts[i]!), 'maker-approve', rec, replacement.strategyHash)
      }
      await shipPreflight(ctx, d, replacement)
      o.signal?.throwIfAborted()
      const old = active
      const receipt = await send(ctx, ctx.maker, buildTx.rebalance(d, old, replacement), 'rebalance', rec, replacement.strategyHash)
      // Update our in-memory active strategy immediately after a confirmed tx, before any further RPC read.
      active = replacement
      plan.rebalances = [...(plan.rebalances ?? []), { strategy: structuredClone(params), txHash: receipt.transactionHash }]
      pending = structuredClone(plan)
      persist()
      rec.write({ kind: 'monitor-follow', from_strategy_hash: old.strategyHash, strategy_hash: replacement.strategyHash, tx_hash: receipt.transactionHash, block_number: receipt.blockNumber, policy: root.policy })
      await expectState(ctx, d, old, DOCKED, rec, 'old strategy after monitored rebalance')
      await expectState(ctx, d, replacement, replacement.tokens.length, rec, 'new strategy after monitored rebalance')
      return { txHash: receipt.transactionHash, check: await check() }
    }),
    /** Persist explicit completion for a standalone follower waiting for further rebalances. */
    finish: () => serial(async () => {
      plan.finished = true
      pending = structuredClone(plan)
      persist()
    }),
    /** Retry only data failures with bounded backoff. Never reuse a cached price or retry uncertain sends. */
    run: async (options: { intervalMs?: number; maxDelayMs?: number; maxChecks?: number; onCheck?: (result: Awaited<ReturnType<typeof monitorOnce>>) => void } = {}) => {
      const interval = options.intervalMs ?? 5000
      const maxDelay = options.maxDelayMs ?? Math.max(interval, 30_000)
      if (!Number.isSafeInteger(interval) || interval < 100 || !Number.isSafeInteger(maxDelay) || maxDelay < interval) throw new Error('invalid monitor polling/backoff interval')
      if (options.maxChecks !== undefined && (!Number.isSafeInteger(options.maxChecks) || options.maxChecks < 1)) throw new Error('maxChecks must be positive')
      let failures = 0
      let checks = 0
      while (!o.signal?.aborted) {
        try {
          const result = await serial(check)
          if (failures) rec.write({ kind: 'monitor-recovered', failed_checks: failures, strategy_hash: active.strategyHash })
          failures = 0
          checks++
          options.onCheck?.(result)
          if (result.status === 'docked' || (result.status === 'already-docked' && plan.finished) || (options.maxChecks && checks >= options.maxChecks)) return result
        } catch (e) {
          if (o.signal?.aborted) break
          if (!(e instanceof MonitorDataError)) {
            rec.write({ kind: 'monitor-error', retrying: false, strategy_hash: active.strategyHash, error: e instanceof Error ? e.message : String(e) })
            throw e
          }
          failures++
          const delay = Math.min(maxDelay, interval * 2 ** Math.min(failures - 1, 10))
          rec.write({ kind: 'monitor-degraded', retrying: true, consecutive_failures: failures, retry_in_ms: delay, strategy_hash: active.strategyHash, error: e.message })
          console.error(`monitor degraded: ${e.message}; retry in ${delay} ms`)
        }
        const delay = failures ? Math.min(maxDelay, interval * 2 ** Math.min(failures - 1, 10)) : interval
        try { await sleep(delay, undefined, { signal: o.signal }) } catch (e) { if (!o.signal?.aborted) throw e }
      }
      rec.write({ kind: 'monitor-stopped', strategy_hash: active.strategyHash })
      return { status: 'stopped' as const }
    },
  }
}
