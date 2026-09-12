import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { compile } from './compile.ts'
import { fromEnv, loadDeployment, readJson, RECORDS_DIR } from './config.ts'
import { buildTx, DOCKED, expectState, rawBalances, send, shipPreflight, takerSwap } from './executor.ts'
import { fixedParams } from './fixed-params.ts'
import type { MonitorPlan } from './monitor.ts'
import { createMonitorSession, writeMonitorPlan } from './monitor-session.ts'
import { createChainlinkPrices, LIVE_MAX_PRICE_AGE_SEC } from './prices.ts'
import { recorder, runStamp } from './records.ts'
import type { PriceSnapshot } from './risk.ts'

const { values } = parseArgs({ options: {
  network: { type: 'string', default: 'local' },
  'price-source': { type: 'string', default: 'chainlink' },
} })
if (!['chainlink', 'simulated'].includes(values['price-source'])) throw new Error('price-source must be chainlink or simulated')
const live = values['price-source'] === 'chainlink'
const ctx = fromEnv(values.network)
if (ctx.chain.id !== 31337 && ctx.chain.id !== 84532) throw new Error('risk demo is restricted to local or Base Sepolia mock tokens')
if (await ctx.pc.getChainId() !== ctx.chain.id) throw new Error('demo RPC chainId mismatch')
const d = loadDeployment(ctx.chain.id)
const tpl = readJson('params/fixed.json')
if (tpl.tokens.join(',') !== 'mWETH,mUSDC') throw new Error('risk demo requires mWETH then mUSDC')
const mode = live ? 'live' : 'simulated'
const rec = recorder({ dir: RECORDS_DIR, runId: `risk-${mode}-${runStamp()}`, chainId: ctx.chain.id, explorer: ctx.explorer })
const salt = BigInt(`0x${randomBytes(8).toString('hex')}`)
let phase: 'initial' | 'adverse' = 'initial'
let lastPrices: PriceSnapshot | undefined
const provider = live ? createChainlinkPrices(d) : async (): Promise<PriceSnapshot> => ({
  asOf: Math.floor(Date.now() / 1000), source: 'fabricated demo prices; not a market feed', mode: 'simulated',
  usdE8: { [d.tokens.mWETH!]: phase === 'adverse' ? '1000000000000' : '250000000000', [d.tokens.mUSDC!]: '100000000' },
  evidence: { scenario: 'ETH reference 2500 to 10000 USD; USDC reference 1 USD', phase },
})
const getPrices = async () => { lastPrices = await provider(); return lastPrices }

