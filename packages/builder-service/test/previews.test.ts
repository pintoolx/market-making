import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { MockLanguageModelV4 } from 'ai/test'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderHandler, createPreviews, createStore, createTurns, database, migrate, runDesignTurn } from '../src/index.ts'

const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>
before(async () => {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
})
after(async () => {
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
})
const scenarios = [{ name: 'two-way', trades: [{ tokenIn: 'base' as const, amountInAtomic: '100000000000000' }, { tokenIn: 'quote' as const, amountInAtomic: '250000' }] }]
async function prepared(kind: 'xyc' | 'concentrated' | 'pegged' = 'xyc', template = false) {
  const account = privateKeyToAccount(generatePrivateKey()), owner = 'wallet:' + account.address.toLowerCase(), store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { title: 'Public scenario previews', kind: template ? 'template' : 'maker' })
  const allocations = { baseAtomic: '10000000000000000', quoteAtomic: '25000000' }
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    ...(template ? {} : { allocations }), spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 86400,
      model: kind === 'xyc' ? { kind } : kind === 'concentrated' ? { kind, minPrice: '2200', maxPrice: '2800' } : { kind, referencePrice: '2500', amplification: '1' },
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
  } })
  return { account, owner, draft, conversationId: created.conversationId,
    input: { draftId: draft.id, expectedRevision: 2, hypotheticalAllocations: template ? allocations : null, scenarios } }
}

test('owned previews for all three curves persist independently of agent history, deduplicate and cannot be changed', async () => {
  const store = createPreviews(pool, profile), other = 'wallet:0x2222222222222222222222222222222222222222'
  for (const kind of ['xyc','concentrated','pegged'] as const) {
    const p = await prepared(kind), key = randomUUID()
    const refs = await Promise.all([store.preview(p.owner, key, p.input), store.preview(p.owner, key, p.input), store.preview(p.owner, randomUUID(), p.input)])
    assert.deepEqual(refs[0], refs[1]); assert.deepEqual(refs[0], refs[2])
    const saved = await createPreviews(pool, profile).get(p.owner, refs[0]!.previewId)
    assert.equal(saved.current, true); assert.equal(saved.payload.mode, 'mathematical-preview'); assert.equal(saved.payload.registrationReady, false)
    assert.ok(saved.payload.scenarios[0]!.trades.every(t => t.admittedUnderAssumptions))
    assert.deepEqual(saved, JSON.parse(JSON.stringify(saved)))
    const summary = (await store.list(p.owner, p.draft.id))[0]!
    assert.equal(summary.scenarios[0]!.tradeCount, 2); assert.equal(summary.scenarios[0]!.admittedCount, 2); assert.equal('payload' in summary, false)
    await assert.rejects(store.get(other, saved.previewId), /not-found/)
    await assert.rejects(store.list(other, p.draft.id), /not-found/)
    await assert.rejects(store.preview(other, randomUUID(), p.input), /not-found/)
    await assert.rejects(store.preview(p.owner, key, { ...p.input, expectedRevision: 3 }), /idempotency-key-reused/)
    await assert.rejects(pool.query('DELETE FROM builder.scenario_previews WHERE id=$1', [saved.previewId]), /immutable/)
    assert.equal((await pool.query("SELECT id FROM builder.outbox WHERE kind='scenario.previewed' AND resource_id=$1", [saved.previewId])).rowCount, 1)
  }
})

test('template comparisons are explicitly hypothetical and never produce executable artifacts or alter Maker allocations', async () => {
  const store = createPreviews(pool, profile), p = await prepared('concentrated', true)
  await assert.rejects(store.preview(p.owner, randomUUID(), { ...p.input, hypotheticalAllocations: null }), /hypothetical-allocation-required/)
  const saved = await store.get(p.owner, (await store.preview(p.owner, randomUUID(), p.input)).previewId)
  assert.equal(saved.payload.allocationSource, 'hypothetical'); assert.equal(saved.payload.kind, 'template')
  assert.equal('strategyHash' in saved.payload, false)
  assert.deepEqual(await createStore(pool, profile.id).get(p.owner, p.draft.id), p.draft)
  assert.equal((await pool.query('SELECT id FROM builder.compiled_artifacts WHERE owner=$1', [p.owner])).rowCount, 0)
  const q = await prepared()
  await assert.rejects(store.preview(q.owner, randomUUID(), { ...q.input, hypotheticalAllocations: p.input.hypotheticalAllocations }), /maker-allocation-override-forbidden/)
  await assert.rejects(store.preview(q.owner, randomUUID(), { ...q.input, rpcUrl: 'https://untrusted.example' }))
})

