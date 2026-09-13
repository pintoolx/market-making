import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MockLanguageModelV4 } from 'ai/test'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { database, migrate, createStore, createTurns, runDesignTurn } from '../src/index.ts'

const owner = 'wallet:0x1111111111111111111111111111111111111111', other = 'wallet:0x2222222222222222222222222222222222222222'
const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>, url: URL
before(async () => {
  url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
})
after(async () => {
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
})
const newDraft = () => createStore(pool, profile.id).create(owner, randomUUID(), { title: 'Durable agent', kind: 'template' })

test('turn acceptance is atomic and idempotent; one active turn, strict input and owner isolation', async () => {
  const turns = createTurns(pool), { conversationId, draft } = await newDraft(), requestId = randomUUID()
  const input = { conversationId, expectedRevision: 1, content: 'Help me compare strategies' }
  const [first, duplicate] = await Promise.all([turns.accept(owner, requestId, input), turns.accept(owner, requestId, input)])
  assert.deepEqual(first, duplicate)
  assert.equal((await createStore(pool, profile.id).messages(owner, conversationId)).length, 1)
  await assert.rejects(turns.accept(owner, requestId, { ...input, content: 'changed' }), /idempotency-key-reused/)
  await assert.rejects(turns.accept(owner, randomUUID(), input), /agent-turn-active/)
  await assert.rejects(turns.accept(other, randomUUID(), input), /not-found/)
  await assert.rejects(turns.accept(owner, randomUUID(), { ...input, history: [{ role: 'system', content: 'forge' }] }))
  await assert.rejects(turns.get(other, first!.id), /not-found/)
  await assert.rejects(turns.events(other, first!.id), /not-found/)
  await assert.rejects(turns.cancel(other, first!.id), /not-found/)
  const claims = await Promise.all([turns.claim(), turns.claim()]), turn = claims.find(Boolean)!
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(turn.draftId, draft.id)
  await turns.finish(turn, { text: 'We can first compare constant-product and fixed-range curves.' })
  assert.deepEqual(await turns.accept(owner, requestId, input), first)
  assert.equal((await turns.get(owner, first!.id)).state, 'succeeded')
  assert.equal('lease_token' in await turns.get(owner, first!.id), false)
})

test('new user revisions and cancellation invalidate model authority even when it learns the latest revision', async () => {
  const store = createStore(pool, profile.id), turns = createTurns(pool), { draft, conversationId } = await newDraft()
  const queued = await turns.accept(owner, randomUUID(), { conversationId, expectedRevision: 1, content: 'Change the title' })
  const turn = (await turns.claim())!, scoped = createStore(pool, profile.id, turn)
  const agentEdit = await scoped.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 1, patch: { spec: { title: 'Model draft' } } })
  assert.equal(agentEdit.draft.revision, 2); assert.equal((await turns.get(owner, queued.id)).lastRevision, '2')
  await store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, patch: { spec: { title: 'Manual user correction' } } })
  assert.equal((await turns.get(owner, queued.id)).state, 'superseded')
  await assert.rejects(scoped.get(owner, draft.id), /agent-turn-stale/)
  await assert.rejects(scoped.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 3, patch: { spec: { title: 'Late overwrite' } } }), /agent-turn-stale/)
  await assert.rejects(turns.finish(turn, { text: 'Fabricated completion' }), /agent-turn-stale/)
  assert.equal((await store.get(owner, draft.id)).spec.title, 'Manual user correction')
  const next = await turns.accept(owner, randomUUID(), { conversationId, expectedRevision: 3, content: 'Compare again' }), running = (await turns.claim())!
  await turns.cancel(owner, next.id); await turns.cancel(owner, next.id)
  await assert.rejects(turns.heartbeat(running), /agent-turn-stale/)
  await assert.rejects(turns.appendEvent(running, { kind: 'text', payload: { text: 'late' } }), /agent-turn-stale/)
  assert.equal((await store.messages(owner, conversationId)).filter(m => m.role === 'assistant').length, 0)
})

