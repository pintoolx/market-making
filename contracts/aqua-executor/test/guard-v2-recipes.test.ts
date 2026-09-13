import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { encodeFunctionData, erc20Abi, zeroAddress, zeroHash, type Abi } from 'viem'
import { compile, takerTraits } from '../src/compile.ts'
import { readJson } from '../src/config.ts'
import { compileExecution } from '../src/execution-compile.ts'
import { parseStrategy } from '../src/execution-request.ts'
import { buildTx, quote, rawBalances, send, takerSwap, waitMined } from '../src/executor.ts'
import { compileGuardedV2 } from '../src/guard.ts'
import type { Hex } from '../src/types.ts'
import { lpFixture } from './helpers/lp.ts'

let f: Awaited<ReturnType<typeof lpFixture>>, guard: Hex
const artifact = readJson('artifacts/AquaGuardV2.json') as { abi: Abi; bytecode: Hex }
before(async () => {
  f = await lpFixture()
  guard = await f.dep(artifact, [f.forwarder, f.d.router, zeroHash, zeroAddress, true])
})
after(() => f?.close())

for (const kind of ['xyc', 'pegged'] as const) test(`${kind} V2 recipe: JSON, standing authorization, both directions, actual inventory and durable revocation`, async () => {
  const { ctx, d, caps, rec } = f
  const p = f.params()
  if (kind === 'xyc') p.program = { kind, feeBps: 0, salt: p.program.salt, deadline: p.program.deadline }
  const s = compileGuardedV2(p, guard, caps)
  assert.equal(s.params.executionTemplate, `guarded-${kind}-v2`)
  assert.equal(s.envelope.slice(0, 4), '0x02')
  assert.throws(() => compile(s.params), /specialized strategy/)
  const explicit = { ...p, guard: { address: guard, version: 2,
    caps: Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, String(value)])) } }
  assert.equal(compileExecution(parseStrategy(explicit)).strategy, s.strategy)
  assert.throws(() => parseStrategy({ ...explicit, guard: { ...explicit.guard, caps: { ...explicit.guard.caps, maxPostBalance0: '1' } } }), /inventory/)
  const fee = compileGuardedV2({ ...p, program: { ...p.program, feeBps: 1 } }, guard, caps)
  assert.equal(fee.params.program.feeBps, 1)
  assert.equal(fee.envelope.slice(0, 4), '0x02')

  await f.activate(s)
  await assert.rejects(quote(ctx, d, s, s.tokens[0]!, s.tokens[1]!, 10_000_000n))
  const report = { schemaVersion: 2, validUntil: 0 }
  await f.submit(s, report)
  for (const [i, amount] of [[0, 10_000_000n], [1, 10n ** 18n]] as const) {
    await takerSwap(ctx, d, s, s.tokens[i]!, amount, 50, rec)
  }
  const balances = await rawBalances(ctx, d, s)
  const q = await quote(ctx, d, s, s.tokens[0]!, s.tokens[1]!, 10_000_000n)
  await f.submit(s, { ...report, nonce: 2n, maxPostBalance0: balances[0]!.balance + q.amountIn,
    maxPostBalance1: balances[1]!.balance - q.amountOut })
  assert.equal((await quote(ctx, d, s, s.tokens[0]!, s.tokens[1]!, q.amountIn)).amountOut, q.amountOut)
  await f.submit(s, { ...report, nonce: 3n, maxPostBalance0: balances[0]!.balance + q.amountIn - 1n })
  await assert.rejects(quote(ctx, d, s, s.tokens[0]!, s.tokens[1]!, q.amountIn))
  await f.submit(s, { ...report, nonce: 4n, allowedDirections: 2 }) // Maker may sell token0 only.
  const wallet = () => Promise.all(s.tokens.map(address => ctx.pc.readContract({ address, abi: erc20Abi,
    functionName: 'balanceOf', args: [ctx.maker.account.address] })))
  const before = await wallet()
  await send(ctx, ctx.taker, buildTx.approve(s.tokens[0]!, d.router, 10_000_000n), 'approve-rejected-trade', rec)
  const receipt = await waitMined(ctx, await ctx.taker.sendTransaction({
    ...buildTx.swap(d, s, s.tokens[0]!, s.tokens[1]!, 10_000_000n, takerTraits(0n)), gas: 700_000n,
  }))
  assert.equal(receipt.status, 'reverted')
  assert.equal(receipt.logs.length, 0)
  assert.deepEqual(await wallet(), before)
  assert.deepEqual(await rawBalances(ctx, d, s), balances)
  await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 10n ** 18n)

  await send(ctx, ctx.maker, { to: guard, data: encodeFunctionData({ abi: artifact.abi,
    functionName: 'setStrategyRevoked', args: [s.strategyHash, true] }) }, 'revoke', rec)
  await assert.rejects(f.submit(s, { ...report, nonce: 5n }))
  await assert.rejects(quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 10n ** 18n))
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
  assert.ok((await rawBalances(ctx, d, s)).every(b => b.tokensCount === 255))
})
