import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { ContractFunctionRevertedError, createTestClient, erc20Abi, http } from 'viem'
import { foundry } from 'viem/chains'
import { compile } from '../src/compile.ts'
import { ANVIL_KEYS, connect, readJson, type Ctx } from '../src/config.ts'
import { deploy } from '../src/deploy.ts'
import { executeRequest, executionStatus, watchExecution, type ExecutionResult } from '../src/execution-controller.ts'
import { ExecutionBusyError, ExecutionStore } from '../src/execution-store.ts'
import type { SavedTransaction } from '../src/durable-send.ts'
import { rawBalances } from '../src/executor.ts'
import { fixedParams } from '../src/fixed-params.ts'
import { recorder } from '../src/records.ts'
import type { PriceSnapshot } from '../src/risk.ts'
import type { Deployment } from '../src/types.ts'

const dir = mkdtempSync(join(tmpdir(), 'aqua-recovery-'))
const deploymentFile = join(dir, 'deployment.json'), priceFile = join(dir, 'prices.json')
let rpc: string, ctx: Ctx, d: Deployment, anvil: ChildProcess
const children = new Set<ChildProcess>()

before(async () => {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  rpc = `http://127.0.0.1:${port}`
  anvil = spawn(process.env.ANVIL ?? 'anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' })
  ctx = connect(foundry, rpc, ANVIL_KEYS[0], ANVIL_KEYS[1])
  for (let i = 0; ; i++) {
    try { await ctx.pc.getChainId(); break } catch (e) { if (i > 50) throw e; await sleep(100) }
  }
  d = await deploy(ctx, recorder({ dir, runId: 'deploy', chainId: 31337, explorer: null }))
  writeFileSync(deploymentFile, JSON.stringify(d))
})
after(() => { for (const child of children) child.kill('SIGKILL'); anvil?.kill() })

const prices = (eth = '250000000000'): PriceSnapshot => ({
  source: 'explicit recovery test fixture', mode: 'simulated', asOf: Math.floor(Date.now() / 1000),
  usdE8: { [d.tokens.mWETH!]: eth, [d.tokens.mUSDC!]: '100000000' },
})
const writePrices = (eth?: string) => writeFileSync(priceFile, JSON.stringify(prices(eth)))
const params = async (salt: bigint, revision = 1, amounts?: bigint[]) => {
  const p = await fixedParams(ctx, d, readJson('params/fixed.json'), { revision, salt, amounts, feeBps: revision === 1 ? 30 : 50 })
  p.meta.producer = 'tee'
  return p
}
const shipRequest = async (id: string, salt: bigint) => {
  const strategy = await params(salt)
  return { schema: 'aqua-execution-v1', requestId: `${id}-ship`, sessionId: id, action: 'ship', strategy,
    policy: { tokens: strategy.tokens, baselineAmounts: strategy.amounts, maxDrawdownBps: 100, maxPriceAgeSec: 60 } }
}
const inspectTxs = (stateDir: string) => { const store = new ExecutionStore(stateDir); try { return store.all<SavedTransaction>('txs') } finally { store.close() } }
const writeRequest = (r: { requestId: string }) => { const file = join(dir, `${r.requestId}.json`); writeFileSync(file, JSON.stringify(r)); return file }
const childExit = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
  let stdout = '', stderr = ''
  child.stdout?.on('data', b => { stdout += b })
  child.stderr?.on('data', b => { stderr += b })
  child.on('error', reject)
  child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }) })
})
const worker = (request: { requestId: string }, stateDir: string, phase: string, step: string, hold = '') => {
  const child = spawn(process.execPath, ['test/helpers/execution-worker.ts', rpc, deploymentFile, writeRequest(request), priceFile, stateDir, phase, step, hold], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  return child
}
const crash = async (r: { requestId: string }, stateDir: string, phase: string, step = 'primary') => {
  writePrices()
  const out = await childExit(worker(r, stateDir, phase, step))
  assert.equal(out.signal, 'SIGKILL', out.stderr)
}
const cli = async <T extends { requestId: string }>(r: T, stateDir: string): Promise<ExecutionResult> => {
  const child = spawn(process.execPath, ['src/execute-cli.ts', '--network', 'local', '--deployment', deploymentFile, '--request', writeRequest(r), '--state-dir', stateDir, '--prices', priceFile], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOCAL_RPC_URL: rpc },
  })
  children.add(child)
  const out = await childExit(child)
  assert.equal(out.code, 0, out.stderr)
  return JSON.parse(out.stdout)
}

