import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderSimulationFixture } from '../../../contracts/aqua-executor/scripts/builder-simulation-fixture.ts'
import { database, migrate, builderHandler, createTurns, runDesignTurn, openAIModel, nativeInventoryAdapter } from '../src/index.ts'

const account = privateKeyToAccount(generatePrivateKey()), name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
const origin = 'https://pintool-eval.example', modelId = process.env.BUILDER_OPENAI_MODEL ?? 'gpt-5.6-sol'
let pool: ReturnType<typeof database> | undefined, admin: ReturnType<typeof database> | undefined, server: ReturnType<typeof createServer> | undefined
const evidence: unknown[] = [], directory = new URL('../../../.cache/builder/', import.meta.url)
try {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname), 'local disposable database required')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
  const native = nativeInventoryAdapter(profile, { rpcUrl: process.env.BUILDER_INVENTORY_TEST_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' })
  const reads: Awaited<ReturnType<typeof native>>[] = []
  const adapter: typeof native = async (maker, hashes, signal) => {
    assert.equal(maker, account.address.toLowerCase()); assert.deepEqual(hashes, [])
    const result = await native(maker, hashes, signal); reads.push(result); return result
  }
  const handler = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id, designEnabled: true }, { inventoryAdapter: adapter })
  server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end() } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`
  let token: string | undefined
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      origin, 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(token ? { authorization: 'Bearer ' + token } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.ok(response.ok, `HTTP ${response.status}`)
    return await response.json() as any
  }
  const challenge = await call('/auth/challenge', { address: account.address })
  token = (await call('/auth/login', { challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) })).token
  const created = await call('/conversations', { title: 'Maker live inventory and execution readiness', kind: 'maker' })
  const fixture = builderSimulationFixture('xyc', account.address.toLowerCase()), { profileId: _profileId, ...spec } = fixture.spec
  await call(`/drafts/${created.draft.id}/patch`, { expectedRevision: 1, patch: { spec, allocations: fixture.allocations } })
  const turns = createTurns(pool), model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  const prompts = [
    'Use only the inventory tool to read this Maker draft wallet: ETH, WETH, USDC and Aqua allowances. Explain whether its allocations have sufficient balances and allowances without guessing, editing, swapping or trading.',
    'Discuss only; do not edit or read again. Can ETH count as a WETH allocation? Does Aqua ship deposit tokens into a contract? Does a passing mathematical preview mean trading is ready?',
    'Reduce only the USDC allocation from 25 to 20. Preserve WETH and all other settings. Save and read inventory again to check whether the reduced allocation establishes trading readiness. Do not submit transactions.',
  ]
  await mkdir(directory, { recursive: true })
  for (const [index, content] of prompts.entries()) {
    const before = (await call(`/drafts/${created.draft.id}`)).draft, start = reads.length
    const accepted = await call(`/conversations/${created.conversationId}/turns`, { content, expectedRevision: before.revision })
    console.log(JSON.stringify({ turn: index + 1, state: 'model-running' }))
    const claimed = (await turns.claim())!; assert.equal(claimed.turnId, accepted.id)
    await runDesignTurn(pool, profile, model, claimed, undefined, { inventoryAdapter: adapter })
    const turn = (await call(`/turns/${accepted.id}`)).turn
    assert.equal(turn.state, 'succeeded')
    const events = (await call(`/turns/${accepted.id}/events`)).events
    const reply = (await call(`/conversations/${created.conversationId}/messages`)).messages.find((m: any) => m.id === turn.messageId)?.content
    assert.ok(reply)
    const draft = (await call(`/drafts/${created.draft.id}`)).draft
    evidence.push({ turn: index + 1, content, reply, draft, reads: reads.slice(start), toolEvents: events.filter((e: any) => e.kind === 'tool').map((e: any) => e.payload) })
    await writeFile(new URL('inventory-agent-evaluation.json', directory), JSON.stringify({ modelId, recordedAt: new Date().toISOString(),
      mode: 'real-openai-local-authenticated-http-postgres-and-sepolia-reads', publicChainWrites: 0, evidence }, null, 2) + '\n')
    assert.deepEqual(draft.spec, fixture.spec)
    assert.deepEqual(draft.allocations, { ...fixture.allocations, quoteAtomic: index === 2 ? '20000000' : '25000000' })
    if (index < 2) assert.deepEqual(draft, before)
    if (index === 1) assert.equal(reads.length, start)
    else {
      assert.ok(reads.length > start)
      assert.ok(events.some((e: any) => e.kind === 'tool' && e.payload.name === 'getWalletInventory' && e.payload.ok))
      for (const r of reads.slice(start)) {
        assert.equal(r.mode, 'live-read'); assert.equal(r.registrationReady, false)
        assert.ok(r.tokens.every(t => t.walletBalanceAtomic === '0' && t.allowanceToAquaAtomic === '0'), 'fresh unfunded Maker cannot back the allocation')
        assert.equal(r.native.walletBalanceAtomic, '0')
      }
    }
    console.log(JSON.stringify({ turn: index + 1, state: 'passed', revision: draft.revision, reply }))
  }
  console.log(JSON.stringify({ result: 'passed', turns: prompts.length, modelId, publicChainWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', type: error instanceof Error ? error.name : 'unknown',
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : undefined }))
  process.exitCode = 1
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
}
