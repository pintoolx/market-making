import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { BaseError, createTestClient, decodeAbiParameters, decodeErrorResult, encodeFunctionData, encodePacked, erc20Abi, http, keccak256, toFunctionSelector, zeroAddress, zeroHash, type Abi } from 'viem'
import { foundry } from 'viem/chains'
import { ANVIL_KEYS, connect, type Ctx } from '../src/config.ts'
import { compileGuarded, encodeGuardReport, guardArtifact, guardReportAbi, guardTestForwarderArtifact, buildTestReportTx, type GuardCaps, type GuardReport, type GuardedCompiled } from '../src/guard.ts'
import { buildTx, quote, rawBalances, send, takerSwap, waitMined, type TxRequest } from '../src/executor.ts'
import { compile, takerTraits } from '../src/compile.ts'
import { parseStrategy } from '../src/execution-request.ts'
import { runGuardDemo } from '../src/guard-demo.ts'
import { deploy } from '../src/deploy.ts'
import { recorder } from '../src/records.ts'
import type { AquaStrategyParams, Deployment, Hex } from '../src/types.ts'

const dir = mkdtempSync(join(tmpdir(), 'aqua-guard-'))
let ctx: Ctx, d: Deployment, anvil: ChildProcess, forwarder: Hex, guard: Hex, rpc: string
const rec = recorder({ dir, runId: 'guard', chainId: 31337, explorer: null })
const caps: GuardCaps = { maxAmount0PerSwap: 10n ** 18n, maxAmount1PerSwap: 1_000_000_000n, maxPostBalance0: 3n * 10n ** 18n, maxPostBalance1: 7_000_000_000n }
const workflowId = `0x${'ab'.repeat(32)}` as Hex
let salt = 1000

async function dep(artifact: { abi: Abi; bytecode: Hex }, args: unknown[]) {
  const r = await waitMined(ctx, await ctx.maker.deployContract({ ...artifact, args }))
  assert.equal(r.status, 'success'); assert.ok(r.contractAddress)
  return r.contractAddress
}
before(async () => {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  rpc = `http://127.0.0.1:${port}`
  anvil = spawn(process.env.ANVIL ?? 'anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' })
  let failed: Error | undefined; anvil.on('error', e => { failed = e })
  ctx = connect(foundry, rpc, ANVIL_KEYS[0], ANVIL_KEYS[1])
  for (let i = 0; ; i++) {
    if (failed) throw failed
    try { await ctx.pc.getBlockNumber(); break } catch (e) { if (i > 20) throw e; await sleep(100) }
  }
  d = await deploy(ctx, rec)
  forwarder = await dep(guardTestForwarderArtifact, [])
  guard = await dep(guardArtifact, [forwarder, d.router, workflowId, ctx.maker.account.address, false])
})
after(() => anvil?.kill())

function params(): AquaStrategyParams {
  return { schema: 'aqua-swapvm-v1.0.2', chainId: 31337, maker: ctx.maker.account.address,
    tokens: [d.tokens.mWETH!, d.tokens.mUSDC!], amounts: ['2000000000000000000', '5000000000'],
    program: { kind: 'xyc', feeBps: 0, deadline: 2_000_000_000, salt: String(salt++) },
    meta: { producer: 'fixed-params', strategyVersion: 1, paramsRevision: 1 } }
}
const metadata = (id = workflowId, owner = ctx.maker.account.address) =>
  encodePacked(['bytes32', 'bytes10', 'address', 'bytes2'], [id, '0x0102030405060708090a', owner, '0x1234'])
