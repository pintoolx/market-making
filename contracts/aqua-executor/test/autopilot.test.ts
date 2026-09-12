import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTestClient, http, zeroAddress, zeroHash, type Abi } from 'viem'
import { foundry } from 'viem/chains'
import { autopilotTick, proposeRollover, parseAutopilotPolicy, type AutopilotPolicy } from '../src/autopilot.ts'
import { concentrationBounds } from '../src/concentrated.ts'
import { readJson } from '../src/config.ts'
import { compileExecution } from '../src/execution-compile.ts'
import { executeRequest, executionStatus } from '../src/execution-controller.ts'
import { ExecutionStore } from '../src/execution-store.ts'
import { takerTraits } from '../src/compile.ts'
import { rawBalances, takerSwap, quote, buildTx, waitMined } from '../src/executor.ts'
import { lpFixture } from './helpers/lp.ts'
import type { Hex } from '../src/types.ts'

const policy: AutopilotPolicy = { schema: 'aqua-autopilot-v1', minPrice: '1000', maxPrice: '5000', rangeWidthBps: 1000,
  triggerBps: 500, cooldownSec: 60, ttlSec: 300, maxRebalances: 1, feeBps: 30, highMovementFeeBps: 100, movementThresholdBps: 1000 }
let f: Awaited<ReturnType<typeof lpFixture>>
before(async () => { f = await lpFixture() }); after(() => f?.close())
const params = () => { const p = f.params(); p.tokens = [f.d.tokens.mWETH!, f.d.tokens.mUSDC!]; p.amounts = ['2000000000000000000', '5000000000'];
  p.program = { kind: 'concentrated', feeBps: 30, deadline: Math.floor(Date.now() / 1000) + 2, salt: p.program.salt, ...concentrationBounds(p.tokens, [18, 6], '2000', '3000') }; return p }
const prices = (eth = '250000000000') => ({ source: 'explicit synthetic oracle', mode: 'simulated' as const, asOf: Math.floor(Date.now() / 1000),
  usdE8: { [f.d.tokens.mWETH!.toLowerCase()]: eth, [f.d.tokens.mUSDC!.toLowerCase()]: '100000000' } })
const ship = async (id: string, p = params()) => {
  const opts = { stateDir: join(f.dir, id), getPrices: async () => prices() }
  await executeRequest(f.ctx, f.d, { schema: 'aqua-execution-v1', requestId: 'ship', sessionId: id, action: 'ship', strategy: p,
    policy: { tokens: p.tokens, baselineAmounts: p.amounts, maxDrawdownBps: 100, maxPriceAgeSec: 60 } }, opts)
  return opts
}

test('bounded proposals recenter, clamp price range, choose movement fees, and respect expiry/cooldown/budget', () => {
  assert.deepEqual(parseAutopilotPolicy(policy), policy)
  assert.throws(() => parseAutopilotPolicy({ ...policy, maxRebalances: 0 }))
  assert.throws(() => parseAutopilotPolicy({ ...policy, unknown: true }))
  const p = params(), now = p.program.deadline + 1, state = { rebalances: 0, lastAt: 0, anchorPriceE18: String(2000n * 10n ** 18n) }
  const propose = (patch = {}, time = now, price = 2500n * 10n ** 18n, balances = p.amounts.map(BigInt)) => proposeRollover(p, balances, [18, 6], price, time, policy, { ...state, ...patch })
  const r = propose(); assert.equal(r.action, 'rebalance'); if (r.action !== 'rebalance') return
  assert.equal(r.strategy.program.feeBps, 100)
  assert.deepEqual(r.strategy.amounts, p.amounts)
  assert.equal(r.strategy.program.salt, String(BigInt(p.program.salt) + 1n))
  assert.equal(propose({}, p.program.deadline).reason, 'waiting-for-expiry')
  assert.equal(propose({ lastAt: now - 1 }).reason, 'cooldown')
  assert.equal(propose({ rebalances: 1 }).reason, 'rebalance-budget-exhausted')
  assert.equal(propose({}, now, 6000n * 10n ** 18n).reason, 'price-outside-policy')
  assert.equal(propose({}, now, 2500n * 10n ** 18n, [0n, 100n]).reason, 'one-sided-inventory')
  const externallyChanged = { ...p, program: { ...p.program, ...concentrationBounds(p.tokens, [18, 6], '500', '6000') } }
  const corrected = proposeRollover(externallyChanged, p.amounts.map(BigInt), [18, 6], 2500n * 10n ** 18n, now, policy,
    { ...state, anchorPriceE18: String(2500n * 10n ** 18n) })
  assert.equal(corrected.reason, 'recenter-after-expiry', 'manual bounds outside policy must not be silently renewed')
  const clamped = propose({}, now, 4999n * 10n ** 18n)
  assert.equal(clamped.action, 'rebalance'); if (clamped.action === 'rebalance') {
    const bounds = concentrationBounds(p.tokens, [18, 6], '4499.1', '5000')
    assert.ok(clamped.strategy.program.kind === 'concentrated')
    assert.equal(clamped.strategy.program.sqrtPriceMax, bounds.sqrtPriceMax)
    assert.equal(clamped.strategy.program.sqrtPriceMin, bounds.sqrtPriceMin)
  }
})

