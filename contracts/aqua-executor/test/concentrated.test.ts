import assert from 'node:assert/strict'
import { join } from 'node:path'
import { executeRequest, executionStatus } from '../src/execution-controller.ts'
import { compileExecution } from '../src/execution-compile.ts'
import { parseStrategy } from '../src/execution-request.ts'
import { before, after, test } from 'node:test'
import { encodeAbiParameters, encodeFunctionData, zeroHash, zeroAddress, type Abi } from 'viem'
import { compile } from '../src/compile.ts'
import { concentrationBounds } from '../src/concentrated.ts'
import { readJson } from '../src/config.ts'
import { compileGuarded, compileGuardedV2 } from '../src/guard.ts'
import { buildTx, quote, rawBalances, send, takerSwap } from '../src/executor.ts'
import { lpFixture } from './helpers/lp.ts'
import type { Hex } from '../src/types.ts'

let f: Awaited<ReturnType<typeof lpFixture>>, guard: Hex
const artifact = readJson('artifacts/AquaGuardV2.json') as { abi: Abi; bytecode: Hex }
before(async () => { f = await lpFixture(); guard = await f.dep(artifact, [f.forwarder, f.d.router, zeroHash, zeroAddress, true]) })
after(() => f?.close())
const params = () => { const p = f.params(); p.tokens = [f.d.tokens.mWETH!, f.d.tokens.mUSDC!]; p.amounts = ['2000000000000000000', '5000000000'];
  p.program = { kind: 'concentrated', feeBps: 0, deadline: p.program.deadline, salt: p.program.salt, ...concentrationBounds(p.tokens, [18, 6], '2000', '3000') }; return p }
const caps = { maxAmount0PerSwap: 10n ** 18n, maxAmount1PerSwap: 1000_000_000n, maxPostBalance0: 3n * 10n ** 18n, maxPostBalance1: 6000_000_000n }

test('range conversion handles inverted addresses and 18/6 decimals using integer rounding', () => {
  const low = '0x0000000000000000000000000000000000000001', high = '0x0000000000000000000000000000000000000002'
  assert.deepEqual(concentrationBounds([low, high], [18, 6], '2500', '10000'), { sqrtPriceMin: '50000000000000', sqrtPriceMax: '100000000000000' })
  assert.deepEqual(concentrationBounds([high, low], [6, 18], '0.0001', '0.0004'), concentrationBounds([low, high], [18, 6], '2500', '10000'))
  assert.throws(() => concentrationBounds([low, high], [18, 6], '3000', '2000'))
  assert.throws(() => concentrationBounds([low, high], [18, 6], '0', '2000'))
  const p = params(), s = compileGuardedV2(p, guard, caps)
  if (p.program.kind !== 'concentrated') throw new Error('expected range')
  const encoded = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(p.program.sqrtPriceMin), BigInt(p.program.sqrtPriceMax)])
  assert.equal(s.order.data.slice(16, 148), '1240' + encoded.slice(2))
  assert.equal(s.order.data.slice(148, 152), '1100')
  assert.equal(s.envelope.slice(0, 4), '0x02')
  assert.throws(() => compileGuarded(p, f.guard, caps), /Guard v2/)
  assert.throws(() => compileGuardedV2({ ...p, program: { ...p.program, feeBps: 1 } }, guard, caps), /zero fee/)
  const invalid = { ...p, program: { ...p.program, sqrtPriceMax: p.program.sqrtPriceMin } }
  assert.throws(() => compile(invalid), /bounds/)
})

test('Guard v2 uses real Aqua inventory despite virtual pricing reserves; both directions and exact inventory boundaries work', async () => {
  const { ctx, d, rec } = f, s = compileGuardedV2(params(), guard, caps)
  await f.activate(s, caps); await f.submit(s, {}, caps)
  const q = await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 100_000_000n)
  assert.ok(q.amountOut > 0n)
  // The tight boundary is real inventory, far below concentration's virtual balances.
  await f.submit(s, { nonce: 2n, maxPostBalance0: s.amounts[0]! - q.amountOut, maxPostBalance1: s.amounts[1]! + q.amountIn }, caps)
  assert.equal((await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 100_000_000n)).amountOut, q.amountOut)
  await f.submit(s, { nonce: 3n, maxPostBalance1: s.amounts[1]! + q.amountIn - 1n }, caps)
  await assert.rejects(quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 100_000_000n))
  await f.submit(s, { nonce: 4n }, caps)
  await takerSwap(ctx, d, s, s.tokens[1]!, 100_000_000n, 50, rec)
  await takerSwap(ctx, d, s, s.tokens[0]!, 10n ** 16n, 50, rec)
  // The v2 gate preserves registers; its inventory check must not depend on these fake virtual reserves.
  const query = { orderHash: s.strategyHash, maker: s.params.maker, taker: ctx.taker.account.address, tokenIn: s.tokens[0], tokenOut: s.tokens[1], isExactIn: true }
  const swap = { balanceIn: 10n ** 30n, balanceOut: 10n ** 30n, amountIn: 10n ** 16n, amountOut: 1_000_000n, amountNetPulled: 0n }
  const args = [true, 42n, query, swap, s.envelope, '0x']
  assert.deepEqual(await ctx.pc.readContract({ address: guard, abi: artifact.abi, functionName: 'extruction', args, account: d.router }), [42n, 0n, swap])
  await assert.rejects(ctx.pc.call({ to: guard, data: encodeFunctionData({ abi: artifact.abi, functionName: 'extruction', args }), account: ctx.maker.account.address }))
  const replacement = params(); replacement.amounts = (await rawBalances(ctx, d, s)).map(b => String(b.balance))
  replacement.program = { ...replacement.program, ...concentrationBounds(replacement.tokens, [18, 6], '2100', '3100') }
  const next = compileGuardedV2(replacement, guard, caps)
  await send(ctx, ctx.maker, buildTx.rebalance(d, s, next), 'atomic-range-replacement', rec)
  assert.ok((await rawBalances(ctx, d, s)).every(b => b.tokensCount === 255))
  await assert.rejects(quote(ctx, d, next, next.tokens[1]!, next.tokens[0]!, 10_000_000n), 'old report must not authorize the new range')
  await f.submit(next, {}, caps)
  await takerSwap(ctx, d, next, next.tokens[1]!, 10_000_000n, 50, rec)
  await send(ctx, ctx.maker, buildTx.dock(d, next), 'dock', rec)
})