// Check oracle availability before sending anything. Live mode changes mock-pool reserves, never oracle values.
const firstPrices = await getPrices()
const amounts = live ? [
  2n * 10n ** 18n,
  2n * BigInt(firstPrices.usdE8[d.tokens.mWETH!]!) * 10n ** 6n / (4n * BigInt(firstPrices.usdE8[d.tokens.mUSDC!]!)),
] : undefined
const s1 = compile(await fixedParams(ctx, d, tpl, { revision: 1, salt, amounts }))
const plan: MonitorPlan = {
  strategy: s1.params,
  policy: { tokens: s1.tokens, baselineAmounts: s1.params.amounts, maxDrawdownBps: 100, maxPriceAgeSec: live ? LIVE_MAX_PRICE_AGE_SEC : 60 },
  rebalances: [], finished: false,
}
writeMonitorPlan(`${rec.file}.plan.json`, plan)
const session = createMonitorSession(ctx, d, plan, getPrices, rec, {
  stateFile: `${rec.file}.plan.json`, signal: AbortSignal.timeout(180_000),
})
const strategies = [s1]
const swaps: Awaited<ReturnType<typeof takerSwap>>[] = []
rec.write({ kind: 'risk-demo-scenario', price_mode: mode, simulated_prices: !live, mock_tokens: true, initial_prices: firstPrices,
  scenario: live ? 'Real Chainlink reference prices; deliberately mispriced mock pool at one-quarter of the ETH/USDC reference ratio; two adverse inventory swaps.' : 'Fabricated reference price move after real mock-token swaps and a rebalance.',
  plan,
})
let failure: unknown
try {
  for (const [i, token] of s1.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, s1.amounts[i]!), 'maker-approve', rec, s1.strategyHash)
  await shipPreflight(ctx, d, s1)
  await send(ctx, ctx.maker, buildTx.ship(d, s1), 'ship', rec, s1.strategyHash)
  await expectState(ctx, d, s1, s1.tokens.length, rec, 'after ship')
  if ((await session.check()).status !== 'within-limit') throw new Error('unexpected initial risk state')
  swaps.push(await takerSwap(ctx, d, s1, s1.tokens[1]!, live ? s1.amounts[1]! / 200n : 100_000_000n, 50, rec))

  const inventory = (await rawBalances(ctx, d, s1)).map(b => b.balance)
  const s2 = compile(await fixedParams(ctx, d, tpl, { revision: 2, salt: salt + 1n, amounts: inventory, feeBps: tpl.rebalanceFeeBps }))
  strategies.push(s2)
  const moved = await session.rebalance(s2.params)
  if (moved.check.status !== 'within-limit' || session.active.strategyHash !== s2.strategyHash) throw new Error('monitor did not follow the replacement strategy')
  if (session.plan.policy.baselineAmounts.join(',') !== plan.policy.baselineAmounts.join(',')) throw new Error('HODL benchmark was reset')
  swaps.push(await takerSwap(ctx, d, session.active, s2.tokens[1]!, live ? s1.amounts[1]! / 10n : 100_000_000n, 50, rec))
  phase = 'adverse'
  const stopped = await session.run({ intervalMs: 1000, maxChecks: 3 })
  if (stopped.status !== 'docked') throw new Error(`demo did not trigger risk-dock: ${stopped.status}`)
  rec.write({ kind: 'risk-demo-result', price_mode: mode, simulated_prices: !live, plan: session.plan, swaps, rebalance_tx: moved.txHash, stopped })
  console.log(`price mode: ${mode}${live ? ' (Chainlink; intentionally mispriced mock pool)' : ' (fabricated scenario)'}`)
  console.log(`risk-dock: ${ctx.explorer ? `${ctx.explorer}/tx/${stopped.txHash}` : stopped.txHash}`)
  console.log(`HODL shortfall: ${stopped.result.lossBps} bps; threshold: ${plan.policy.maxDrawdownBps} bps`)
} catch (e) {
  failure = e
} finally {
  const cleanupErrors: unknown[] = []
  for (const strategy of strategies) {
    try {
      const state = await rawBalances(ctx, d, strategy)
      if (state.some(b => b.tokensCount === strategy.tokens.length)) {
        await send(ctx, ctx.maker, buildTx.dock(d, strategy), 'cleanup-dock', rec, strategy.strategyHash)
        await expectState(ctx, d, strategy, DOCKED, rec, 'after cleanup dock')
      }
    } catch (e) { cleanupErrors.push(e) }
  }
  // These isolated demo accounts have no other active strategies. The reusable monitor itself never globally revokes.
  for (const token of s1.tokens) {
    try { await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, 0n), 'maker-revoke', rec, session.active.strategyHash) }
    catch (e) { cleanupErrors.push(e) }
  }
  if (cleanupErrors.length) failure = new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'risk demo or cleanup failed')
  if (!failure) await session.finish()
  rec.write({ kind: 'cycle', status: failure ? 'failed' : 'completed', demo: 'risk-monitor', price_mode: mode, simulated_prices: !live, plan: session.plan, error: failure ? String(failure) : null })
  // Preserve the last actual observation, without refreshing timestamps when saving a file.
  if (lastPrices) writeFileSync(`${rec.file}.prices.json`, JSON.stringify(lastPrices, null, 2) + '\n')
  console.log(`records: ${rec.file}`)
}
if (failure) throw failure