async function report(s: GuardedCompiled, patch: Partial<GuardReport> = {}): Promise<GuardReport> {
  const now = Number((await ctx.pc.getBlock()).timestamp)
  return { schemaVersion: 1, chainId: 31337n, guard: s.guard, router: d.router, maker: s.params.maker,
    strategyHash: s.strategyHash, token0: s.tokens[0]!, token1: s.tokens[1]!, nonce: 1n,
    validAfter: now, validUntil: now + 600, allowedDirections: 3, ...caps, ...patch }
}
async function submit(r: GuardReport, meta = metadata()) {
  return send(ctx, ctx.maker, buildTestReportTx(forwarder, r.guard, r, meta), 'report', rec)
}
async function stored(s: GuardedCompiled) {
  return ctx.pc.readContract({ address: s.guard, abi: guardArtifact.abi, functionName: 'getReport', args: [s.params.maker, s.strategyHash] }) as Promise<[GuardReport, Hex]>
}
async function expectError(req: TxRequest, expected: string, account = ctx.maker.account.address) {
  await assert.rejects(ctx.pc.call({ ...req, account }), (error: unknown) => {
    assert.ok(error instanceof BaseError)
    const cause = error.walk(x => typeof (x as { data?: unknown }).data === 'string') as unknown as { data: Hex }
    assert.ok(cause?.data, `missing revert data for ${expected}`)
    assert.equal(decodeErrorResult({ abi: guardArtifact.abi, data: cause.data }).errorName, expected)
    return true
  })
}
async function activate(s: GuardedCompiled) {
  for (const [i, token] of s.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, i === 0 ? caps.maxPostBalance0 : caps.maxPostBalance1), 'approve', rec)
  await send(ctx, ctx.maker, buildTx.ship(d, s), 'ship', rec)
}
const swapRequest = (s: GuardedCompiled, amount = 100_000_000n, reverse = false) => buildTx.swap(d, s,
  s.tokens[reverse ? 0 : 1]!, s.tokens[reverse ? 1 : 0]!, amount, takerTraits(0n))

test('Guard report encoding matches the shared fixture and the Solidity tuple', () => {
  const fixture = JSON.parse(readFileSync(new URL('fixtures/guard-report-v1.json', import.meta.url), 'utf8'))
  const tuple = Object.fromEntries(guardReportAbi[0].components.map(({ name, type }) => [name,
    type.startsWith('uint') ? Number(type.slice(4)) > 48 ? BigInt(fixture.report[name]) : Number(fixture.report[name]) : fixture.report[name]])) as unknown as GuardReport
  assert.equal(encodeGuardReport(tuple), fixture.encodedReport)
  assert.equal(keccak256(encodeGuardReport(tuple)), fixture.reportHash)
  assert.equal((encodeGuardReport(tuple).length - 2) / 2, 512)
  const [decoded] = decodeAbiParameters(guardReportAbi, fixture.encodedReport)
  assert.deepEqual(decoded, tuple)
  const getter = guardArtifact.abi.find(x => x.type === 'function' && x.name === 'getReport') as unknown as { outputs: { components: unknown }[] }
  assert.deepEqual(JSON.parse(JSON.stringify(getter.outputs[0]!.components, (k, v) => k === 'internalType' ? undefined : v)), guardReportAbi[0].components)
})

test('Guard compiler pins the complete v1.0.2 program, binds caps, and excludes fees', () => {
  const p = params(), s = compileGuarded(p, guard, caps)
  const hex = (n: bigint | number, bytes: number) => n.toString(16).padStart(bytes * 2, '0')
  const envelope = '01' + p.tokens.map(t => t.slice(2).toLowerCase()).join('') + Object.values(caps).map(n => hex(n, 16)).join('')
  assert.equal(s.envelope, `0x${envelope}`)
  assert.equal(s.order.data, `0x0d05${hex(p.program.deadline, 5)}11001408${hex(BigInt(p.program.salt), 8)}207d${guard.slice(2).toLowerCase()}${envelope}`)
  assert.equal(s.order.traits, 1n << 254n)
  assert.throws(() => parseStrategy(s.params), /unknown fields: executionTemplate/)
  assert.throws(() => compile(s.params), /legacy compile cannot reconstruct its guard/)
  assert.notEqual(compileGuarded(p, guard, { ...caps, maxAmount0PerSwap: caps.maxAmount0PerSwap - 1n }).strategyHash, s.strategyHash)
  assert.throws(() => compileGuarded({ ...p, program: { ...p.program, feeBps: 30 } }, guard, caps), /zero fee/)
  assert.throws(() => compileGuarded(p, guard, { ...caps, maxAmount0PerSwap: 1n << 128n }), /uint128/)
  assert.throws(() => compileGuarded(p, guard, { ...caps, maxPostBalance1: 1n }), /initial inventory/)
  assert.throws(() => compileGuarded(p, zeroAddress, caps), /nonzero/)
})