test('default dry run sends nothing; expired rollover recovers the persisted transaction and retains its budget and baseline', async () => {
  const id = 'auto-recover', p = params(), opts = await ship(id, p)
  const before = await f.ctx.pc.getTransactionCount({ address: f.ctx.maker.account.address })
  assert.equal((await autopilotTick(f.ctx, f.d, id, policy, opts)).action, 'hold')
  await sleep(3100)
  await createTestClient({ chain: foundry, mode: 'anvil', transport: http(f.rpc) }).mine({ blocks: 1 })
  const preview = await autopilotTick(f.ctx, f.d, id, policy, opts)
  assert.equal(preview.action, 'rebalance')
  assert.equal(await f.ctx.pc.getTransactionCount({ address: f.ctx.maker.account.address }), before)
  await assert.rejects(autopilotTick(f.ctx, f.d, id, policy, { ...opts, execute: true, onTransaction: e => {
    if (e.phase === 'broadcast' && e.step === 'primary') throw new Error('interrupt auto after broadcast')
  } }), /interrupt auto/)
  const sent = await f.ctx.pc.getTransactionCount({ address: f.ctx.maker.account.address })
  // A newer price cannot regenerate the already persisted decision/transaction.
  const resumed = await autopilotTick(f.ctx, f.d, id, policy, { ...opts, execute: true, getPrices: async () => prices('260000000000') })
  assert.equal(resumed.action, 'rebalance')
  assert.equal(await f.ctx.pc.getTransactionCount({ address: f.ctx.maker.account.address }), sent)
  const status = await executionStatus(f.ctx, f.d, opts.stateDir, id), next = status.session.plan.rebalances!.at(-1)!.strategy
  assert.deepEqual(status.session.plan.policy.baselineAmounts, p.amounts)
  assert.equal(next.program.feeBps, 30)
  assert.ok((await rawBalances(f.ctx, f.d, compileExecution(p))).every(b => b.tokensCount === 255))
  await takerSwap(f.ctx, f.d, compileExecution(next), next.tokens[1]!, 10_000_000n, 50, f.rec)
  const held = await autopilotTick(f.ctx, f.d, id, policy, { ...opts, execute: true })
  assert.ok('reason' in held); assert.equal(held.reason, 'rebalance-budget-exhausted')
  await assert.rejects(autopilotTick(f.ctx, f.d, id, { ...policy, maxRebalances: 2 }, { ...opts, execute: true }), /bound to this session/)
  await executeRequest(f.ctx, f.d, { schema: 'aqua-execution-v1', requestId: 'dock', sessionId: id, action: 'dock', expectedStrategyHash: status.strategyHash }, opts)
})

test('stale oracle blocks transactions; maximum loss still docks a live strategy before expiry', async () => {
  const id = 'auto-risk', p = params(); p.program.deadline += 300
  const opts = await ship(id, p), s = compileExecution(p)
  const before = await f.ctx.pc.getTransactionCount({ address: f.ctx.maker.account.address })
  await assert.rejects(autopilotTick(f.ctx, f.d, id, policy, { ...opts, execute: true, getPrices: async () => ({ ...prices(), asOf: 1 }) }), /stale prices/)
  assert.equal(await f.ctx.pc.getTransactionCount({ address: f.ctx.maker.account.address }), before)
  await takerSwap(f.ctx, f.d, s, s.tokens[1]!, 500_000_000n, 50, f.rec)
  const riskOpts = { ...opts, getPrices: async () => prices('2500000000000') }
  assert.equal((await autopilotTick(f.ctx, f.d, id, policy, riskOpts)).action, 'dock')
  assert.ok((await rawBalances(f.ctx, f.d, s)).every(b => b.tokensCount === 2))
  assert.equal((await autopilotTick(f.ctx, f.d, id, policy, { ...riskOpts, execute: true })).action, 'dock')
  assert.ok((await rawBalances(f.ctx, f.d, s)).every(b => b.tokensCount === 255))
})

