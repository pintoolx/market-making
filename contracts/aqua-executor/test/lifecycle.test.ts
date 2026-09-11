// Needs anvil (Foundry) on PATH, or ANVIL=/path/to/anvil. Spins up a throwaway chain and self-deploys everything.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTestClient, erc20Abi, http } from 'viem'
import { foundry } from 'viem/chains'
import { compile, takerTraits } from '../src/compile.ts'
import { ANVIL_KEYS, connect, readJson, type Ctx } from '../src/config.ts'
import { deploy } from '../src/deploy.ts'
import { buildTx, quote, rawBalances, send, shipPreflight, takerSwap } from '../src/executor.ts'
import { fixedParams } from '../src/fixed-params.ts'
import { runLifecycle } from '../src/lifecycle.ts'
import { recorder } from '../src/records.ts'
import { monitorOnce } from '../src/monitor.ts'
import { createMonitorSession, writeMonitorPlan } from '../src/monitor-session.ts'
import type { PriceSnapshot, RiskPolicy } from '../src/risk.ts'
import type { Deployment } from '../src/types.ts'

const rpc = `http://127.0.0.1:${8700 + (process.pid % 200)}`
let anvil: ChildProcess
let ctx: Ctx
let d: Deployment
const dir = mkdtempSync(join(tmpdir(), 'aqua-executor-'))

before(async () => {
  anvil = spawn(process.env.ANVIL ?? 'anvil', ['--port', new URL(rpc).port, '--silent'], { stdio: 'ignore' })
  anvil.on('error', e => console.error(`cannot start anvil (install Foundry or set ANVIL=): ${e.message}`))
  ctx = connect(foundry, rpc, ANVIL_KEYS[0], ANVIL_KEYS[1])
  for (let i = 0; ; i++) {
    try {
      await ctx.pc.getBlockNumber()
      break
    } catch (e) {
      if (i > 100) throw e
      await sleep(100)
    }
  }
  d = await deploy(ctx, recorder({ dir, runId: 'deploy', chainId: foundry.id, explorer: null }))
})
after(() => anvil?.kill())

const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))

test('approve -> ship -> swap -> rebalance -> swap -> dock, all recorded', async () => {
  const out = await runLifecycle(ctx, d, { rebalance: true, recordsDir: dir, runId: 'happy' })
  const log = lines(out.file)
  const execs = log.filter(l => l.kind === 'execution')
  assert.deepEqual(
    execs.map(l => l.action),
    ['maker-approve', 'maker-approve', 'ship', 'taker-approve', 'swap', 'maker-approve', 'maker-approve', 'rebalance', 'taker-approve', 'swap', 'dock', 'maker-revoke', 'maker-revoke'],
  )
  assert.ok(execs.every(l => l.status === 'success'))
  const events = (action: string) => execs.filter(l => l.action === action).map(l => l.events.map((e: { event: string }) => e.event))
  assert.deepEqual(events('ship'), [['Shipped', 'Pushed', 'Pushed']])
  assert.deepEqual(events('rebalance'), [['Docked', 'Shipped', 'Pushed', 'Pushed']])
  assert.deepEqual(events('dock'), [['Docked']])
  for (const ev of events('swap')) for (const name of ['Pulled', 'Pushed', 'Swapped']) assert.ok(ev.includes(name), `swap missing ${name}: ${ev}`)
  for (const s of out.swaps) assert.ok(s.amountOut >= s.minOut && s.amountOut > 0n)
  assert.equal(out.strategies.length, 2)
  assert.deepEqual(log.at(-1).kind + log.at(-1).status, 'cyclecompleted')
})