test('draft edits, restores and manifest changes preserve historical previews with stale status; cancelled turns cannot save previews', async () => {
  const previews = createPreviews(pool, profile), store = createStore(pool, profile.id), p = await prepared(), key = randomUUID()
  const saved = await previews.preview(p.owner, key, p.input)
  await store.patch(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 2, patch: { spec: { title: 'Another version' } } })
  assert.equal((await previews.get(p.owner, saved.previewId)).current, false)
  assert.deepEqual(await previews.preview(p.owner, key, p.input), saved)
  await assert.rejects(previews.preview(p.owner, randomUUID(), p.input), /draft-changed/)
  await store.restore(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 3, revision: 2 })
  const next = await previews.preview(p.owner, randomUUID(), { ...p.input, expectedRevision: 4 })
  assert.notEqual(next.previewId, saved.previewId)
  assert.equal((await previews.get(p.owner, next.previewId)).current, true)
  assert.equal((await createPreviews(pool, { ...profile, forwarder: '0x3333333333333333333333333333333333333333' }).get(p.owner, next.previewId)).current, false)
  const q = await prepared(), turns = createTurns(pool)
  const turn = await turns.accept(q.owner, randomUUID(), { conversationId: q.conversationId, expectedRevision: 2, content: 'Compare scenarios' }), lease = (await turns.claim())!
  await turns.cancel(q.owner, turn.id)
  await assert.rejects(createPreviews(pool, profile, lease).preview(q.owner, randomUUID(), q.input), /agent-turn-stale/)
})

test('the preview budget is shared across concurrent requests and identical inputs consume it once', async () => {
  const p = await prepared(), store = createPreviews(pool, profile)
  for (let i = 0; i < 59; i++) await store.preview(p.owner, randomUUID(), { ...p.input, scenarios: [{ ...scenarios[0]!, name: `case-${i}` }] })
  const results = await Promise.allSettled([60, 61].map(i => store.preview(p.owner, randomUUID(), { ...p.input, scenarios: [{ ...scenarios[0]!, name: `case-${i}` }] })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected' && /preview-budget-exhausted/.test(r.reason.message)).length, 1)
  await store.preview(p.owner, randomUUID(), { ...p.input, scenarios: [{ ...scenarios[0]!, name: 'case-0' }] })
})

test('authenticated HTTP preview routes bind owner/resource, reject configuration injection and expose durable mathematical evidence', async () => {
  const p = await prepared(), origin = 'http://localhost:3311', handler = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id })
  const server = createServer((req, res) => { void handler(req, res).then(ok => { if (!ok) { res.statusCode = 404; res.end() } }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`
  let token = ''
  const post = async (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin,
    'idempotency-key': randomUUID(), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
  try {
    const challengeResponse = await post('/auth/challenge', { address: p.account.address })
    assert.equal(challengeResponse.status, 200)
    const challenge = await challengeResponse.json() as { id: string; message: string }
    const login = await (await post('/auth/login', { challengeId: challenge.id, signature: await p.account.signMessage({ message: challenge.message }) })).json() as { token: string }
    token = login.token; assert.ok(token)
    const { draftId, ...input } = p.input
    assert.equal((await post(`/drafts/${draftId}/previews`, { ...input, owner: p.owner })).status, 400)
    const response = await post(`/drafts/${draftId}/previews`, input)
    assert.equal(response.status, 200); const ref = await response.json() as { previewId: string }
    const result = await (await fetch(base + '/previews/' + ref.previewId, { headers: { authorization: 'Bearer ' + token } })).json() as { payload: { mode: string } }
    assert.equal(result.payload.mode, 'mathematical-preview')
    const other = await prepared()
    assert.equal((await post(`/drafts/${other.draft.id}/previews`, input)).status, 404)
    assert.equal((await fetch(base + '/previews/' + ref.previewId)).status, 401)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('the ninth AI SDK tool converts human units, saves the result, and cannot claim settlement readiness', async () => {
  const p = await prepared(), turns = createTurns(pool)
  const turn = await turns.accept(p.owner, randomUUID(), { conversationId: p.conversationId, expectedRevision: 2, content: 'Preview selling 0.0001 WETH, then selling 0.25 USDC in the reverse direction.' })
  let step = 0
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] })
    if (step === 0) c.enqueue({ type: 'tool-call', toolCallId: 'preview', toolName: 'previewScenarios', input: JSON.stringify({ expectedRevision: 2,
      hypotheticalAllocations: null, scenarios: [{ name: 'two-way', trades: [{ tokenIn: 'base', amount: '0.0001' }, { tokenIn: 'quote', amount: '0.25' }] }] }) })
    else { c.enqueue({ type: 'text-start', id: 'reply' }); c.enqueue({ type: 'text-delta', id: 'reply', delta: 'Mathematical preview saved; wallet and full settlement remain unverified.' }); c.enqueue({ type: 'text-end', id: 'reply' }) }
    c.enqueue({ type: 'finish', finishReason: { unified: step++ === 0 ? 'tool-calls' : 'stop', raw: '' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }); c.close()
  } }) }) })
  assert.deepEqual(await runDesignTurn(pool, profile, model, (await turns.claim())!), { state: 'succeeded' })
  const records = await createPreviews(pool, profile).list(p.owner, p.draft.id)
  assert.equal(records.length, 1)
  const saved = await createPreviews(pool, profile).get(p.owner, records[0]!.previewId)
  assert.deepEqual(saved.payload.scenarios[0]!.trades.map(t => t.amountInAtomic), ['100000000000000', '250000'])
  assert.ok((await turns.events(p.owner, turn.id)).some(e => e.kind === 'tool' && e.payload.name === 'previewScenarios' && e.payload.ok === true))
  assert.deepEqual(await createStore(pool, profile.id).get(p.owner, p.draft.id), p.draft)
})
