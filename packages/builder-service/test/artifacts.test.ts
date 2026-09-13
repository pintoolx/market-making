import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MockLanguageModelV4 } from 'ai/test'
import { decodeGuardedOrder, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { createArtifacts, createStore, createTurns, database, migrate, runDesignTurn } from '../src/index.ts'

const owner = 'wallet:0x1111111111111111111111111111111111111111', other = 'wallet:0x2222222222222222222222222222222222222222'
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
async function maker(kind: 'xyc' | 'concentrated' | 'pegged' = 'xyc') {
  const store = createStore(pool, profile.id), created = await store.create(owner, randomUUID(), { title: 'Reviewable compilation', kind: 'maker' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    allocations: { baseAtomic: '1000000000000000000', quoteAtomic: '2500000000' },
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 86400,
      model: kind === 'xyc' ? { kind } : kind === 'concentrated' ? { kind, minPrice: '2200', maxPrice: '2800' } : { kind, referencePrice: '2500', amplification: '1' },
      guardEnvelope: { maxAmountBasePerSwap: '50000000000000000', maxAmountQuotePerSwap: '125000000', maxPostBalanceBase: '2000000000000000000', maxPostBalanceQuote: '5000000000' },
    },
  } })
  return { ...created, draft }
}

test('owned compiler artifacts for all curves are immutable, deterministic, decoded and deduplicated', async () => {
  const artifacts = createArtifacts(pool, profile)
  for (const kind of ['xyc', 'concentrated', 'pegged'] as const) {
    const { draft } = await maker(kind), input = { draftId: draft.id, expectedRevision: 2 }, key = randomUUID()
    const [first, duplicate, sameContent] = await Promise.all([artifacts.compile(owner, key, input), artifacts.compile(owner, key, input), artifacts.compile(owner, randomUUID(), input)])
    assert.deepEqual(first, duplicate); assert.deepEqual(first, sameContent)
    const saved = await artifacts.get(owner, first.artifactId)
    assert.equal(saved.current, true); assert.equal(saved.registrationReady, false)
    assert.deepEqual(saved.payload.decoded, decodeGuardedOrder(saved.payload.strategy))
    assert.equal(saved.payload.decoded.kind, kind); assert.equal(saved.payload.decoded.maker, owner.slice(7))
    assert.equal(saved.payload.decoded.guard, profile.guard)
    assert.deepEqual(saved.payload.decoded.guardEnvelope, draft.spec.guardEnvelope)
    assert.deepEqual(saved, JSON.parse(JSON.stringify(saved)))
    assert.equal((await artifacts.list(owner, draft.id)).length, 1)
    assert.equal((await pool.query("SELECT id FROM builder.outbox WHERE resource_id=$1 AND kind='artifact.compiled'", [first.artifactId])).rowCount, 1)
    await assert.rejects(pool.query('UPDATE builder.compiled_artifacts SET revision=3 WHERE id=$1', [first.artifactId]), /immutable/)
    await assert.rejects(artifacts.get(other, first.artifactId), /not-found/)
    await assert.rejects(artifacts.list(other, draft.id), /not-found/)
    await assert.rejects(artifacts.compile(other, randomUUID(), input), /not-found/)
    await assert.rejects(artifacts.compile(owner, key, { ...input, expectedRevision: 3 }), /idempotency-key-reused/)
  }
})

