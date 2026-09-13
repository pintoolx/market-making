import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { zeroHash } from 'viem'
import { MockLanguageModelV4 } from 'ai/test'
import { digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderHandler, createArtifacts, createInventoryReader, createStore, createTurns, database, migrate, runDesignTurn } from '../src/index.ts'
import type { InventorySnapshot } from '../src/inventory.ts'
import { inventoryEngine } from 'aqua-executor/builder-inventory'

const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>
const verification = JSON.parse(await readFile(new URL('../../strategy-builder/profiles/sepolia-standing-v2.verification.json', import.meta.url), 'utf8'))
before(async () => {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
})
after(async () => {
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
})
const snapshot = (maker: string): InventorySnapshot => ({ schemaVersion: 1, engineVersion: inventoryEngine, mode: 'mock', chainId: 11155111,
  manifestHash: digestJson(profile), maker: maker as `0x${string}`, blockNumber: '1', blockHash: zeroHash, blockTimestamp: String(Math.floor(Date.now() / 1000)),
  observedAt: new Date().toISOString(), finality: 'latest-unfinalized', contracts: verification.contracts, tokenImplementation: verification.tokenImplementation,
  sourceRuntimeRebuilt: false, native: { symbol: 'ETH', decimals: 18, walletBalanceAtomic: '1000000000000000000' }, spender: profile.aqua,
  tokens: profile.tokens.map(t => ({ ...t, walletBalanceAtomic: t.symbol === 'WETH' ? '20000000000000000' : '50000000', allowanceToAquaAtomic: '0' })),
  activeStrategyHash: zeroHash, strategies: [], commitmentsComplete: false, registrationReady: false, limitations: ['Synthetic adapter test; no live inventory is claimed.'] })
async function prepared(template = false) {
  const account = privateKeyToAccount(generatePrivateKey()), owner = 'wallet:' + account.address.toLowerCase(), store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { title: 'Inventory boundaries', kind: template ? 'template' : 'maker' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    ...(template ? {} : { allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' } }),
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 86400, model: { kind: 'xyc' },
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
  } })
  return { account, owner, draft, conversationId: created.conversationId, input: { draftId: draft.id, expectedRevision: 2 } }
}

test('inventory reads only the owned Maker and deduplicated owned artifact hashes; funds and allowance remain separate', async () => {
  const p = await prepared(), artifacts = createArtifacts(pool, profile), original = await artifacts.compile(p.owner, randomUUID(), p.input)
  await createStore(pool, profile.id).patch(p.owner, randomUUID(), { ...p.input, patch: { spec: { title: 'New draft with the same onchain hash' } } })
  await artifacts.compile(p.owner, randomUUID(), { ...p.input, expectedRevision: 3 })
  const other = await prepared(); await artifacts.compile(other.owner, randomUUID(), other.input)
  let calls = 0
  const reader = createInventoryReader(pool, profile, async (maker, hashes) => {
    calls++; assert.equal(maker, p.owner.slice(7))
    assert.deepEqual(hashes, [(await artifacts.get(p.owner, original.artifactId)).payload.strategyHash])
    return snapshot(maker)
  })
  const result = await reader.read(p.owner, { ...p.input, expectedRevision: 3 })
  assert.equal(result.inventory.mode, 'mock'); assert.equal(result.registrationReady, false)
  assert.ok(result.allocationChecks.every(c => c.walletSufficient && !c.allowanceSufficient && !c.uncommittedFundsVerified))
  assert.equal(calls, 1)
  await assert.rejects(reader.read(other.owner, p.input), /not-found/)
  await assert.rejects(reader.read(p.owner, p.input), /draft-changed/)
  await assert.rejects(reader.read(p.owner, { ...p.input, maker: other.account.address }))
  const template = await prepared(true)
  await assert.rejects(reader.read(template.owner, template.input), /maker-instance-required/)
  assert.equal(calls, 1)
})