test('Guard authenticates forwarder/production identity, rejects malformed reports, and implements ERC165', async () => {
  const s = compileGuarded(params(), guard, caps), r = await report(s)
  assert.equal(await ctx.pc.readContract({ address: guard, abi: guardArtifact.abi, functionName: 'supportsInterface', args: [toFunctionSelector('onReport(bytes,bytes)')] }), true)
  assert.equal(await ctx.pc.readContract({ address: guard, abi: guardArtifact.abi, functionName: 'supportsInterface', args: ['0xffffffff'] }), false)
  await expectError({ to: guard, data: encodeFunctionData({ abi: guardArtifact.abi, functionName: 'onReport', args: [metadata(), encodeGuardReport(r)] }) }, 'UnauthorizedForwarder')
  for (const meta of [metadata(zeroHash), metadata(workflowId, ctx.taker.account.address)]) await expectError(buildTestReportTx(forwarder, guard, r, meta), 'UnauthorizedWorkflow')
  for (const meta of ['0x', metadata().slice(0, -4)] as Hex[]) await expectError(buildTestReportTx(forwarder, guard, r, meta), 'InvalidMetadata')
  for (const patch of [{ schemaVersion: 2 }, { token1: r.token0 }, { nonce: 0n }, { allowedDirections: 4 }, { maxAmount0PerSwap: 0n }, { maker: zeroAddress }]) {
    await expectError(buildTestReportTx(forwarder, guard, { ...r, ...patch }, metadata()), 'InvalidReport')
  }
  for (const patch of [{ chainId: 84532n }, { guard: forwarder }, { router: forwarder }]) await expectError(buildTestReportTx(forwarder, guard, { ...r, ...patch }, metadata()), 'InvalidReportDomain')
  for (const payload of [encodeGuardReport(r) + '00', encodeGuardReport(r).slice(0, -2)] as Hex[]) {
    await expectError({ to: forwarder, data: encodeFunctionData({ abi: guardTestForwarderArtifact.abi, functionName: 'forward', args: [guard, metadata(), payload] }) }, 'InvalidReport')
  }
  assert.equal((await stored(s))[0].nonce, 0n)
  const receipt = await submit(r); assert.equal(receipt.logs.length, 1)
  assert.equal((await stored(s))[1], keccak256(encodeGuardReport(r)))
})

test('Guard accepts identical retry once and preserves current state on replay or bad lifetime', async () => {
  const s = compileGuarded(params(), guard, caps), r = await report(s, { nonce: 2n })
  await submit(r); assert.equal((await submit(r)).logs.length, 0)
  for (const patch of [{ nonce: 1n }, { allowedDirections: 0 }]) await expectError(buildTestReportTx(forwarder, guard, { ...r, ...patch }, metadata()), 'ReportReplay')
  const now = Number((await ctx.pc.getBlock()).timestamp)
  for (const patch of [{ validAfter: now + 100 }, { validUntil: now }, { validAfter: now - 601, validUntil: now + 1 }]) {
    await expectError(buildTestReportTx(forwarder, guard, { ...r, nonce: 3n, ...patch }, metadata()), 'ReportNotCurrent')
  }
  assert.equal((await stored(s))[1], keccak256(encodeGuardReport(r)))
})

