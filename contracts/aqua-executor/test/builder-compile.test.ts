import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { decodeGuardedOrder, decodeInstructions, draftSchema, orderAbi, sepoliaStandingProfile, validateStrategy, type DeploymentProfile } from '@pintool/strategy-builder'
import { encodeAbiParameters, keccak256, zeroHash, zeroAddress, type Abi } from 'viem'
import { compileBuilderStrategy } from '../src/builder-compile.ts'
import { readJson } from '../src/config.ts'
import { compileExecution } from '../src/execution-compile.ts'
import { compile } from '../src/compile.ts'
import { parseStrategy } from '../src/execution-request.ts'
import { buildTx, quote, rawBalances, send, takerSwap } from '../src/executor.ts'
import { lpFixture } from './helpers/lp.ts'
import type { GuardedCompiled } from '../src/guard.ts'
import type { Hex } from '../src/types.ts'

let f: Awaited<ReturnType<typeof lpFixture>>, guard: Hex, profile: DeploymentProfile
const guardArtifact = readJson('artifacts/AquaGuardV2.json') as { abi: Abi; bytecode: Hex }
const now = '2026-09-13T03:00:00.000Z', nowSec = Date.parse(now) / 1000
const caps = { maxAmount0PerSwap: 10n ** 18n, maxAmount1PerSwap: 1000_000_000n, maxPostBalance0: 3n * 10n ** 18n, maxPostBalance1: 6000_000_000n }
before(async () => {
  f = await lpFixture(); guard = await f.dep(guardArtifact, [f.forwarder, f.d.router, zeroHash, zeroAddress, true])
  profile = { ...sepoliaStandingProfile, id: 'local-standing-v2', chainId: 31337, router: f.d.router, aqua: f.d.aqua,
    guard, forwarder: f.forwarder, tokens: [{ address: f.d.tokens.mWETH!, symbol: 'WETH', decimals: 18 }, { address: f.d.tokens.mUSDC!, symbol: 'USDC', decimals: 6 }] }
})
after(() => f?.close())
function draft(kind: 'xyc' | 'concentrated' | 'pegged') {
  return draftSchema.parse({ schemaVersion: 1, id: `maker-${kind}`, owner: 'test-owner', revision: 1, kind: 'maker', maker: f.ctx.maker.account.address,
    allocations: { baseAtomic: '2000000000000000000', quoteAtomic: '5000000000' },
    salt: { xyc: '123001', concentrated: '123002', pegged: '123003' }[kind], createdAt: now, updatedAt: now, requirements: [],
    spec: { title: 'WETH / USDC guarded strategy', profileId: profile.id, baseToken: profile.tokens[0], quoteToken: profile.tokens[1],
      model: kind === 'xyc' ? { kind } : kind === 'concentrated' ? { kind, minPrice: '2000', maxPrice: '3000' } : { kind, referencePrice: '2500', amplification: '1' },
      feeBps: 0, deadline: 2_000_000_000,
      guardEnvelope: { maxAmountBasePerSwap: String(caps.maxAmount0PerSwap), maxAmountQuotePerSwap: String(caps.maxAmount1PerSwap),
        maxPostBalanceBase: String(caps.maxPostBalance0), maxPostBalanceQuote: String(caps.maxPostBalance1) } } })
}

for (const kind of ['xyc', 'concentrated', 'pegged'] as const) test(`Builder ${kind}: validated draft -> deterministic order -> independent decoder -> real local Aqua settlement`, async () => {
  const input = draft(kind), a = compileBuilderStrategy(input, profile, nowSec)
  assert.deepEqual(compileBuilderStrategy(JSON.parse(JSON.stringify(input)), profile, nowSec), a)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'public compiled artifacts contain JSON-safe decimal strings, not bigint')
  assert.equal(a.decoded.kind, kind)
  assert.equal(a.orderHash, a.strategyHash)
  assert.notEqual(a.programHash, a.strategyHash)
  assert.equal(a.params.guard?.version, 2)
  assert.throws(() => compile(a.params), /guard recipe/)
  const s = compileExecution(parseStrategy(a.params)) as GuardedCompiled
  assert.equal(s.strategy, a.strategy)
  assert.equal(decodeGuardedOrder(a.strategy).guard, guard.toLowerCase())
  await f.activate(s, caps)
  await assert.rejects(quote(f.ctx, f.d, s, s.tokens[1]!, s.tokens[0]!, 10_000_000n))
  await f.submit(s, { schemaVersion: 2, validUntil: 0 }, caps)
  const q = await quote(f.ctx, f.d, s, s.tokens[1]!, s.tokens[0]!, 10_000_000n)
  assert.ok(q.amountOut > 3n * 10n ** 15n && q.amountOut < 5n * 10n ** 15n, 'human 2500 USDC/WETH survives decimals and sorted rates')
  for (const [i, amount] of [[1, 10_000_000n], [0, 10n ** 15n]] as const) await takerSwap(f.ctx, f.d, s, s.tokens[i]!, amount, 100, f.rec)
  await assert.rejects(quote(f.ctx, f.d, s, s.tokens[1]!, s.tokens[0]!, caps.maxAmount1PerSwap + 1n))
  await send(f.ctx, f.ctx.maker, buildTx.dock(f.d, s), 'builder-dock', f.rec)
  assert.ok((await rawBalances(f.ctx, f.d, s)).every(b => b.tokensCount === 255))
  await assert.rejects(quote(f.ctx, f.d, s, s.tokens[1]!, s.tokens[0]!, 10_000_000n))
})

