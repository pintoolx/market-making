import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { join } from 'node:path'
import { encodeAbiParameters, erc20Abi } from 'viem'
import { compile, takerTraits } from '../src/compile.ts'
import { peggedArgs } from '../src/curves.ts'
import { compileGuarded } from '../src/guard.ts'
import { parseStrategy } from '../src/execution-request.ts'
import { executeRequest, executionStatus } from '../src/execution-controller.ts'
import { buildTx, quote, rawBalances, send, takerSwap, waitMined } from '../src/executor.ts'
import { lpFixture } from './helpers/lp.ts'

let f: Awaited<ReturnType<typeof lpFixture>>
before(async () => { f = await lpFixture() }); after(() => f?.close())

test('Pegged opcode 31 pins all five arguments; address reversal preserves references and decimal rates', () => {
  const p = f.params(), args = peggedArgs(p), s = compileGuarded(p, f.guard, f.caps)
  const encoded = encodeAbiParameters(Array.from({ length: 5 }, () => ({ type: 'uint256' })), [args.x0, args.y0, args.linearWidth, args.rateLt, args.rateGt])
  assert.equal(s.order.data.slice(16, 20), '1fa0')
  assert.equal(s.order.data.slice(20, 340), encoded.slice(2))
  assert.deepEqual(parseStrategy(p), { ...p, maker: p.maker.toLowerCase(), tokens: p.tokens.map(t => t.toLowerCase()) })
  assert.equal(p.program.kind, 'pegged'); if (p.program.kind !== 'pegged') return
  const reversed = { ...p, tokens: [...p.tokens].reverse(), amounts: [...p.amounts].reverse(), program: { ...p.program,
    referenceBalances: [...p.program.referenceBalances].reverse() as [string, string], rates: [...p.program.rates].reverse() as [string, string] } }
  assert.deepEqual(peggedArgs(reversed), args)
  assert.equal(compile(reversed).order.data, compile(p).order.data)
  for (const patch of [{ rates: ['0', '1'] }, { linearWidth: String(5001n * 10n ** 27n) }, { referenceBalances: ['1'] }, { unexpected: true }]) {
    assert.throws(() => parseStrategy({ ...p, program: { ...p.program, ...patch } }))
  }
  assert.throws(() => compile(s.params), /specialized strategy/)
})

test('Pegged Guard executes both decimal directions, enforces a tighter inventory report and atomically reverts disabled trades', async () => {
  const { ctx, d, rec } = f, s = compileGuarded(f.params(), f.guard, f.caps)
  await f.activate(s); await assert.rejects(quote(ctx, d, s, s.tokens[0]!, s.tokens[1]!, 10_000_000n))
  await f.submit(s)
  const q = await quote(ctx, d, s, s.tokens[0]!, s.tokens[1]!, 10_000_000n)
  assert.ok(q.amountOut > 9n * 10n ** 18n && q.amountOut < 10n * 10n ** 18n)
  await takerSwap(ctx, d, s, s.tokens[0]!, 10_000_000n, 10, rec)
  await takerSwap(ctx, d, s, s.tokens[1]!, 10n ** 18n, 10, rec)
  const real = await rawBalances(ctx, d, s)
  await f.submit(s, { nonce: 2n, maxPostBalance0: real[0]!.balance })
  await assert.rejects(quote(ctx, d, s, s.tokens[0]!, s.tokens[1]!, 10_000_000n))
  await f.submit(s, { nonce: 3n, allowedDirections: 0 })
  const before = await Promise.all(s.tokens.map(address => ctx.pc.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.maker.account.address] })))
  const r = await waitMined(ctx, await ctx.taker.sendTransaction({ ...buildTx.swap(d, s, s.tokens[0]!, s.tokens[1]!, 10_000_000n, takerTraits(0n)), gas: 700_000n }))
  assert.equal(r.status, 'reverted')
  assert.deepEqual(await rawBalances(ctx, d, s), real)
  assert.deepEqual(await Promise.all(s.tokens.map(address => ctx.pc.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.maker.account.address] }))), before)
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
})

test('fee-bearing Pegged JSON ships, retries idempotently, swaps, atomically rebalances and preserves the original HODL baseline', async () => {
  const { ctx, d } = f, strategy = f.params(); strategy.program.feeBps = 5
  const stateDir = join(f.dir, 'pegged-json')
  const opts = { stateDir, getPrices: async () => ({ source: 'synthetic stable pair', mode: 'simulated' as const, asOf: Number((await ctx.pc.getBlock()).timestamp), usdE8: Object.fromEntries(strategy.tokens.map(t => [t.toLowerCase(), '100000000'])) }) }
  const base = { schema: 'aqua-execution-v1', sessionId: 'peg' }
  const ship = { ...base, requestId: 'peg-ship', action: 'ship', strategy, policy: { tokens: strategy.tokens, baselineAmounts: strategy.amounts, maxDrawdownBps: 500, maxPriceAgeSec: 60 } }
  await executeRequest(ctx, d, ship, opts)
  const nonce = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
  await executeRequest(ctx, d, ship, opts)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonce)
  const s = compile(strategy)
  await executeRequest(ctx, d, { ...base, requestId: 'peg-swap', action: 'swap', expectedStrategyHash: s.strategyHash, tokenIn: s.tokens[0], amountIn: '10000000', slippageBps: 50 }, opts)
  const replacement = f.params(); replacement.amounts = (await rawBalances(ctx, d, s)).map(b => String(b.balance))
  await executeRequest(ctx, d, { ...base, requestId: 'peg-replace', action: 'rebalance', expectedStrategyHash: s.strategyHash, strategy: replacement }, opts)
  assert.deepEqual((await executionStatus(ctx, d, stateDir, 'peg')).session?.plan.policy.baselineAmounts, strategy.amounts)
  assert.ok((await rawBalances(ctx, d, s)).every(b => b.tokensCount === 255))
  await executeRequest(ctx, d, { ...base, requestId: 'peg-dock', action: 'dock', expectedStrategyHash: compile(replacement).strategyHash }, opts)
})