test('risk monitor retains the HODL benchmark through rebalance and docks once after real swaps', async () => {
  const tpl = readJson('params/fixed.json')
  const rec = recorder({ dir, runId: 'risk-monitor', chainId: foundry.id, explorer: null })
  const s1 = compile(await fixedParams(ctx, d, tpl, { revision: 1, salt: 80n }))
  const policy: RiskPolicy = { tokens: s1.tokens, baselineAmounts: s1.params.amounts, maxDrawdownBps: 100, maxPriceAgeSec: 60 }
  const prices = (weth = '250000000000'): PriceSnapshot => ({
    source: 'explicit test fixture', asOf: Math.floor(Date.now() / 1000),
    usdE8: { [s1.tokens[0]!]: weth, [s1.tokens[1]!]: '100000000' },
  })
  for (const [i, token] of s1.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, s1.amounts[i]!), 'maker-approve', rec)
  await shipPreflight(ctx, d, s1)
  await send(ctx, ctx.maker, buildTx.ship(d, s1), 'ship', rec)
  assert.equal((await monitorOnce(ctx, d, s1, policy, async () => prices(), rec)).status, 'within-limit')
  await takerSwap(ctx, d, s1, s1.tokens[1]!, 100_000_000n, 50, rec)
  assert.equal((await monitorOnce(ctx, d, s1, policy, async () => prices(), rec)).status, 'within-limit')

  const inventory = (await rawBalances(ctx, d, s1)).map(b => b.balance)
  const s2 = compile(await fixedParams(ctx, d, tpl, { revision: 2, salt: 81n, amounts: inventory, feeBps: 50 }))
  for (const [i, token] of s2.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, s2.amounts[i]!), 'maker-approve', rec)
  await shipPreflight(ctx, d, s2)
  await send(ctx, ctx.maker, buildTx.rebalance(d, s1, s2), 'rebalance', rec)

  const nonce = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
  await assert.rejects(monitorOnce(ctx, d, s2, policy, async () => ({ ...prices(), asOf: Math.floor(Date.now() / 1000) - 61 }), rec), /stale prices/)
  await assert.rejects(monitorOnce(ctx, d, { ...s2, params: { ...s2.params, chainId: 84532 } }, policy, async () => prices(), rec), /chainId mismatch/)
  await assert.rejects(monitorOnce(ctx, d, { ...s2, params: { ...s2.params, maker: ctx.taker.account.address } }, policy, async () => prices(), rec), /not the signer/)
  await assert.rejects(monitorOnce(ctx, d, s2, { ...policy, tokens: [...policy.tokens].reverse() }, async () => prices(), rec), /token order/)
  assert.equal((await monitorOnce(ctx, d, s2, policy, async () => prices('1000000000000'), rec, { dryRun: true })).status, 'would-dock')
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonce)
  assert.ok((await rawBalances(ctx, d, s2)).every(b => b.tokensCount === 2))

  const closed = await monitorOnce(ctx, d, s2, policy, async () => prices('1000000000000'), rec)
  assert.equal(closed.status, 'docked')
  assert.ok((await rawBalances(ctx, d, s2)).every(b => b.tokensCount === 255))
  assert.equal((await monitorOnce(ctx, d, s2, policy, async () => { throw new Error('closed strategy should not request prices') }, rec)).status, 'already-docked')
  assert.equal(lines(rec.file).filter(l => l.action === 'risk-dock').length, 1)
  for (const [i, token] of s2.tokens.entries()) {
    const allowance = await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.maker.account.address, d.aqua] })
    assert.equal(allowance, s2.amounts[i]!, 'the monitor must not revoke allowances shared by other strategies')
    await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, 0n), 'maker-revoke', rec)
  }
})

test('monitor session follows confirmed rebalances, survives data outages and preserves the benchmark on restart', async () => {
  const tpl = readJson('params/fixed.json')
  const rec = recorder({ dir, runId: 'monitor-session', chainId: foundry.id, explorer: null })
  const s1 = compile(await fixedParams(ctx, d, tpl, { revision: 1, salt: 200n }))
  const root = { strategy: s1.params, policy: { tokens: s1.tokens, baselineAmounts: s1.params.amounts, maxDrawdownBps: 100, maxPriceAgeSec: 60 } }
  const file = join(dir, 'session.plan.json')
  writeMonitorPlan(file, root)
  let calls = 0
  let outage = false
  const prices = async (): Promise<PriceSnapshot> => {
    if (outage && ++calls === 1) throw new Error('fixture RPC unavailable')
    return {
      source: 'simulated session test', mode: 'simulated', asOf: Math.floor(Date.now() / 1000) - (outage && calls === 2 ? 61 : 0),
      usdE8: { [s1.tokens[0]!]: outage ? '1000000000000' : '250000000000', [s1.tokens[1]!]: '100000000' },
    }
  }
  const session = createMonitorSession(ctx, d, root, prices, rec, { stateFile: file })
  for (const [i, token] of s1.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, s1.amounts[i]!), 'maker-approve', rec)
  await send(ctx, ctx.maker, buildTx.ship(d, s1), 'ship', rec)
  assert.equal((await session.check()).status, 'within-limit')
  const swap = await takerSwap(ctx, d, s1, s1.tokens[1]!, 100_000_000n, 50, rec)
  const amounts = (await rawBalances(ctx, d, s1)).map(b => b.balance)
  const s2 = compile(await fixedParams(ctx, d, tpl, { revision: 2, salt: 201n, amounts, feeBps: 50 }))

  // A standalone follower starts on the original strategy, then discovers the published transition.
  const follower = createMonitorSession(ctx, d, root, prices, rec, {
    getPlan: async () => JSON.parse(readFileSync(file, 'utf8')), dryRun: true,
  })
  assert.equal((await follower.check()).status, 'within-limit')
  const moved = await session.rebalance(s2.params)
  assert.equal(moved.check.status, 'within-limit')
  assert.equal(session.active.strategyHash, s2.strategyHash)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(saved.policy, root.policy)
  assert.notDeepEqual(saved.policy.baselineAmounts, s2.params.amounts)
  assert.equal(saved.rebalances[0].txHash, moved.txHash)
  const nonce = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
  // The old strategy may be docked before the new journal reaches the follower. It must keep polling.
  writeMonitorPlan(file, root)
  const observed: string[] = []
  const followed = await follower.run({ intervalMs: 100, maxChecks: 2, onCheck: result => {
    observed.push(result.status)
    if (result.status === 'already-docked') writeMonitorPlan(file, saved)
  } })
  assert.deepEqual(observed, ['already-docked', 'within-limit'])
  assert.equal(followed.status, 'within-limit')
  assert.equal(follower.active.strategyHash, s2.strategyHash)
  const restart = createMonitorSession(ctx, d, saved, prices, rec, { dryRun: true })
  assert.equal((await restart.check()).status, 'within-limit')
  assert.equal(restart.active.strategyHash, s2.strategyHash)

  writeMonitorPlan(file, { ...saved, policy: { ...saved.policy, baselineAmounts: s2.params.amounts } })
  await assert.rejects(follower.check(), /risk benchmark/)
  writeMonitorPlan(file, root)
  await assert.rejects(follower.check(), /rolled back/)
  const forged = createMonitorSession(ctx, d, { ...root, rebalances: [{ strategy: s2.params, txHash: swap.txHash }] }, prices, rec)
  await assert.rejects(forged.check(), /expected successful atomic maker transaction/)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonce)
  writeMonitorPlan(file, saved)

  outage = true
  const stopped = await session.run({ intervalMs: 100, maxDelayMs: 100, maxChecks: 1 })
  assert.equal(stopped.status, 'docked')
  assert.equal(calls, 3)
  const log = lines(rec.file)
  assert.equal(log.filter(l => l.kind === 'monitor-degraded').length, 2)
  assert.equal(log.filter(l => l.kind === 'monitor-recovered').length, 1)
  assert.equal(log.filter(l => l.action === 'risk-dock').length, 1)
  assert.ok((await rawBalances(ctx, d, s2)).every(b => b.tokensCount === 255))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).finished, true)
  assert.equal((await session.check()).status, 'already-docked')
  assert.equal(calls, 3, 'closed strategy does not request more prices')
  assert.equal((await follower.run({ intervalMs: 100 })).status, 'already-docked')
  for (const token of s2.tokens) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, 0n), 'maker-revoke', rec)
})