test('JSON requests survive SIGKILL across ship, swap, rebalance and risk-dock without duplicate transactions', { timeout: 60000 }, async () => {
  const stateDir = join(dir, 'flow'), ship = await shipRequest('recovery-flow', 1000n)
  const s1 = compile(ship.strategy)
  await crash(ship, stateDir, 'broadcast')
  const preparedShip = inspectTxs(stateDir).find(t => t.step === 'primary')!
  assert.equal(preparedShip.receipt, undefined, 'broadcast occurred before receipt persistence')
  assert.ok((await rawBalances(ctx, d, s1)).every(b => b.tokensCount === 2))
  const makerNonce = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
  const shipped = await cli(ship, stateDir)
  assert.equal(shipped.outcome, 'shipped')
  assert.equal(shipped.transactions.find(t => t.step === 'primary')!.hash, preparedShip.hash)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), makerNonce)
  const opts = { stateDir, getPrices: async () => prices() }
  assert.deepEqual(await executeRequest(ctx, d, Object.fromEntries(Object.entries(ship).reverse()), opts), shipped)
  await assert.rejects(executeRequest(ctx, d, { ...ship, strategy: { ...ship.strategy, program: { ...ship.strategy.program, feeBps: 99 } } }, opts), /different request content/)
  await assert.rejects(executeRequest(ctx, d, { ...ship, requestId: 'different-ship' }, opts), /sessionId already exists/)
  const invalid = await shipRequest('invalid-chain', 1001n); invalid.strategy.chainId = 84532
  // Validate the maker/network guard in a separate empty journal before any transaction is accepted.
  await assert.rejects(executeRequest(ctx, d, invalid, { ...opts, stateDir: join(dir, 'invalid') }), /chain\/maker mismatch/)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), makerNonce)

  const swap = { schema: 'aqua-execution-v1', requestId: 'recovery-swap', sessionId: ship.sessionId, action: 'swap', expectedStrategyHash: s1.strategyHash, tokenIn: s1.tokens[1], amountIn: '100000000', slippageBps: 50 }
  const inventoryBefore = await rawBalances(ctx, d, s1)
  await crash(swap, stateDir, 'prepared')
  const savedSwap = inspectTxs(stateDir).find(t => t.requestId === swap.requestId && t.step === 'primary')!
  assert.deepEqual(await rawBalances(ctx, d, s1), inventoryBefore, 'prepared transaction has not been sent')
  const swapped = await cli(swap, stateDir)
  assert.equal(swapped.outcome, 'swapped')
  assert.equal(swapped.transactions.find(t => t.step === 'primary')!.hash, savedSwap.hash)
  const takerNonce = await ctx.pc.getTransactionCount({ address: ctx.taker.account.address })
  assert.deepEqual(await executeRequest(ctx, d, swap, opts), swapped)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.taker.account.address }), takerNonce)

  const inventory = (await rawBalances(ctx, d, s1)).map(b => b.balance)
  const s2 = compile(await params(1002n, 2, inventory))
  const rebalance = { schema: 'aqua-execution-v1', requestId: 'recovery-rebalance', sessionId: ship.sessionId, action: 'rebalance', expectedStrategyHash: s1.strategyHash, strategy: s2.params }
  await crash(rebalance, stateDir, 'broadcast')
  assert.ok((await rawBalances(ctx, d, s1)).every(b => b.tokensCount === 255))
  assert.ok((await rawBalances(ctx, d, s2)).every(b => b.tokensCount === 2))
  assert.equal((await executionStatus(ctx, d, stateDir, ship.sessionId)).strategyHash, s1.strategyHash, 'journal transition was not saved before the crash')
  const rebalanced = await cli(rebalance, stateDir)
  assert.equal(rebalanced.strategyHash, s2.strategyHash)
  assert.equal(rebalanced.plan.rebalances!.length, 1)
  assert.deepEqual(rebalanced.plan.policy.baselineAmounts, ship.policy.baselineAmounts)
  assert.notDeepEqual(rebalanced.plan.policy.baselineAmounts, s2.params.amounts)
  assert.deepEqual(await executeRequest(ctx, d, rebalance, opts), rebalanced)
  await assert.rejects(executeRequest(ctx, d, { ...swap, requestId: 'stale-swap' }, opts), /expectedStrategyHash/)

  writePrices('1000000000000')
  const monitor = { schema: 'aqua-execution-v1', requestId: 'recovery-risk', sessionId: ship.sessionId, action: 'monitor', expectedStrategyHash: s2.strategyHash }
  const stopped = await childExit(worker(monitor, stateDir, 'broadcast', 'risk-dock'))
  assert.equal(stopped.signal, 'SIGKILL', stopped.stderr)
  const nonceAfterDock = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
  const risk = await executeRequest(ctx, d, monitor, { ...opts, getPrices: async () => { throw new Error('persisted breach must recover without requesting new prices') } })
  assert.equal(risk.outcome, 'risk-docked')
  assert.equal(risk.plan.finished, true)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonceAfterDock)
  assert.deepEqual(risk.plan.policy, rebalanced.plan.policy)
  assert.ok((await rawBalances(ctx, d, s2)).every(b => b.tokensCount === 255 && b.balance === 0n))

  const cleanup = { schema: 'aqua-execution-v1', requestId: 'recovery-cleanup', sessionId: ship.sessionId, action: 'dock', expectedStrategyHash: s2.strategyHash, revokeAllowances: true }
  const closed = await executeRequest(ctx, d, cleanup, opts)
  assert.equal(closed.transactions.length, 2, 'already docked: only the two explicitly requested revokes')
  assert.deepEqual(await executeRequest(ctx, d, cleanup, opts), closed)
  for (const token of s2.tokens) assert.equal(await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.maker.account.address, d.aqua] }), 0n)
  const txs = inspectTxs(stateDir)
  assert.equal(txs.length, 11)
  assert.equal(new Set(txs.map(t => t.hash)).size, 11)
  for (const result of [shipped, swapped, rebalanced, risk, closed]) {
    const events = readFileSync(result.records, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.kind === 'execution')
    assert.equal(events.length, result.transactions.length)
    assert.equal(new Set(events.map(r => r.tx_hash)).size, events.length)
  }
  rmSync(swapped.records)
  await executeRequest(ctx, d, swap, opts)
  assert.ok(readFileSync(swapped.records, 'utf8').includes(savedSwap.hash), 'lost JSONL is regenerated from SQLite')
})