test('edits, restored revisions and manifest changes never reuse an obsolete compilation as current', async () => {
  const store = createStore(pool, profile.id), artifacts = createArtifacts(pool, profile), { draft } = await maker()
  const key = randomUUID(), input = { draftId: draft.id, expectedRevision: 2 }, original = await artifacts.compile(owner, key, input)
  await store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, patch: { spec: { title: 'New version' } } })
  assert.equal((await artifacts.get(owner, original.artifactId)).current, false)
  assert.deepEqual(await artifacts.compile(owner, key, input), original, 'a retried receipt keeps its original revision')
  await assert.rejects(artifacts.compile(owner, randomUUID(), input), /draft-changed/)
  await store.restore(owner, randomUUID(), { draftId: draft.id, expectedRevision: 3, revision: 2 })
  const restored = await artifacts.compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: 4 })
  assert.notEqual(restored.artifactId, original.artifactId)
  assert.equal((await artifacts.get(owner, original.artifactId)).current, false)
  const latest = await artifacts.get(owner, restored.artifactId)
  assert.equal(latest.current, true)
  assert.equal(latest.payload.strategy, (await artifacts.get(owner, original.artifactId)).payload.strategy)
  assert.equal((await createArtifacts(pool, { ...profile, forwarder: '0x2222222222222222222222222222222222222222' }).get(owner, restored.artifactId)).current, false)
})

test('template, incomplete inputs and cancelled model authority cannot create executable artifacts', async () => {
  const store = createStore(pool, profile.id), artifacts = createArtifacts(pool, profile), turns = createTurns(pool)
  const template = await store.create(owner, randomUUID(), { title: 'Provider template', kind: 'template' })
  await assert.rejects(artifacts.compile(owner, randomUUID(), { draftId: template.draft.id, expectedRevision: 1 }), /maker-instance-required/)
  const partial = await store.create(owner, randomUUID(), { title: 'Incremental decisions', kind: 'maker' })
  await store.patch(owner, randomUUID(), { draftId: partial.draft.id, expectedRevision: 1, patch: { spec: { guardEnvelope: { maxAmountBasePerSwap: '1' } } } })
  await assert.rejects(artifacts.compile(owner, randomUUID(), { draftId: partial.draft.id, expectedRevision: 2 }), /incomplete-or-invalid/)
  const { draft, conversationId } = await maker()
  const turn = await turns.accept(owner, randomUUID(), { conversationId, content: 'Compile strategy', expectedRevision: 2 }), lease = (await turns.claim())!
  await turns.cancel(owner, turn.id)
  await assert.rejects(createArtifacts(pool, profile, lease).compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2 }), /agent-turn-stale/)
  assert.equal((await artifacts.list(owner, draft.id)).length, 0)
  await assert.rejects(artifacts.compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, calldata: '0x' }))
})

test('the durable AI SDK worker compiles through its scoped tool and records actual artifact evidence', async () => {
  const { draft, conversationId } = await maker('concentrated'), turns = createTurns(pool)
  const turn = await turns.accept(owner, randomUUID(), { conversationId, expectedRevision: 2, content: 'Compile the current Maker draft without trading.' })
  let step = 0
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] })
    if (step === 0) c.enqueue({ type: 'tool-call', toolCallId: 'inspect', toolName: 'inspectStrategy', input: JSON.stringify({ view: 'current' }) })
    else if (step === 1) c.enqueue({ type: 'tool-call', toolCallId: 'compile', toolName: 'compileStrategy', input: JSON.stringify({ expectedRevision: 2 }) })
    else {
      c.enqueue({ type: 'text-start', id: 'reply' }); c.enqueue({ type: 'text-delta', id: 'reply', delta: 'Compilation saved; no simulation or transaction has occurred.' }); c.enqueue({ type: 'text-end', id: 'reply' })
    }
    c.enqueue({ type: 'finish', finishReason: { unified: step++ < 2 ? 'tool-calls' : 'stop', raw: undefined }, usage }); c.close()
  } }) }) })
  assert.deepEqual(await runDesignTurn(pool, profile, model, (await turns.claim())!), { state: 'succeeded' })
  const artifacts = createArtifacts(pool, profile), rows = await artifacts.list(owner, draft.id)
  assert.equal(rows.length, 1); assert.equal((await artifacts.get(owner, rows[0]!.artifactId)).current, true)
  assert.ok((await turns.events(owner, turn.id)).some(e => e.kind === 'tool' && e.payload.name === 'compileStrategy' && e.payload.ok))
})