test('actual Aqua swaps honor reports in both directions; report updates invalidate previous quotes', async () => {
  const s = compileGuarded(params(), guard, caps), r = await report(s)
  await activate(s)
  await expectError(swapRequest(s), 'MissingReport', ctx.taker.account.address)
  await submit(r)
  const snapshot = await stored(s)
  const before = (await rawBalances(ctx, d, s)).map(b => b.balance)
  const q = await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 100_000_000n)
  assert.deepEqual(await stored(s), snapshot, 'quote must not consume a report')
  const swap = await takerSwap(ctx, d, s, s.tokens[1]!, 100_000_000n, 50, rec)
  assert.equal(swap.amountOut, q.amountOut)
  assert.deepEqual((await rawBalances(ctx, d, s)).map(b => b.balance), [before[0]! - swap.amountOut, before[1]! + swap.amountIn])
  assert.ok((await takerSwap(ctx, d, s, s.tokens[0]!, 10n ** 16n, 50, rec)).amountOut > 0n)
  await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 100_000_000n)
  await submit({ ...r, nonce: 2n, allowedDirections: 1 })
  await expectError(swapRequest(s), 'DirectionDisabled', ctx.taker.account.address)
  const balances = await Promise.all(s.tokens.flatMap(token => [ctx.maker, ctx.taker].map(w => ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [w.account.address] }))))
  // Intentionally send one rejected transaction with explicit gas, bypassing the normal preflight.
  const reverted = await waitMined(ctx, await ctx.taker.sendTransaction({ ...swapRequest(s), gas: 500_000n }))
  assert.equal(reverted.status, 'reverted'); assert.equal(reverted.logs.length, 0)
  assert.deepEqual(await Promise.all(s.tokens.flatMap(token => [ctx.maker, ctx.taker].map(w => ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [w.account.address] })))), balances)
  assert.ok((await takerSwap(ctx, d, s, s.tokens[0]!, 10n ** 16n, 50, rec)).amountOut > 0n)
  await submit({ ...r, nonce: 3n, allowedDirections: 0 })
  await expectError(swapRequest(s, 10n ** 16n, true), 'DirectionDisabled', ctx.taker.account.address)
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
})

test('Guard checks exact per-token amount and inventory boundaries and clamps report loosening', async () => {
  const s = compileGuarded(params(), guard, caps), r = await report(s)
  await activate(s); await submit(r)
  const amount = 100_000_000n
  const q = await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, amount)
  const tight: GuardReport = { ...r, nonce: 2n, maxAmount0PerSwap: q.amountOut, maxAmount1PerSwap: amount,
    maxPostBalance0: s.amounts[0]! - q.amountOut, maxPostBalance1: s.amounts[1]! + amount }
  await submit(tight)
  assert.equal((await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, amount)).amountOut, q.amountOut)
  let nonce = 3n
  for (const key of ['maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1'] as const) {
    await submit({ ...tight, nonce: nonce++, [key]: tight[key] - 1n })
    await expectError(swapRequest(s, amount), key.startsWith('maxAmount') ? 'AmountLimitExceeded' : 'InventoryLimitExceeded', ctx.taker.account.address)
  }
  await submit({ ...r, nonce: nonce++, maxAmount1PerSwap: caps.maxAmount1PerSwap + 100n })
  await expectError(swapRequest(s, caps.maxAmount1PerSwap + 1n), 'AmountLimitExceeded', ctx.taker.account.address)
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
})

test('Guard isolates makers/hashes and rejects incorrect report pair and exact-output swaps', async () => {
  const s = compileGuarded(params(), guard, caps), r = await report(s)
  await activate(s)
  await submit({ ...r, maker: ctx.taker.account.address })
  await expectError(swapRequest(s), 'MissingReport', ctx.taker.account.address)
  await submit({ ...r, strategyHash: workflowId })
  await expectError(swapRequest(s), 'MissingReport', ctx.taker.account.address)
  await submit({ ...r, token0: r.token1, token1: r.token0 })
  await expectError(swapRequest(s), 'TokenPairMismatch', ctx.taker.account.address)
  await submit({ ...r, nonce: 2n })
  const S = createRequire(import.meta.url)('@1inch/swap-vm-sdk')
  const exactOut: Hex = S.TakerTraits.new({ exactIn: false, useTransferFromAndAquaPush: true }).encode().toString()
  await expectError(buildTx.swap(d, s, s.tokens[1]!, s.tokens[0]!, 10n ** 15n, exactOut), 'UnsupportedSwap', ctx.taker.account.address)
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
})