test('guarded rollover keeps the exact recipe and stays closed to trading until a new report arrives', async () => {
  const id = 'auto-guard', p = params(), zeroPolicy = { ...policy, feeBps: 0, highMovementFeeBps: 0 }
  const artifact = readJson('artifacts/AquaGuardV2.json') as { abi: Abi; bytecode: Hex }
  const guard = await f.dep(artifact, [f.forwarder, f.d.router, zeroHash, zeroAddress, true])
  p.program.deadline = Math.floor(Date.now() / 1000) + 2; p.program.feeBps = 0
  p.guard = { address: guard, version: 2, caps: { maxAmount0PerSwap: String(10n ** 18n), maxAmount1PerSwap: '1000000000', maxPostBalance0: String(3n * 10n ** 18n), maxPostBalance1: '6000000000' } }
  const opts = await ship(id, p)
  await assert.rejects(autopilotTick(f.ctx, f.d, id, policy, { ...opts, execute: true }), /zero fees/)
  await sleep(3100); await createTestClient({ chain: foundry, mode: 'anvil', transport: http(f.rpc) }).mine({ blocks: 1 })
  const result = await autopilotTick(f.ctx, f.d, id, zeroPolicy, { ...opts, execute: true })
  assert.ok('reportRequired' in result); assert.equal(result.reportRequired, true)
  const status = await executionStatus(f.ctx, f.d, opts.stateDir, id), next = status.session.plan.rebalances!.at(-1)!.strategy
  assert.equal(next.guard?.version, 2); assert.equal(next.guard?.address, guard.toLowerCase())
  const compiled = compileExecution(next)
  await assert.rejects(quote(f.ctx, f.d, compiled, p.tokens[1]!, p.tokens[0]!, 10_000_000n))
  const before = await rawBalances(f.ctx, f.d, compiled)
  const rejected = await waitMined(f.ctx, await f.ctx.taker.sendTransaction({
    ...buildTx.swap(f.d, compiled, p.tokens[1]!, p.tokens[0]!, 10_000_000n, takerTraits(0n)), gas: 800_000n,
  }))
  assert.equal(rejected.status, 'reverted'); assert.equal(rejected.logs.length, 0)
  assert.deepEqual(await rawBalances(f.ctx, f.d, compiled), before)
  const store = new ExecutionStore(opts.stateDir)
  try { assert.equal(store.get<{ rebalances: number }>('autopilot', id)?.rebalances, 1) } finally { store.close() }
  await executeRequest(f.ctx, f.d, { schema: 'aqua-execution-v1', requestId: 'dock', sessionId: id, action: 'dock', expectedStrategyHash: status.strategyHash }, opts)
})

test('a fresh oracle response from the next second is accepted against the clock after reads', async () => {
  const id = 'auto-slow-oracle', p = params(); p.program.deadline += 300
  const opts = await ship(id, p)
  const result = await autopilotTick(f.ctx, f.d, id, policy, { ...opts, getPrices: async () => { await sleep(1100); return prices() } })
  assert.ok('reason' in result); assert.equal(result.reason, 'waiting-for-expiry')
  await executeRequest(f.ctx, f.d, { schema: 'aqua-execution-v1', requestId: 'dock', sessionId: id, action: 'dock', expectedStrategyHash: compileExecution(p).strategyHash }, opts)
})

test('delayed broadcast recovery starts cooldown at the mined rollover block', async t => {
  const tc = createTestClient({ chain: foundry, mode: 'anvil', transport: http(f.rpc) })
  const snapshot = await tc.snapshot()
  const wall = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now: wall })
  try {
    const id = 'auto-mined-cooldown', p = params(); p.program.deadline += 3
    const opts = await ship(id, p), bounded = { ...policy, ttlSec: 60, cooldownSec: 120, maxRebalances: 3 }
    const first = p.program.deadline + 1
    t.mock.timers.setTime(first * 1000)
    await tc.setNextBlockTimestamp({ timestamp: BigInt(first) }); await tc.mine({ blocks: 1 })
    await assert.rejects(autopilotTick(f.ctx, f.d, id, bounded, { ...opts, execute: true, onTransaction: e => {
      if (e.step === 'primary' && e.phase === 'prepared') throw new Error('delay prepared rollover')
    } }), /delay prepared rollover/)
    t.mock.timers.setTime((first + 180) * 1000)
    await tc.setNextBlockTimestamp({ timestamp: BigInt(first + 180) }); await tc.mine({ blocks: 1 })
    const recovered = await autopilotTick(f.ctx, f.d, id, bounded, { ...opts, execute: true })
    assert.ok('result' in recovered)
    assert.equal(recovered.result?.outcome, 'rebalanced')
    const primary = recovered.result!.transactions.find(tx => tx.step === 'primary')!
    const mined = await f.ctx.pc.getBlock({ blockNumber: BigInt(primary.blockNumber) })
    const store = new ExecutionStore(opts.stateDir)
    try { assert.equal(store.get<{ lastAt: number }>('autopilot', id)?.lastAt, Number(mined.timestamp)) } finally { store.close() }
    const result = await autopilotTick(f.ctx, f.d, id, bounded, opts)
    assert.ok('reason' in result); assert.equal(result.reason, 'cooldown')
  } finally { await tc.revert({ id: snapshot }); t.mock.timers.reset() }
})