test('rejected quotes release the request queue while failed RPC reads remain resumable', { timeout: 30000 }, async () => {
  const stateDir = join(dir, 'quote-rejection'), ship = await shipRequest('quote-rejection', 1800n)
  const opts = { stateDir, getPrices: async () => prices() }
  const shipped = await executeRequest(ctx, d, ship, opts)
  const swap = { schema: 'aqua-execution-v1', requestId: 'rejected-quote', sessionId: ship.sessionId,
    action: 'swap', expectedStrategyHash: shipped.strategyHash, tokenIn: ship.strategy.tokens[1], amountIn: '250000', slippageBps: 50 }
  const quoteFailure = (error: Error): Ctx => ({ ...ctx, pc: new Proxy(ctx.pc, {
    get(target, key) {
      if (key !== 'readContract') return Reflect.get(target, key)
      return (input: { functionName: string }) => input.functionName === 'quote'
        ? Promise.reject(error) : target.readContract(input as never)
    },
  }) })
  const rejected = await executeRequest(quoteFailure(new ContractFunctionRevertedError({
    abi: [], functionName: 'quote', data: '0xdc974a98',
  })), d, swap, opts)
  assert.equal(rejected.status, 'failed')
  assert.match(rejected.outcome, /swap quote rejected/)
  assert.equal(rejected.transactions.some(t => t.step === 'primary'), false, 'no swap was signed')
  assert.deepEqual(await executeRequest(ctx, d, swap, opts), rejected, 'same request cannot silently become a trade later')

  const retry = { ...swap, requestId: 'transport-interrupted-quote' }
  await assert.rejects(executeRequest(quoteFailure(new Error('RPC connection lost')), d, retry, opts), /RPC connection lost/)
  await assert.rejects(executeRequest(ctx, d, { ...swap, requestId: 'competing-quote' }, opts), /resume pending request/)
  const completed = await executeRequest(ctx, d, retry, opts)
  assert.equal(completed.outcome, 'swapped')
  assert.equal(completed.transactions.filter(t => t.step === 'primary').length, 1)
})