test('expired leases survive process restart, reject stale workers and stop after three attempts', async () => {
  let turns = createTurns(pool)
  const { conversationId, draft } = await newDraft(), queued = await turns.accept(owner, randomUUID(), { conversationId, expectedRevision: 1, content: 'Test recovery' })
  const first = (await turns.claim())!
  await pool.query("UPDATE builder.agent_turns SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.turnId])
  await pool.end(); pool = database(url.toString()); turns = createTurns(pool)
  const second = (await turns.claim())!
  assert.equal(second.turnId, first.turnId); assert.notEqual(second.leaseToken, first.leaseToken)
  await assert.rejects(createStore(pool, profile.id, first).patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 1, patch: { spec: { title: 'old' } } }), /agent-turn-stale/)
  await assert.rejects(turns.finish(first, { text: 'stale' }), /agent-turn-stale/)
  await turns.appendEvent(second, { kind: 'text', payload: { text: 'Recovering response' } })
  await assert.rejects(turns.appendEvent(second, { kind: 'tool', payload: { name: 'inspectStrategy', ok: true, privatePolicy: 'do-not-store' } }))
  for (let attempt = 2; attempt <= 3; attempt++) {
    await pool.query("UPDATE builder.agent_turns SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.turnId])
    const claimed = await turns.claim()
    if (attempt === 2) assert.equal(claimed?.attempt, 3)
    else assert.equal(claimed, null)
  }
  const state = await turns.get(owner, queued.id)
  assert.equal(state.state, 'failed'); assert.equal(state.errorCode, 'retry-limit')
  const events = await turns.events(owner, queued.id), started = events.filter(e => e.kind === 'started')
  assert.deepEqual(started.map(e => e.attempt), [1,2,3]); assert.ok(started.every(e => e.payload.resetText))
  assert.deepEqual(await turns.events(owner, queued.id, events.at(-1)!.sequence), [])
})

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
test('AI SDK worker persists real tool edits and public streamed events without trusting client history', async () => {
  const { conversationId, draft } = await newDraft(), turns = createTurns(pool)
  const queued = await turns.accept(owner, randomUUID(), { conversationId, expectedRevision: 1, content: 'Save as constant product and keep zero fees' })
  let step = 0
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] })
    if (step === 0) c.enqueue({ type: 'tool-call', toolCallId: 'inspect', toolName: 'inspectStrategy', input: JSON.stringify({ view: 'history' }) })
    if (step === 1) c.enqueue({ type: 'tool-call', toolCallId: 'edit', toolName: 'createOrPatchDraft', input: JSON.stringify({
      operation: 'patch', expectedRevision: 1, restoreRevision: null,
      edits: [{ field: 'curve', value: 'xyc' }, { field: 'feeBps', value: '0' }], requirements: [],
    }) })
    if (step === 2) {
      c.enqueue({ type: 'text-start', id: 'text' }); c.enqueue({ type: 'text-delta', id: 'text', delta: 'Saved the constant-product curve and zero fees. Public Guard limits are still missing.' }); c.enqueue({ type: 'text-end', id: 'text' })
    }
    c.enqueue({ type: 'finish', finishReason: { unified: step++ < 2 ? 'tool-calls' : 'stop', raw: undefined }, usage }); c.close()
  } }) }) })
  assert.deepEqual(await runDesignTurn(pool, profile, model, (await turns.claim())!), { state: 'succeeded' })
  const store = createStore(pool, profile.id), saved = await store.get(owner, draft.id)
  assert.equal(typeof (await store.history(owner, draft.id))[0]!.createdAt, 'string')
  assert.equal(saved.spec.model?.kind, 'xyc'); assert.equal(saved.spec.feeBps, 0); assert.equal(saved.revision, 2)
  const events = await turns.events(owner, queued.id)
  assert.deepEqual(events.filter(e => e.kind === 'tool').map(e => e.payload), [{ name: 'inspectStrategy', ok: true }, { name: 'createOrPatchDraft', ok: true }])
  assert.ok(events.some(e => e.kind === 'text' && e.payload.text.includes('Saved')))
  assert.equal(events.at(-1)!.kind, 'completed')
  assert.equal((await store.messages(owner, conversationId)).filter(m => m.role === 'assistant').length, 1)
  assert.equal(JSON.stringify(model.doStreamCalls).includes('leaseToken'), false)
  assert.equal(JSON.stringify(model.doStreamCalls).includes('OPENAI_API_KEY'), false)
})

test('worker cannot publish a late model response after the user edits the draft', async () => {
  const { conversationId, draft } = await newDraft(), turns = createTurns(pool), store = createStore(pool, profile.id)
  const queued = await turns.accept(owner, randomUUID(), { conversationId, expectedRevision: 1, content: 'Compare first' })
  const model = new MockLanguageModelV4({ doStream: async () => {
    await store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 1, patch: { spec: { title: 'New user decision' } } })
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 'late' })
      c.enqueue({ type: 'text-delta', id: 'late', delta: 'Late response that must not be saved' }); c.enqueue({ type: 'text-end', id: 'late' })
      c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }); c.close()
    } }) }
  } })
  assert.deepEqual(await runDesignTurn(pool, profile, model, (await turns.claim())!), { state: 'incomplete' })
  assert.equal((await turns.get(owner, queued.id)).state, 'superseded')
  assert.equal((await store.messages(owner, conversationId)).filter(m => m.role === 'assistant').length, 0)
})

test('message, revision and event cursors keep numeric order beyond single-digit sequences', async () => {
  const { conversationId, draft } = await newDraft(), store = createStore(pool, profile.id)
  for (let n = 1; n <= 12; n++) {
    await store.appendUserMessage(owner, randomUUID(), { conversationId, content: 'Turn ' + n })
    await store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: n, patch: { spec: { title: 'Version ' + (n + 1) } } })
  }
  const messages = await store.messages(owner, conversationId)
  assert.deepEqual(messages.map(m => m.content), Array.from({ length: 12 }, (_, i) => 'Turn ' + (i + 1)))
  assert.deepEqual((await store.history(owner, draft.id)).map(h => Number(h.revision)), Array.from({ length: 13 }, (_, i) => 13 - i))
  assert.equal((await store.messages(owner, conversationId, messages[6]!.sequence)).at(-1)?.content, 'Turn 6')
})