test('range exhaustion cannot spend virtual inventory and v1 addresses reject the v2 envelope', async () => {
  const { ctx, d, rec } = f, wideCaps = { maxAmount0PerSwap: 100n * 10n ** 18n, maxAmount1PerSwap: 1_000_000_000_000n, maxPostBalance0: 200n * 10n ** 18n, maxPostBalance1: 2_000_000_000_000n }
  const s = compileGuardedV2(params(), guard, wideCaps)
  await f.activate(s, wideCaps); await f.submit(s, {}, wideCaps)
  for (const [i, amount] of [[0, 10n * 10n ** 18n], [1, 25000_000_000n]] as const) await assert.rejects(quote(ctx, d, s, s.tokens[i]!, s.tokens[1 - i]!, amount))
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
  const wrong = compileGuardedV2(params(), f.guard, caps)
  await f.activate(wrong, caps); await f.submit(wrong, {}, caps)
  await assert.rejects(quote(ctx, d, wrong, wrong.tokens[1]!, wrong.tokens[0]!, 10_000_000n))
  await send(ctx, ctx.maker, buildTx.dock(d, wrong), 'dock', rec)
})


test('explicit guarded JSON recipe survives an interrupted range replacement without dropping the Guard', async () => {
  const { ctx, d } = f, p = params()
  p.guard = { address: guard, version: 2, caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, String(v)])) as NonNullable<typeof p.guard>['caps'] }
  const normalized = parseStrategy(p), s = compileExecution(normalized)
  const { guard: recipe, ...plain } = p
  assert.equal(s.strategyHash, compileGuardedV2(plain, guard, caps).strategyHash)
  const stateDir = join(f.dir, 'guarded-json')
  const opts = { stateDir, getPrices: async () => ({ source: 'synthetic ETH/USD', mode: 'simulated' as const, asOf: Number((await ctx.pc.getBlock()).timestamp),
    usdE8: { [p.tokens[0]!.toLowerCase()]: '250000000000', [p.tokens[1]!.toLowerCase()]: '100000000' } }) }
  const base = { schema: 'aqua-execution-v1', sessionId: 'range' }
  await executeRequest(ctx, d, { ...base, requestId: 'ship', action: 'ship', strategy: p,
    policy: { tokens: p.tokens, baselineAmounts: p.amounts, maxDrawdownBps: 500, maxPriceAgeSec: 60 } }, opts)
  const next = { ...p, program: { ...p.program, salt: String(BigInt(p.program.salt) + 100n) } }
  const request = { ...base, requestId: 'replace', action: 'rebalance', expectedStrategyHash: s.strategyHash, strategy: next }
  await assert.rejects(executeRequest(ctx, d, request, { ...opts, onTransaction: e => { if (e.phase === 'broadcast' && e.step === 'primary') throw new Error('interrupted') } }), /interrupted/)
  const nonce = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
  await executeRequest(ctx, d, request, opts)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonce)
  const status = await executionStatus(ctx, d, stateDir, 'range')
  assert.equal(status.strategyHash, compileExecution(next).strategyHash)
  assert.deepEqual(status.session.plan.policy.baselineAmounts, p.amounts)
  assert.deepEqual(status.session.plan.rebalances?.at(-1)?.strategy.guard, normalized.guard)
  await assert.rejects(quote(ctx, d, compileExecution(next), p.tokens[1]!, p.tokens[0]!, 10_000_000n))
  await executeRequest(ctx, d, { ...base, requestId: 'dock', action: 'dock', expectedStrategyHash: status.strategyHash }, opts)
})