test('a cross-process lock prevents competing senders and is released after SIGKILL', { timeout: 30000 }, async () => {
  const stateDir = join(dir, 'locked'), ship = await shipRequest('locked-session', 2000n)
  writePrices()
  const child = worker(ship, stateDir, 'prepared', 'maker-approve-0', 'hold')
  const exited = childExit(child)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker did not acquire lock')), 10000)
    child.stdout!.on('data', b => { if (String(b).includes('LOCKED')) { clearTimeout(timeout); resolve() } })
  })
  const opts = { stateDir, getPrices: async () => prices() }
  await assert.rejects(executeRequest(ctx, d, ship, opts), ExecutionBusyError)
  child.kill('SIGKILL'); await exited
  const result = await executeRequest(ctx, d, ship, opts)
  assert.equal(result.outcome, 'shipped')
  await executeRequest(ctx, d, { schema: 'aqua-execution-v1', requestId: 'locked-close', sessionId: ship.sessionId, action: 'dock', expectedStrategyHash: result.strategyHash, revokeAllowances: true }, opts)
})

test('one maker can keep two Aqua strategies active against the same wallet balance', { timeout: 30000 }, async () => {
  const stateDir = join(dir, 'shared-liquidity')
  const opts = { stateDir, getPrices: async () => prices() }
  const first = await shipRequest('shared-a', 2300n)
  const second = await shipRequest('shared-b', 2301n)
  const [a, b] = [compile(first.strategy), compile(second.strategy)]

  const shippedA = await executeRequest(ctx, d, first, opts)
  const shippedB = await executeRequest(ctx, d, second, opts)
  assert.equal(shippedA.outcome, 'shipped')
  assert.equal(shippedB.outcome, 'shipped')
  assert.notEqual(shippedA.strategyHash, shippedB.strategyHash)
  assert.ok((await rawBalances(ctx, d, a)).every(value => value.tokensCount === 2))
  assert.ok((await rawBalances(ctx, d, b)).every(value => value.tokensCount === 2))

  for (const [id, hash] of [[first.sessionId, a.strategyHash], [second.sessionId, b.strategyHash]] as const) {
    await executeRequest(ctx, d, { schema: 'aqua-execution-v1', requestId: `${id}-close`, sessionId: id, action: 'dock', expectedStrategyHash: hash }, opts)
  }
})