test('a changed draft or cancelled agent lease rejects a late RPC result without holding a database transaction across the read', async () => {
  const p = await prepared()
  let entered!: () => void, release!: () => void
  const entry = new Promise<void>(resolve => { entered = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  const reader = createInventoryReader(pool, profile, async maker => { entered(); await blocked; return snapshot(maker) })
  const work = reader.read(p.owner, p.input); await entry
  await createStore(pool, profile.id).patch(p.owner, randomUUID(), { ...p.input, patch: { spec: { title: 'Updated during read' } } })
  release(); await assert.rejects(work, /draft-changed/)
  const q = await prepared(), turns = createTurns(pool)
  const turn = await turns.accept(q.owner, randomUUID(), { conversationId: q.conversationId, expectedRevision: 2, content: 'Check inventory' }), lease = (await turns.claim())!
  let rpcCalls = 0
  const ownedReader = createInventoryReader(pool, profile, async maker => { rpcCalls++; await turns.cancel(q.owner, turn.id); return snapshot(maker) }, lease)
  await assert.rejects(ownedReader.read(q.owner, q.input), /agent-turn-stale/)
  assert.equal(rpcCalls, 1)
})

test('adapter output stays bound to the wallet/profile and provider failures are redacted', async () => {
  const p = await prepared()
  for (const patch of [{ chainId: 1 }, { maker: '0x2222222222222222222222222222222222222222' as const }, { registrationReady: true }]) {
    const reader = createInventoryReader(pool, profile, async maker => ({ ...snapshot(maker), ...patch }) as InventorySnapshot)
    await assert.rejects(reader.read(p.owner, p.input), /inventory-binding-mismatch/)
  }
  const reader = createInventoryReader(pool, profile, async () => { throw new Error('private-operator-RPC-credential') })
  await assert.rejects(reader.read(p.owner, p.input), error => { assert.equal(String(error), 'Error: inventory-read-unavailable'); return true })
})

test('inventory HTTP has no arbitrary wallet/RPC parameter, requires a revision and stays disabled without its trusted adapter', async () => {
  const p = await prepared(), origin = 'http://localhost:3311'
  const adapter = async (maker: string) => snapshot(maker)
  const enabled = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id }, { inventoryAdapter: adapter })
  const disabled = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id })
  let useDisabled = false
  const server = createServer((req, res) => { void (useDisabled ? disabled : enabled)(req, res).then(ok => { if (!ok) { res.statusCode = 404; res.end() } }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`
  let token = ''
  const post = async (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  const get = (path: string) => fetch(base + path, { headers: { authorization: 'Bearer ' + token } })
  try {
    const c = await (await post('/auth/challenge', { address: p.account.address })).json() as { id: string; message: string }
    token = (await (await post('/auth/login', { challengeId: c.id, signature: await p.account.signMessage({ message: c.message }) })).json() as { token: string }).token
    assert.ok(token)
    const path = `/drafts/${p.draft.id}/inventory`
    const response = await get(path + '?revision=2'); assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { inventory: InventorySnapshot }).inventory.mode, 'mock')
    assert.equal((await get(path)).status, 400)
    assert.equal((await get(path + '?revision=2&revision=2')).status, 400)
    assert.equal((await get(path + '?revision=2&maker=' + p.account.address)).status, 400)
    assert.equal((await get(path + '?revision=1')).status, 409)
    const other = await prepared()
    assert.equal((await get(`/drafts/${other.draft.id}/inventory?revision=2`)).status, 404)
    useDisabled = true; assert.equal((await get(path + '?revision=2')).status, 503)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('the tenth AI SDK tool reads scoped inventory without editing allocations or requesting an asset signature', async () => {
  const p = await prepared(), turns = createTurns(pool)
  const turn = await turns.accept(p.owner, randomUUID(), { conversationId: p.conversationId, expectedRevision: 2, content: 'Read Maker inventory without trading.' })
  let step = 0, calls = 0
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] })
    if (step === 0) c.enqueue({ type: 'tool-call', toolCallId: 'inventory', toolName: 'getWalletInventory', input: JSON.stringify({ expectedRevision: 2 }) })
    else { c.enqueue({ type: 'text-start', id: 'reply' }); c.enqueue({ type: 'text-delta', id: 'reply', delta: 'Test data shows insufficient allowance; trading is not ready.' }); c.enqueue({ type: 'text-end', id: 'reply' }) }
    c.enqueue({ type: 'finish', finishReason: { unified: step++ === 0 ? 'tool-calls' : 'stop', raw: '' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }); c.close()
  } }) }) })
  assert.deepEqual(await runDesignTurn(pool, profile, model, (await turns.claim())!, undefined, { inventoryAdapter: async maker => { calls++; return snapshot(maker) } }), { state: 'succeeded' })
  assert.equal(calls, 1)
  assert.ok((await turns.events(p.owner, turn.id)).some(e => e.kind === 'tool' && e.payload.name === 'getWalletInventory' && e.payload.ok === true))
  assert.deepEqual(await createStore(pool, profile.id).get(p.owner, p.draft.id), p.draft)
})
