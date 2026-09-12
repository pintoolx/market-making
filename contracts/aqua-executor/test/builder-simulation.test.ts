import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createPublicClient, http, zeroHash, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { compileBuilderStrategy } from '../src/builder-compile.ts'
import { startBuilderFork } from '../src/builder-fork.ts'
import { readBuilderTokenImplementation } from '../src/builder-token-proxy.ts'
import { simulateBuilderLifecycle } from '../src/builder-simulation.ts'
import { builderSimulationFixture } from '../scripts/builder-simulation-fixture.ts'

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))

test('changed compilation, unsupported profile and pre-abort never contact an upstream or create a fork', async () => {
  let calls = 0
  const server = createServer((_, res) => { calls++; res.writeHead(500); res.end() }), rpcUrl = await listen(server)
  const draft = builderSimulationFixture('xyc', privateKeyToAddress(generatePrivateKey()).toLowerCase())
  const compiled = compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000))
  try {
    for (const patch of [{ amounts: ['1', '1'] }, { programHash: zeroHash }, { revision: 9 }, { strategyHash: zeroHash }])
      await assert.rejects(simulateBuilderLifecycle(draft, { ...compiled, ...patch }, profile, { rpcUrl }), /simulation-artifact-mismatch/)
    await assert.rejects(startBuilderFork({ ...profile, id: 'not-reviewed' }, { rpcUrl }), /^Error: builder-fork-unavailable$/)
    await assert.rejects(startBuilderFork(profile, { rpcUrl, signal: AbortSignal.abort() }), /^Error: builder-fork-unavailable$/)
    assert.equal(calls, 0)
  } finally { await close(server) }
})

test('proxy evidence rejects missing, malformed or empty implementation rather than trusting the proxy code alone', async () => {
  let storage: Hex = zeroHash, code: Hex = '0x1234'
  const pc = { getStorageAt: async () => storage, getCode: async () => code }
  await assert.rejects(readBuilderTokenImplementation(pc, profile, 1n), /missing-token-implementation/)
  storage = ('0x' + 'ff'.repeat(32)) as Hex
  await assert.rejects(readBuilderTokenImplementation(pc, profile, 1n), /invalid-token-implementation/)
  storage = ('0x' + '00'.repeat(12) + '11'.repeat(20)) as Hex
  const result = await readBuilderTokenImplementation(pc, profile, 1n)
  assert.equal(result.implementation, '0x' + '11'.repeat(20)); assert.equal(result.runtimeBytes, 2)
  code = '0x'
  await assert.rejects(readBuilderTokenImplementation(pc, profile, 1n), /empty-token-implementation/)
})

test('a real child fork rejects mismatched deployments and its upstream receives read methods only', { timeout: 90000 }, async () => {
  const reservation = createServer(), upstreamUrl = await listen(reservation), port = new URL(upstreamUrl).port
  await close(reservation)
  const child = spawn(process.env.ANVIL ?? 'anvil', ['--host', '127.0.0.1', '--port', port, '--chain-id', String(profile.chainId), '--silent'],
    { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let unavailable = false; child.once('error', () => { unavailable = true })
  const pc = createPublicClient({ chain: sepolia, cacheTime: 0, transport: http(upstreamUrl, { retryCount: 0, timeout: 1000 }) })
  const reads = new Set(['eth_chainId','net_version','web3_clientVersion','anvil_nodeInfo','eth_getAccountInfo','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash',
    'eth_getBalance','eth_getStorageAt','eth_getCode','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_feeHistory','eth_gasPrice'])
  const seen: string[] = [], forbidden: string[] = [], contractReads: string[] = []
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()), batch = Array.isArray(body) ? body : [body]
      for (const item of batch) {
        seen.push(item.method); if (!reads.has(item.method)) forbidden.push(item.method)
        if (['eth_getCode','eth_getAccountInfo'].includes(item.method)) contractReads.push(String(item.params[0]).toLowerCase())
      }
      if (batch.some(item => !reads.has(item.method))) { res.writeHead(403); res.end('{}'); return }
      // Match a standard public RPC, without Anvil-to-Anvil node-info/account-info shortcuts.
      const results = await Promise.all(batch.map(async item => {
        if (['anvil_nodeInfo','eth_getAccountInfo'].includes(item.method)) return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: 'Method not found' } }
        const response = await fetch(upstreamUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) })
        return response.json()
      }))
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(body) ? results : results[0]))
    } catch { res.writeHead(502); res.end('{}') }
  })
  try {
    for (let n = 0; ; n++) {
      assert.equal(unavailable, false, 'Anvil is required for the executor test suite')
      try { await pc.getChainId(); break } catch { if (n >= 50) throw new Error('fixture-start-timeout'); await delay(100) }
    }
    const rpcUrl = await listen(proxy), before = await pc.getBlockNumber()
    await assert.rejects(startBuilderFork(profile, { rpcUrl, anvil: process.env.ANVIL }), /^Error: builder-fork-unavailable$/)
    assert.ok(contractReads.includes(profile.router), 'child fetched a pinned runtime (possibly via eth_getAccountInfo)')
    assert.deepEqual(forbidden, []); assert.equal(await pc.getBlockNumber(), before)
  } finally { await close(proxy); child.kill('SIGTERM'); await closed }
})

test('optional pinned Sepolia fork: all curves settle and reject with exact artifact evidence', {
  skip: !process.env.BUILDER_FORK_RPC_URL, timeout: 900000,
}, async () => {
  for (const kind of ['xyc','concentrated','pegged'] as const) {
    const draft = builderSimulationFixture(kind, privateKeyToAddress(generatePrivateKey()).toLowerCase())
    const compiled = compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000))
    const result = await simulateBuilderLifecycle(draft, compiled, profile, { rpcUrl: process.env.BUILDER_FORK_RPC_URL!, anvil: process.env.ANVIL })
    assert.equal(result.passed, true, JSON.stringify(result.cases.filter(c => c.passed === false)))
    assert.equal(result.coverageComplete, true); assert.equal(result.registrationReady, false)
    assert.equal(result.mode, 'fork-with-overrides'); assert.ok(result.swaps.length >= 9)
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)))
  }
})