test('the watcher recovers a data outage and follows a rebalance submitted by another process', { timeout: 30000 }, async () => {
  const stateDir = join(dir, 'watcher'), ship = await shipRequest('watched-session', 2500n)
  const opts = { stateDir, getPrices: async () => prices() }
  const shipped = await executeRequest(ctx, d, ship, opts)
  await executeRequest(ctx, d, { schema: 'aqua-execution-v1', requestId: 'watched-swap', sessionId: ship.sessionId, action: 'swap', expectedStrategyHash: shipped.strategyHash, tokenIn: d.tokens.mUSDC, amountIn: '100000000', slippageBps: 50 }, opts)
  const s2 = compile(await params(2501n, 2, (await rawBalances(ctx, d, compile(ship.strategy))).map(b => b.balance)))
  let calls = 0, adverse = false
  const observed: string[] = []
  const result = await watchExecution(ctx, d, ship.sessionId, {
    stateDir, intervalMs: 100, maxChecks: 2,
    getPrices: async () => { if (++calls === 1) throw new Error('temporary provider outage'); return prices(adverse ? '1000000000000' : undefined) },
    onCheck: async check => {
      observed.push(check.strategyHash)
      if (observed.length === 1) {
        writePrices()
        await cli({ schema: 'aqua-execution-v1', requestId: 'watched-rebalance', sessionId: ship.sessionId, action: 'rebalance', expectedStrategyHash: shipped.strategyHash, strategy: s2.params }, stateDir)
        adverse = true
      }
    },
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(observed, [shipped.strategyHash, s2.strategyHash])
  const status = await executionStatus(ctx, d, stateDir, ship.sessionId)
  assert.deepEqual(status.session.plan.policy.baselineAmounts, ship.policy.baselineAmounts)
  assert.equal(status.session.status, 'closed')
  assert.ok(status.requests.some(r => r.status === 'failed' && r.action === 'monitor'))
  await executeRequest(ctx, d, { schema: 'aqua-execution-v1', requestId: 'watched-cleanup', sessionId: ship.sessionId, action: 'dock', expectedStrategyHash: s2.strategyHash, revokeAllowances: true }, opts)
})

test('an expired signed swap reports the original revert and never requotes or sends a replacement', { timeout: 30000 }, async () => {
  const tc = createTestClient({ chain: foundry, mode: 'anvil', transport: http(rpc) })
  const snapshot = await tc.snapshot()
  try {
    const stateDir = join(dir, 'expired'), ship = await shipRequest('expired-swap', 2800n)
    const opts = { stateDir, getPrices: async () => prices() }
    const shipped = await executeRequest(ctx, d, ship, opts)
    const swap = { schema: 'aqua-execution-v1', requestId: 'expired-swap-tx', sessionId: ship.sessionId, action: 'swap', expectedStrategyHash: shipped.strategyHash, tokenIn: d.tokens.mUSDC, amountIn: '100000000', slippageBps: 50 }
    await crash(swap, stateDir, 'prepared')
    const saved = inspectTxs(stateDir).find(t => t.step === 'primary' && t.requestId === swap.requestId)!
    await tc.increaseTime({ seconds: 301 }); await tc.mine({ blocks: 1 })
    const result = await executeRequest(ctx, d, swap, opts)
    assert.equal(result.status, 'failed')
    assert.match(result.outcome, /reverted on-chain/)
    assert.equal(result.transactions.find(t => t.step === 'primary')!.hash, saved.hash)
    const nonce = await ctx.pc.getTransactionCount({ address: ctx.taker.account.address })
    assert.deepEqual(await executeRequest(ctx, d, swap, opts), result)
    assert.equal(await ctx.pc.getTransactionCount({ address: ctx.taker.account.address }), nonce)
    await executeRequest(ctx, d, { schema: 'aqua-execution-v1', requestId: 'expired-cleanup', sessionId: ship.sessionId, action: 'dock', expectedStrategyHash: shipped.strategyHash, revokeAllowances: true }, opts)
  } finally { await tc.revert({ id: snapshot }) }
})

test('a ship that expires before submission can clean up its approvals and resume an interrupted cleanup', { timeout: 30000 }, async () => {
  const tc = createTestClient({ chain: foundry, mode: 'anvil', transport: http(rpc) })
  const snapshot = await tc.snapshot()
  try {
    const stateDir = join(dir, 'unshipped'), ship = await shipRequest('unshipped', 2900n)
    const opts = { stateDir, getPrices: async () => prices() }
    const result = await executeRequest(ctx, d, ship, { ...opts, onTransaction: async e => {
      if (e.phase === 'saved' && e.step === 'maker-approve-0') { await tc.increaseTime({ seconds: 4000 }); await tc.mine({ blocks: 1 }) }
    } })
    assert.equal(result.status, 'failed')
    assert.match(result.outcome, /deadline has expired/)
    assert.ok((await rawBalances(ctx, d, compile(ship.strategy))).every(b => b.tokensCount === 0))
    const cleanup = { schema: 'aqua-execution-v1', requestId: 'unshipped-cleanup', sessionId: ship.sessionId, action: 'dock', expectedStrategyHash: result.strategyHash, revokeAllowances: true }
    await assert.rejects(executeRequest(ctx, d, cleanup, { ...opts, onTransaction: e => {
      if (e.phase === 'prepared' && e.step === 'maker-revoke-0') throw new Error('interrupt cleanup after saving its intent')
    } }), /interrupt cleanup/)
    const closed = await executeRequest(ctx, d, cleanup, opts)
    assert.equal(closed.outcome, 'not-shipped')
    assert.deepEqual(closed.transactions.map(t => t.action), ['maker-revoke', 'maker-revoke'])
    assert.equal(closed.plan.finished, true)
    for (const token of ship.strategy.tokens) assert.equal(await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.maker.account.address, d.aqua] }), 0n)
  } finally { await tc.revert({ id: snapshot }) }
})