test('guard rails: each misuse reverts with the expected error', async t => {
  const tpl = readJson('params/fixed.json')
  const rec = recorder({ dir, runId: 'negative', chainId: foundry.id, explorer: null })
  const s = compile(await fixedParams(ctx, d, tpl, { revision: 1, salt: 7n }))
  const [tokenOut, tokenIn] = s.tokens as [`0x${string}`, `0x${string}`] // mWETH out, mUSDC in
  const amountIn = 10n ** 8n // 100 mUSDC
  const swap = (minOut: bigint) => send(ctx, ctx.taker, buildTx.swap(d, s, tokenIn, tokenOut, amountIn, takerTraits(minOut)), 'swap', rec)

  await t.test('ship preflight blocks a maker without allowance', () => assert.rejects(shipPreflight(ctx, d, s), /allowance to Aqua/))
  for (const [i, token] of s.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, s.amounts[i]!), 'maker-approve', rec)
  await send(ctx, ctx.maker, buildTx.ship(d, s), 'ship', rec)
  await send(ctx, ctx.taker, buildTx.approve(tokenIn, d.router, amountIn), 'taker-approve', rec)

  await t.test('re-shipping the same strategy', () => assert.rejects(send(ctx, ctx.maker, buildTx.ship(d, s), 'ship', rec), /StrategiesMustBeImmutable/))
  await t.test('min-out above the quote', async () => {
    const q = await quote(ctx, d, s, tokenIn, tokenOut, amountIn)
    await assert.rejects(swap(q.amountOut + 1n), /TakerTraitsInsufficientMinOutputAmount/)
  })
  await t.test('partial dock', () => assert.rejects(send(ctx, ctx.maker, buildTx.dock(d, s, [s.tokens[0]!]), 'dock', rec), /DockingShouldCloseAllTokens/))
  await t.test('dock by someone other than the maker', () => assert.rejects(send(ctx, ctx.taker, buildTx.dock(d, s), 'dock', rec), /DockingShouldCloseAllTokens/))
  await t.test('swap after the strategy deadline', async () => {
    const tc = createTestClient({ chain: foundry, mode: 'anvil', transport: http(rpc) })
    await tc.increaseTime({ seconds: tpl.ttlSec + 1 })
    await tc.mine({ blocks: 1 })
    await assert.rejects(swap(0n), /DeadlineReached/)
  })
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
  await t.test('swap after dock', () => assert.rejects(swap(0n), /SafeBalancesForTokenNotInActiveStrategy/))
})
