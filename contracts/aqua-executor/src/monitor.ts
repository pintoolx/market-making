import { erc20Abi } from 'viem'
import { routerAbi } from './abi.ts'
import type { Compiled } from './compile.ts'
import type { Ctx } from './config.ts'
import { buildTx, DOCKED, expectState, rawBalances, send } from './executor.ts'
import type { Recorder } from './records.ts'
import { MonitorDataError, evaluateRisk, validatePolicy, type PriceSnapshot, type RiskPolicy } from './risk.ts'
import type { AquaStrategyParams, Deployment } from './types.ts'

export interface MonitorPlan {
  strategy: AquaStrategyParams
  /** Keep this same policy/benchmark when replacing strategy after a rebalance. */
  policy: RiskPolicy
  /** Append only after each successful atomic rebalance. strategy remains the original strategy. */
  rebalances?: { strategy: AquaStrategyParams; txHash: `0x${string}` }[]
  finished?: boolean
}

/** One check. Prices are fetched after the chain snapshot and checked for freshness when evaluated. */
export async function monitorOnce(
  ctx: Ctx, d: Deployment, s: Compiled, policy: RiskPolicy,
  getPrices: () => Promise<PriceSnapshot>, rec: Recorder,
  o: { dryRun?: boolean; signal?: AbortSignal } = {},
) {
  validatePolicy(policy)
  if (s.params.chainId !== ctx.chain.id || d.chainId !== ctx.chain.id || await monitorRead(() => ctx.pc.getChainId()) !== ctx.chain.id) {
    throw new Error('monitor chainId mismatch')
  }
  if (s.params.maker.toLowerCase() !== ctx.maker.account.address.toLowerCase()) throw new Error('monitor maker is not the signer')
  if (s.tokens.length !== policy.tokens.length || s.tokens.some((t, i) => t.toLowerCase() !== policy.tokens[i]!.toLowerCase())) {
    throw new Error('risk policy token order does not match strategy')
  }
  const block = await monitorRead(() => ctx.pc.getBlock({ blockTag: 'latest' }))
  const state = await monitorRead(() => rawBalances(ctx, d, s, block.number))
  if (state.every(b => b.tokensCount === DOCKED)) {
    rec.write({ kind: 'risk', status: 'already-docked', strategy_hash: s.strategyHash, block_number: block.number })
    return { status: 'already-docked' as const }
  }
  if (state.some(b => b.tokensCount !== s.tokens.length)) throw new Error('monitor strategy is not fully active')
  const hash = await monitorRead(() => ctx.pc.readContract({ address: d.router, abi: routerAbi, functionName: 'hash', args: [s.order], blockNumber: block.number }))
  if (hash !== s.strategyHash) throw new Error('monitor router hash mismatch')
  const decimals = await monitorRead(() => Promise.all(s.tokens.map(address => ctx.pc.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber: block.number }))))
  const prices = await monitorRead(getPrices)
  const now = Math.floor(Date.now() / 1000)
  // An RPC frozen on old blocks must not present old balances as a current risk check.
  if (now - Number(block.timestamp) > 60 || Number(block.timestamp) > now + 5) throw new MonitorDataError('stale or future chain snapshot')
  let result: ReturnType<typeof evaluateRisk>
  try { result = evaluateRisk(policy, state.map(b => b.balance), decimals, prices, now) }
  catch (e) { throw new MonitorDataError(e instanceof Error ? e.message : 'invalid prices') }
  rec.write({
    kind: 'risk', status: result.breached ? 'threshold-reached' : 'within-limit', strategy_hash: s.strategyHash,
    block_number: block.number, raw_balances: state, policy, prices, ...result, dry_run: o.dryRun ?? false,
  })
  if (!result.breached) return { status: 'within-limit' as const, result }
  if (o.dryRun) return { status: 'would-dock' as const, result }
  // A rebalance or a second monitor may already have closed this strategy since our snapshot.
  const latest = await monitorRead(() => rawBalances(ctx, d, s))
  if (latest.every(b => b.tokensCount === DOCKED)) {
    rec.write({ kind: 'risk', status: 'already-docked', strategy_hash: s.strategyHash })
    return { status: 'already-docked' as const }
  }
  if (latest.some(b => b.tokensCount !== s.tokens.length)) throw new Error('monitor strategy state changed unexpectedly')
  o.signal?.throwIfAborted()
  const receipt = await send(ctx, ctx.maker, buildTx.dock(d, s), 'risk-dock', rec, s.strategyHash)
  await expectState(ctx, d, s, DOCKED, rec, 'after risk dock')
  // Allowances are shared by the maker's other strategies: docking does not revoke them globally.
  return { status: 'docked' as const, result, txHash: receipt.transactionHash }
}


/** Only wrap reads. Transaction failures remain fatal to prevent uncertain broadcasts being repeated. */
export async function monitorRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read() }
  catch (e) { throw e instanceof MonitorDataError ? e : new MonitorDataError('monitor data read failed') }
}