test('a replacement receipt cannot complete an intent for a different transaction hash', { timeout: 30000 }, async () => {
  const stateDir = join(dir, 'replacement'), ship = await shipRequest('replacement', 2950n)
  const otherHash = await ctx.maker.sendTransaction({ to: ctx.maker.account.address, value: 0n })
  const other = await ctx.pc.waitForTransactionReceipt({ hash: otherHash })
  const proxyCtx: Ctx = { ...ctx, pc: { ...ctx.pc, waitForTransactionReceipt: async () => other } }
  const opts = { stateDir, getPrices: async () => prices() }
  await assert.rejects(executeRequest(proxyCtx, d, ship, opts), /receipt belongs to a replacement/)
  const saved = inspectTxs(stateDir)[0]!
  assert.notEqual(saved.hash, otherHash)
  assert.equal(saved.receipt, undefined)
  const result = await executeRequest(ctx, d, ship, opts)
  assert.equal(result.outcome, 'shipped')
  assert.equal(result.transactions.find(t => t.step === saved.step)!.hash, saved.hash)
  await executeRequest(ctx, d, { schema: 'aqua-execution-v1', requestId: 'replacement-close', sessionId: ship.sessionId, action: 'dock', expectedStrategyHash: result.strategyHash, revokeAllowances: true }, opts)
})

test('a consumed nonce with no matching receipt stops recovery instead of sending under a new nonce', { timeout: 30000 }, async () => {
  const stateDir = join(dir, 'nonce-conflict'), ship = await shipRequest('nonce-conflict', 3000n)
  await crash(ship, stateDir, 'prepared', 'maker-approve-0')
  const saved = inspectTxs(stateDir)[0]!
  const other = await ctx.maker.sendTransaction({ to: ctx.maker.account.address, value: 0n, nonce: saved.nonce })
  await ctx.pc.waitForTransactionReceipt({ hash: other })
  const nonce = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
  await assert.rejects(executeRequest(ctx, d, ship, { stateDir, getPrices: async () => prices() }), /nonce .* consumed/)
  assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonce)
  assert.equal(inspectTxs(stateDir)[0]!.hash, saved.hash)
  assert.ok((await rawBalances(ctx, d, compile(ship.strategy))).every(b => b.tokensCount === 0))
})