for (const kind of ['xyc', 'concentrated', 'pegged'] as const) test(`Builder ${kind}: legacy input fees bypass gross caps and must not compile`, async () => {
  const input = draft(kind), a = compileBuilderStrategy(input, profile, nowSec)
  assert.equal(validateStrategy({ ...input, spec: { ...input.spec, feeBps: 30 } }, profile, nowSec).ready, false)
  assert.throws(() => compileBuilderStrategy({ ...input, spec: { ...input.spec, feeBps: 30 } }, profile, nowSec), /zero LP fee/)
  // Recreate the old public bytecode solely to reproduce the defect. Production
  // compilers reject it. Keep the independent decoder for historical dock/revoke.
  const original = compileExecution(parseStrategy(a.params)) as GuardedCompiled
  const program = (a.program.slice(0, 16) + '1504' + (3000000).toString(16).padStart(8, '0') + a.program.slice(16)) as Hex
  const order = { ...original.order, data: program }, strategy = encodeAbiParameters(orderAbi, [order])
  const s = { ...original, order, strategy, strategyHash: keccak256(strategy) }
  assert.equal(decodeGuardedOrder(strategy).feeBps, 30)
  await f.activate(s, caps)
  for (const direction of [0, 1] as const) {
    const amount = direction === 0 ? 1000000000000001n : 2500001n
    const before = (await rawBalances(f.ctx, f.d, s)).map(b => b.balance)
    const maxPost = before[direction]! + amount - 1n
    const limits = { ...caps, [direction === 0 ? 'maxAmount0PerSwap' : 'maxAmount1PerSwap']: amount - 1n,
      [direction === 0 ? 'maxPostBalance0' : 'maxPostBalance1']: maxPost }
    await f.submit(s, { schemaVersion: 2, validUntil: 0, nonce: BigInt(direction + 1) }, limits)
    const q = await quote(f.ctx, f.d, s, s.tokens[direction]!, s.tokens[1 - direction]!, amount)
    assert.equal(q.amountIn, amount, 'legacy recipe incorrectly admits gross cap + 1')
    await takerSwap(f.ctx, f.d, s, s.tokens[direction]!, amount, 100, f.rec)
    const after = await rawBalances(f.ctx, f.d, s)
    assert.equal(after[direction]!.balance, maxPost + 1n, 'legacy recipe also exceeds post-inventory cap')
  }
  await send(f.ctx, f.ctx.maker, buildTx.dock(f.d, s), 'legacy-fee-regression-dock', f.rec)
})

test('decoder rejects unknown/reserved opcodes, branches, duplicate gates, malformed lengths and altered traits', () => {
  const a = compileBuilderStrategy(draft('xyc'), profile, nowSec)
  for (const bytes of ['0x0d', '0x0d05', '0x1600', '0xfe00'] as Hex[]) assert.throws(() => decodeInstructions(bytes))
  const encode = (data: Hex, traits = BigInt(a.order.traits)) => encodeAbiParameters(orderAbi, [{ ...a.order, data, traits }])
  assert.throws(() => decodeGuardedOrder(encode(`0x0a020000${a.program.slice(2)}`)), /recipe/)
  assert.throws(() => decodeGuardedOrder(encode(`${a.program}1100`)), /recipe/)
  assert.throws(() => decodeGuardedOrder(encode(a.program, BigInt(a.order.traits) | (1n << 252n))), /traits/)
  assert.throws(() => decodeGuardedOrder(`${a.strategy}00`), /canonical/)
  assert.throws(() => decodeGuardedOrder(encode(a.program.replace('1100', '110100') as Hex)), /length/)
})

test('validation keeps missing input, incompatible deployments, metadata spoofing and private-policy fields out of compile', () => {
  const a = draft('concentrated')
  for (const bad of [{ ...a, spec: { ...a.spec, baseToken: { ...a.spec.baseToken!, decimals: 6 } } },
    { ...a, spec: { ...a.spec, model: { kind: 'concentrated', relativeWidthBps: 500 } } },
    { ...a, spec: { ...a.spec, privatePolicy: { rules: [] } } },
    { ...a, spec: { ...a.spec, guardEnvelope: { maxAmountBasePerSwap: '1' } } },
    { ...a, allocations: { baseAtomic: '1' } },
    { ...a, allocations: { ...a.allocations!, baseAtomic: String(caps.maxPostBalance0 + 1n) } }]) {
    assert.equal(validateStrategy(bad, profile, nowSec).ready, false)
    assert.throws(() => compileBuilderStrategy(bad, profile, nowSec))
  }
  const fee = { ...a, spec: { ...a.spec, feeBps: 30 } }
  assert.equal(validateStrategy(fee, profile, nowSec).ready, false)
  assert.throws(() => compileBuilderStrategy(fee, profile, nowSec), /zero LP fee/)
  assert.throws(() => compileBuilderStrategy(a, { ...profile, swapVmCommit: 'main' }, nowSec), /Source/)
  const template = { ...a, kind: 'template', maker: undefined, allocations: undefined }
  assert.equal(validateStrategy(template, profile, nowSec).ready, true)
  assert.throws(() => compileBuilderStrategy(template, profile, nowSec), /instantiated/)
})