test('Guard clamps both post-inventory envelope limits even if the report permits more', async () => {
  const envelope = { ...caps, maxPostBalance0: 2n * 10n ** 18n, maxPostBalance1: 5_000_000_000n }
  const s = compileGuarded(params(), guard, envelope), r = await report(s)
  await activate(s); await submit(r)
  await expectError(swapRequest(s, 100_000_000n), 'InventoryLimitExceeded', ctx.taker.account.address)
  await expectError(swapRequest(s, 10n ** 16n, true), 'InventoryLimitExceeded', ctx.taker.account.address)
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
})

test('Guard rejects direct callers and malformed envelopes; valid checks preserve all VM registers', async () => {
  const s = compileGuarded(params(), guard, caps), r = await report(s)
  await submit(r)
  const query = { orderHash: s.strategyHash, maker: s.params.maker, taker: ctx.taker.account.address, tokenIn: s.tokens[0], tokenOut: s.tokens[1], isExactIn: true }
  const swap = { balanceIn: 2n * 10n ** 18n, balanceOut: 5_000_000_000n, amountIn: 10n ** 16n, amountOut: 24_875_621n, amountNetPulled: 0n }
  const req = (envelope: Hex, patch = {}) => ({ to: guard, data: encodeFunctionData({ abi: guardArtifact.abi, functionName: 'extruction', args: [true, 146n, query, { ...swap, ...patch }, envelope, '0x'] }) })
  await expectError(req(s.envelope), 'UnauthorizedRouter')
  for (const envelope of ['0x', s.envelope + '00', '0x02' + s.envelope.slice(4)] as Hex[]) await expectError(req(envelope), 'InvalidEnvelope', d.router)
  await expectError(req(s.envelope, { amountNetPulled: 1n }), 'UnsupportedSwap', d.router)
  const value = await ctx.pc.readContract({ address: guard, abi: guardArtifact.abi, functionName: 'extruction', args: [false, 146n, query, swap, s.envelope, '0xabcd'], account: d.router })
  assert.deepEqual(value, [146n, 0n, swap])
})

test('simulation uses a separate immutable profile; expiry stops both directions and retry cannot revive it', async () => {
  const sim = await dep(guardArtifact, [forwarder, d.router, zeroHash, zeroAddress, true])
  const s = compileGuarded(params(), sim, caps), r = await report(s, { validUntil: Number((await ctx.pc.getBlock()).timestamp) + 100 })
  await activate(s); await submit(r, '0x')
  const tc = createTestClient({ chain: foundry, mode: 'anvil', transport: http(rpc) })
  const snapshot = await tc.snapshot()
  try {
    await tc.setNextBlockTimestamp({ timestamp: BigInt(r.validUntil) }); await tc.mine({ blocks: 1 })
    await expectError(swapRequest(s), 'ReportNotCurrent', ctx.taker.account.address)
    await expectError(swapRequest(s, 10n ** 16n, true), 'ReportNotCurrent', ctx.taker.account.address)
    await expectError(buildTestReportTx(forwarder, sim, r), 'ReportNotCurrent')
  } finally { await tc.revert({ id: snapshot }) }
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec)
})

test('complete synthetic-report demo records successful transfers and one mined Guard rejection, then cleans up', async () => {
  for (const token of [d.tokens.mWETH!, d.tokens.mUSDC!]) {
    await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, 0n), 'reset-test-allowance', rec)
    await send(ctx, ctx.taker, buildTx.approve(token, d.router, 0n), 'reset-test-allowance', rec)
  }
  const result = await runGuardDemo(ctx, d, dir)
  assert.equal(result.swaps.length, 3)
  assert.equal(result.reportHashes.length, 3)
  assert.ok(result.finalState.every(b => b.balance === 0n && b.tokensCount === 255))
  const lines = readFileSync(result.file, 'utf8').trim().split('\n').map(s => JSON.parse(s))
  assert.equal(lines.filter(l => l.kind === 'execution' && l.status === 'reverted').length, 1)
  assert.equal(lines.at(-1).status, 'completed')
  for (const token of [d.tokens.mWETH!, d.tokens.mUSDC!]) for (const [wallet, spender] of [[ctx.maker, d.aqua], [ctx.taker, d.router]] as const) {
    assert.equal(await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, spender] }), 0n)
  }
})
